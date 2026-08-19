import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentAdapter } from '../adapter.js';
import { token } from '../../core/ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_BIN = path.join(__dirname, '..', '..', '..', 'bin', 'collagent-hook.js');
const STATUSLINE_BIN = path.join(__dirname, '..', '..', '..', 'bin', 'collagent-statusline.js');

/**
 * Multiplayer around the real interactive Claude Code UI, via documented
 * surfaces only: PTY passthrough, a --settings hooks overlay POSTing to a
 * loopback receiver, remote instructions typed visibly into the composer,
 * and transcript tailing for assistant prose (hooks never carry it).
 * Options: cwd, model, claudePath, extraArgs, onExit(code)
 */
export class ClaudeNativeAdapter extends AgentAdapter {
  constructor(options = {}) {
    super(options);
    this.pty = null;
    this.receiver = null;
    this.settingsFile = null;
    this.paused = false;
    this.queue = [];
    this.stopping = false;
    this.sessionStarted = false; // set once the SessionStart hook fires
    this._recentInjections = [];
    this._stdinHandler = null;
    this._resizeHandler = null;
    this._transcript = null; // { path, offset } — tail state for agent prose
  }

  get info() {
    return {
      type: 'claude-native',
      ui: 'interactive claude code (PTY passthrough)',
      cwd: this.options.cwd || process.cwd(),
    };
  }

  async createSession() {
    const { default: pty } = await import('node-pty').then((m) => ({ default: m })).catch(() => ({ default: null }));
    if (!pty) {
      throw new Error(
        'node-pty is not available (native build missing). Run scripts/setup.sh, ' +
        'or use headless mode: collagent create --adapter claude-code',
      );
    }

    const hookUrl = await this._startHookReceiver();
    this.settingsFile = this._writeHookSettings(hookUrl);

    const {
      cwd = process.cwd(),
      model,
      claudePath = 'claude',
      extraArgs = [],
    } = this.options;

    const args = [
      '--settings', this.settingsFile,
      ...(model ? ['--model', model] : []),
      ...extraArgs,
    ];

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_CHILD_SESSION; // inherited marker disables transcript saving

    this.pty = pty.spawn(claudePath, args, {
      name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 32,
      cwd,
      env,
    });

    this.pty.onData((data) => process.stdout.write(data));

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    this._stdinHandler = (data) => this.pty?.write(data.toString('latin1'));
    process.stdin.on('data', this._stdinHandler);

    this._resizeHandler = () => {
      try {
        this.pty?.resize(process.stdout.columns || 120, process.stdout.rows || 32);
      } catch { /* ignore */ }
    };
    process.stdout.on('resize', this._resizeHandler);

    this.pty.onExit(({ exitCode }) => {
      this._restoreTerminal();
      if (!this.stopping) {
        this.emit({ kind: 'agent_status', status: 'exited', detail: { code: exitCode } });
      }
      this.options.onExit?.(exitCode);
    });

    // Fallback: if hooks never report SessionStart (e.g. hooks disabled),
    // still allow remote instructions after a generous startup window.
    this._startupFallback = setTimeout(() => this._markSessionStarted(), 20_000);

    this.emit({ kind: 'agent_status', status: 'ready', detail: this.info });
    return this.info;
  }

