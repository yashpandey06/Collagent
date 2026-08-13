import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AgentAdapter } from './adapter.js';
import { uuid } from '../core/ids.js';

/**
 * ClaudeCodeAdapter — drives a real Claude Code agent through its supported
 * headless interface:
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *
 * The process stays alive across turns: user messages are written to stdin as
 * JSON lines, and Claude Code streams its activity (assistant messages, tool
 * use, tool results, turn results) back as JSON lines on stdout. Claude Code
 * remains fully responsible for execution, files, terminal and permissions —
 * this adapter only translates between Collagent's normalized events and
 * Claude Code's stream-json protocol.
 *
 * Options:
 *   cwd             working directory for the agent (default: process.cwd())
 *   model           model override, passed through to claude
 *   permissionMode  claude permission mode (default: "acceptEdits")
 *   claudePath      path to the claude binary (default: "claude")
 *   extraArgs       extra CLI args (array)
 */
export class ClaudeCodeAdapter extends AgentAdapter {
  constructor(options = {}) {
    super(options);
    this.proc = null;
    this.sessionId = options.sessionId || uuid();
    this.paused = false;
    this.queue = []; // instructions held while paused
    this.busy = false;
    this.stopping = false;
  }

  get info() {
    return {
      type: 'claude-code',
      sessionId: this.sessionId,
      cwd: this.options.cwd || process.cwd(),
      permissionMode: this.options.permissionMode || 'acceptEdits',
    };
  }

  async createSession() {
    this._spawn({ resume: Boolean(this.options.resume && this.options.sessionId) });
    this.emit({ kind: 'agent_status', status: 'starting', detail: this.info });
    return this.info;
  }

  _spawn({ resume }) {
    const {
      cwd = process.cwd(),
      model,
      permissionMode = 'acceptEdits',
      claudePath = 'claude',
      extraArgs = [],
    } = this.options;

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', permissionMode,
      resume ? '--resume' : '--session-id', this.sessionId,
      ...(model ? ['--model', model] : []),
      ...extraArgs,
    ];

    // Strip nesting markers so a Collagent session launched from inside
    // another Claude Code session still gets a clean child process.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_CHILD_SESSION; // inherited marker disables transcript saving

    this.proc = spawn(claudePath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

    // In stream-json mode Claude Code emits nothing (not even its init
    // message) until the first user message arrives, so "the process is up"
    // is our readiness signal. The real init later refreshes agent details.
    this.proc.once('spawn', () => {
      if (!this.ready) {
        this.ready = true;
        this.emit({ kind: 'agent_status', status: 'ready', detail: this.info });
      }
    });

    const stdout = createInterface({ input: this.proc.stdout });
    stdout.on('line', (line) => this._onLine(line));

    let stderrBuf = '';
    this.proc.stderr.on('data', (d) => {
      stderrBuf = (stderrBuf + d.toString()).slice(-4000);
    });

    this.proc.on('error', (err) => {
      this.emit({ kind: 'error', message: `failed to start claude: ${err.message}` });
      this.emit({ kind: 'agent_status', status: 'error', detail: { message: err.message } });
    });

    this.proc.on('exit', (code) => {
      if (this.stopping) return;
      this.emit({
        kind: 'agent_status',
        status: 'exited',
        detail: { code, stderr: stderrBuf.trim().slice(-500) || undefined },
      });
    });
  }

  _onLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore non-JSON noise
    }
    for (const event of normalizeClaudeMessage(msg)) {
      if (event.kind === 'result') this.busy = false;
      if (event.kind === 'agent_status' && event.status === 'ready') this.ready = true;
      this.emit(event);
      // init arrives mid-turn on the first instruction; don't let its
      // "ready" flip the session out of "working" while a turn is running.
      if (event.kind === 'agent_status' && event.status === 'ready' && this.busy) {
        this.emit({ kind: 'agent_status', status: 'working' });
      }
    }
  }

  async sendInstruction({ text, from }) {
    if (this.paused) {
      this.queue.push({ text, from });
      return { queued: true };
    }
    return this._write({ text, from });
  }

  _write({ text, from }) {
    if (!this.proc || this.proc.exitCode !== null) {
      // Process died — restart it, resuming the same Claude Code session so
      // conversation context is preserved.
      this._spawn({ resume: true });
      this.emit({ kind: 'agent_status', status: 'starting', detail: { resumed: true } });
    }
    // Tag the speaker so the shared agent knows who is talking to it.
    const speaker = from?.name ? `[${from.name}] ` : '';
    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `${speaker}${text}` }] },
    };
    this.busy = true;
    this.emit({ kind: 'agent_status', status: 'working' });
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
    return { queued: false };
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
    const held = this.queue.splice(0);
    for (const instruction of held) this._write(instruction);
  }

  async handoff(info) {
    // Purely informational for the agent; delivered as a lightweight note on
    // the next instruction rather than consuming a turn. No-op for now.
    this.lastHandoff = info;
  }

  async disconnect() {
    this.stopping = true;
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch { /* ignore */ }
    const proc = this.proc;
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        resolve();
      }, 1500);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
  }
}

/**
 * Translate one Claude Code stream-json message into zero or more
 * normalized Collagent events. Exported for tests.
 */
export function normalizeClaudeMessage(msg) {
  const events = [];
  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        events.push({
          kind: 'agent_status',
          status: 'ready',
          detail: {
            model: msg.model,
            cwd: msg.cwd,
            sessionId: msg.session_id,
            tools: Array.isArray(msg.tools) ? msg.tools.length : undefined,
          },
        });
      }
      break;
    }
    case 'assistant': {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          events.push({ kind: 'agent_message', text: block.text });
        } else if (block.type === 'tool_use') {
          events.push({ kind: 'tool_use', tool: block.name, input: summarizeInput(block.input) });
        }
      }
      break;
    }
    case 'user': {
      // Tool results are echoed back as user messages in the stream.
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_result') {
          events.push({
            kind: 'tool_result',
            summary: summarizeToolResult(block.content),
            isError: Boolean(block.is_error),
          });
        }
      }
      break;
    }
    case 'result': {
      events.push({
        kind: 'result',
        ok: msg.subtype === 'success',
        text: typeof msg.result === 'string' ? msg.result : undefined,
        durationMs: msg.duration_ms,
        costUsd: msg.total_cost_usd,
        turns: msg.num_turns,
      });
      events.push({ kind: 'agent_status', status: 'idle' });
      break;
    }
    default:
      break;
  }
  return events;
}

function summarizeInput(input) {
  try {
    const s = JSON.stringify(input);
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  } catch {
    return String(input);
  }
}

function summarizeToolResult(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
  } else text = JSON.stringify(content ?? '');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}
