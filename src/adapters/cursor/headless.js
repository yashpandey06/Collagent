import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AgentAdapter } from '../adapter.js';

/**
 * Drives the Cursor CLI headless (`agent -p --output-format stream-json`).
 * Cursor's print mode is one-shot, so each instruction spawns one process;
 * turns share one conversation via --resume <session_id>, captured from the
 * first turn's init event. Instructions arriving mid-turn queue until the
 * running turn ends.
 * Options: cwd, model, force (default true), cursorPath, sessionId+resume, extraArgs
 */
export class CursorAgentAdapter extends AgentAdapter {
  constructor(options = {}) {
    super(options);
    this.proc = null;
    this.sessionId = options.sessionId ?? null;
    this.paused = false;
    this.queue = [];
    this.busy = false;
    this.stopping = false;
  }

  get info() {
    return {
      type: 'cursor',
      ui: 'collagent feed (cursor agent print mode)',
      cwd: this.options.cwd || process.cwd(),
      sessionId: this.sessionId ?? undefined,
    };
  }

  async createSession() {
    this.emit({ kind: 'agent_status', status: 'ready', detail: this.info });
    return this.info;
  }

  async sendInstruction({ text, from }) {
    if (this.paused || this.busy) {
      this.queue.push({ text, from });
      return { queued: true };
    }
    return this._runTurn({ text, from });
  }

  _runTurn({ text, from }) {
    const {
      cwd = process.cwd(),
      model,
      force = true,
      cursorPath = 'agent',
      extraArgs = [],
    } = this.options;

    const speaker = from?.name ? `[${from.name}] ` : '';
    const args = [
      '-p', `${speaker}${text}`,
      '--output-format', 'stream-json',
      ...(this.sessionId ? ['--resume', this.sessionId] : []),
      ...(force ? ['--force'] : []),
      ...(model ? ['--model', model] : []),
      ...extraArgs,
    ];

    this.busy = true;
    this.emit({ kind: 'agent_status', status: 'working' });

    this.proc = spawn(cursorPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let sawResult = false;
    let stderrBuf = '';

    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.session_id) this.sessionId = msg.session_id;
      for (const event of normalizeCursorEvent(msg)) {
        if (event.kind === 'result') sawResult = true;
        this.emit(event);
      }
    });

    this.proc.stderr.on('data', (d) => { stderrBuf = (stderrBuf + d).slice(-4000); });

    this.proc.on('error', (err) => {
      const message = err.code === 'ENOENT'
        ? `cursor agent CLI not found (tried "${cursorPath}") — install it: curl https://cursor.com/install -fsS | bash`
        : `failed to start cursor agent: ${err.message}`;
      this.emit({ kind: 'error', message });
      this.emit({ kind: 'agent_status', status: 'error', detail: { message } });
      this._turnDone();
    });

    this.proc.on('exit', (code) => {
      if (!sawResult && !this.stopping) {
        this.emit({
          kind: 'error',
          message: `cursor agent exited without a result (code ${code})${stderrBuf.trim() ? ` — ${stderrBuf.trim().slice(-300)}` : ''}`,
        });
        this.emit({ kind: 'result', ok: false });
        this.emit({ kind: 'agent_status', status: 'idle' });
      }
      this._turnDone();
    });

    return { queued: false };
  }

  _turnDone() {
    this.busy = false;
    this.proc = null;
    if (!this.paused && this.queue.length) this._runTurn(this.queue.shift());
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
    if (!this.busy && this.queue.length) this._runTurn(this.queue.shift());
  }

  async handoff(info) {
    this.lastHandoff = info;
  }

  async disconnect() {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        resolve();
      }, 1500);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
    this.proc = null;
  }
}

/** One Cursor stream-json message → zero or more normalized events. Exported for tests. */
export function normalizeCursorEvent(msg = {}) {
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init'
        ? [{
            kind: 'agent_status',
            status: 'ready',
            detail: { sessionId: msg.session_id, model: msg.model, cwd: msg.cwd },
          }]
        : [];

    case 'assistant': {
      const events = [];
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          events.push({ kind: 'agent_message', text: block.text });
        }
      }
      return events;
    }

    // tool_call payloads are keyed by call type: { readToolCall: { args, result? } }
    case 'tool_call': {
      const [name, call] = Object.entries(msg.tool_call ?? {})[0] ?? ['tool', {}];
      const tool = name.replace(/ToolCall$/, '');
      if (msg.subtype === 'started') {
        return [{ kind: 'tool_use', tool, input: compact(call?.args) }];
      }
      if (msg.subtype === 'completed') {
        const result = call?.result ?? {};
        const isError = 'error' in result || 'failure' in result;
        return [{
          kind: 'tool_result',
          tool,
          summary: compact(result.success ?? result.error ?? result, 200),
          isError,
        }];
      }
      return [];
    }

    case 'result':
      return [
        {
          kind: 'result',
          ok: !msg.is_error && msg.subtype === 'success',
          text: typeof msg.result === 'string' ? msg.result : undefined,
          durationMs: msg.duration_ms,
        },
        { kind: 'agent_status', status: 'idle' },
      ];

    default:
      return []; // 'user' echoes our own prompt back
  }
}

function compact(value, max = 400) {
  let s;
  if (typeof value === 'string') s = value;
  else {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  }
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