  /** Loopback HTTP receiver the hook forwarder POSTs to. */
  _startHookReceiver() {
    const secret = token();
    this.receiver = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== `/hook/${secret}`) {
        res.writeHead(404);
        return res.end();
      }
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        res.writeHead(200);
        res.end();
        try {
          this._onHook(JSON.parse(body));
        } catch { /* malformed hook payload — ignore */ }
      });
    });
    return new Promise((resolve) => {
      this.receiver.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${this.receiver.address().port}/hook/${secret}`);
      });
    });
  }

  _writeHookSettings(hookUrl) {
    const cmd = `"${process.execPath}" "${HOOK_BIN}" "${hookUrl}"`;
    const entry = [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }];
    const withMatcher = [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 5 }] }];
    const settings = {
      hooks: {
        SessionStart: entry,
        UserPromptSubmit: entry,
        PreToolUse: withMatcher,
        PostToolUse: withMatcher,
        Notification: entry,
        Stop: entry,
        SessionEnd: entry,
      },
    };
    // Room code + presence live in Claude Code's status line; refreshInterval
    // matters because joins/leaves happen without conversation activity.
    if (this.options.statusUrl && this.options.sessionCode) {
      settings.statusLine = {
        type: 'command',
        command: `"${process.execPath}" "${STATUSLINE_BIN}" "${this.options.statusUrl}" "${this.options.sessionCode}"`,
        padding: 0,
        refreshInterval: 2,
      };
    }
    const file = path.join(os.tmpdir(), `collagent-hooks-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(settings));
    return file;
  }

  _onHook(payload) {
    if (payload.hook_event_name === 'SessionStart') this._markSessionStarted();
    // Claude Code appends the turn's final assistant line ~100-200ms AFTER the
    // Stop hook fires (verified live), so hold the result briefly, flush, emit,
    // then sweep once more for stragglers.
    if (payload.hook_event_name === 'Stop' || payload.hook_event_name === 'SessionEnd') {
      setTimeout(() => {
        this._flushTranscript(payload.transcript_path);
        for (const event of translateHookEvent(payload)) this.emit(event);
        setTimeout(() => this._flushTranscript(payload.transcript_path), 2000);
      }, 600);
      return;
    }
    this._flushTranscript(payload.transcript_path);
    for (const event of translateHookEvent(payload)) {
      // an injected instruction echoes back as UserPromptSubmit — don't show it twice
      if (event.kind === 'local_prompt' && this._wasInjected(event.text)) continue;
      this.emit(event);
    }
  }

  // Mirror transcript additions (assistant prose, session title) since the
  // last flush. First sighting records the file size so a resumed
  // conversation's history is never re-broadcast.
  _flushTranscript(path) {
    if (!path) return;
    try {
      const size = fs.existsSync(path) ? fs.statSync(path).size : 0;
      if (!this._transcript || this._transcript.path !== path) {
        this._transcript = { path, offset: size };
        return;
      }
      if (size <= this._transcript.offset) return;

      const buf = Buffer.alloc(size - this._transcript.offset);
      const fd = fs.openSync(path, 'r');
      try {
        fs.readSync(fd, buf, 0, buf.length, this._transcript.offset);
      } finally {
        fs.closeSync(fd);
      }
      // consume only complete lines; a line mid-write waits for the next flush
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline < 0) return;
      this._transcript.offset += lastNewline + 1;

      const { texts, title } = extractTranscriptUpdates(buf.subarray(0, lastNewline).toString('utf8'));
      for (const text of texts) this.emit({ kind: 'agent_message', text });
      if (title && title !== this._sessionTitle) {
        this._sessionTitle = title;
        this.emit({ kind: 'session_title', title });
      }
    } catch { /* observability must never break the agent */ }
  }

  _markSessionStarted() {
    if (this.sessionStarted) return;
    this.sessionStarted = true;
    if (!this.paused) {
      const held = this.queue.splice(0);
      // settle delay: the composer isn't focused immediately after startup screens
      setTimeout(() => {
        for (const instruction of held) this._inject(instruction);
      }, 750);
    }
  }

  async sendInstruction({ text, from }) {
    // before SessionStart, the trust dialog / startup screens would swallow the paste
    if (this.paused || !this.sessionStarted) {
      this.queue.push({ text, from });
      return { queued: true };
    }
    return this._inject({ text, from });
  }

  _inject({ text, from }) {
    const speaker = from?.name ? `[${from.name}] ` : '';
    const line = `${speaker}${text}`;
    // Record before writing so the UserPromptSubmit echo is always recognized.
    this._recentInjections.push({ text: line, ts: Date.now() });
    if (this._recentInjections.length > 20) this._recentInjections.shift();
    if (!this.pty) return { queued: false };
    this.pty.write(`\x1b[200~${line}\x1b[201~`);
    setTimeout(() => this.pty?.write('\r'), 150);
    this.emit({ kind: 'agent_status', status: 'working' });
    return { queued: false };
  }

  _wasInjected(text) {
    const now = Date.now();
    this._recentInjections = this._recentInjections.filter((e) => now - e.ts < 30_000);
    return this._recentInjections.some((e) => e.text.trim() === String(text).trim());
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
    if (!this.sessionStarted) return; // queue flushes on session start
    const held = this.queue.splice(0);
    for (const instruction of held) this._inject(instruction);
  }

  async handoff(info) {
    this.lastHandoff = info;
  }

  _restoreTerminal() {
    if (this._stdinHandler) {
      process.stdin.off('data', this._stdinHandler);
      this._stdinHandler = null;
    }
    if (this._resizeHandler) {
      process.stdout.off('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    process.stdin.pause();
    process.stdout.write('\x1b[?25h'); // ensure cursor is visible
  }

  async disconnect() {
    this.stopping = true;
    clearTimeout(this._startupFallback);
    this._restoreTerminal();
    try { this.pty?.kill(); } catch { /* ignore */ }
    this.pty = null;
    this.receiver?.close();
    this.receiver = null;
    if (this.settingsFile) {
      try { fs.unlinkSync(this.settingsFile); } catch { /* ignore */ }
      this.settingsFile = null;
    }
  }
}

/**
 * Translate a Claude Code hook payload into normalized Collagent events.
 * Exported for tests.
 */
export function translateHookEvent(payload = {}) {
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return [{
        kind: 'agent_status',
        status: 'ready',
        detail: { sessionId: payload.session_id, cwd: payload.cwd, source: payload.source },
      }];
    case 'UserPromptSubmit':
      return [{ kind: 'local_prompt', text: payload.prompt ?? '' }];
    case 'PreToolUse':
      return [{ kind: 'tool_use', tool: payload.tool_name, input: compact(payload.tool_input) }];
    case 'PostToolUse':
      return [{ kind: 'tool_result', tool: payload.tool_name, summary: compact(payload.tool_response, 200) }];
    case 'Stop':
      return [
        { kind: 'result', ok: true },
        { kind: 'agent_status', status: 'idle' },
      ];
    case 'Notification':
      return [{ kind: 'notice', message: payload.message ?? 'Claude Code needs attention' }];
    case 'SessionEnd':
      return [{ kind: 'agent_status', status: 'exited', detail: { reason: payload.reason } }];
    default:
      return [];
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

/**
 * Assistant prose + session title from a chunk of transcript JSONL. Text
 * blocks only: tools are reported by hooks, thinking stays private, and
 * sidechains are subagent-internal. Exported for tests.
 */
export function extractTranscriptUpdates(jsonl) {
  const texts = [];
  let title = null;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'ai-title' && entry.aiTitle?.trim()) {
      title = entry.aiTitle.trim();
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    for (const block of entry.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) texts.push(block.text);
    }
  }
  return { texts, title };
}
