import net from 'node:net';
import { AgentAdapter } from '../adapter.js';
import { formatInstructionLine, isSlashCommand } from '../instruction-format.js';
import { capture } from '../capture.js';

/**
 * Multiplayer around the real interactive OpenCode TUI. OpenCode is
 * client/server: the TUI hosts an HTTP server, so the adapter launches it on
 * a fixed port and works through OpenCode's own API — SSE /event for
 * observation, /tui/append-prompt + /tui/submit-prompt to type remote
 * instructions visibly into the composer. No hook files, nothing on disk.
 * Options: cwd, opencodePath, extraArgs, sessionId+resume, onExit(code)
 */
export class OpencodeNativeAdapter extends AgentAdapter {
  constructor(options = {}) {
    super(options);
    this.pty = null;
    this.base = null;
    this.paused = false;
    this.queue = [];
    this.stopping = false;
    this.sessionStarted = false;
    this._recentInjections = [];
    this._stdinHandler = null;
    this._resizeHandler = null;
    this._sse = null; // AbortController
    this._state = newTranslationState();
  }

  get info() {
    return {
      type: 'opencode-native',
      ui: 'interactive opencode tui (PTY passthrough)',
      cwd: this.options.cwd || process.cwd(),
      sessionId: this._state.sessionId ?? this.options.sessionId ?? undefined,
    };
  }

  async createSession() {
    const { default: pty } = await import('node-pty')
      .then((m) => ({ default: m }))
      .catch(() => ({ default: null }));
    if (!pty) {
      throw new Error(
        'node-pty is not available (native build missing). Run scripts/setup.sh, ' +
        'or use headless mode: collagent create --adapter opencode',
      );
    }

    const {
      cwd = process.cwd(),
      opencodePath = 'opencode',
      extraArgs = [],
    } = this.options;

    const port = await freePort();
    this.base = `http://127.0.0.1:${port}`;

    this.pty = pty.spawn(opencodePath, ['--port', String(port), ...extraArgs], {
      name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 32,
      cwd,
      env: process.env,
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

    this._connectWhenHealthy();
    this.emit({ kind: 'agent_status', status: 'ready', detail: this.info });
    return this.info;
  }

  // Poll the TUI's embedded server; once it answers, resume the stored
  // session if asked, open the event stream, and flush queued instructions.
  async _connectWhenHealthy() {
    for (let i = 0; i < 100 && !this.stopping; i++) {
      try {
        const res = await fetch(`${this.base}/global/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          if (this.options.resume && this.options.sessionId) {
            await this._post('/tui/select-session', { sessionID: this.options.sessionId })
              .catch(() => { /* older servers may not support it */ });
          }
          this._listen();
          this._markSessionStarted();
          return;
        }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!this.stopping) this._markSessionStarted(); // inject blind rather than hang
  }

  async _listen() {
    this._sse = new AbortController();
    try {
      const res = await fetch(`${this.base}/event`, { signal: this._sse.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n');
        buf = frames.pop();
        for (const frame of frames) {
          if (!frame.startsWith('data: ')) continue;
          let evt;
          try {
            evt = JSON.parse(frame.slice(6));
          } catch {
            continue;
          }
          for (const event of translateOpencodeEvent(evt, this._state)) {
            if (event.kind === 'local_prompt' && this._wasInjected(event.text)) continue;
            this.emit(event);
          }
        }
      }
    } catch {
      /* stream ends when the TUI exits or we disconnect */
    }
  }

  _markSessionStarted() {
    if (this.sessionStarted) return;
    this.sessionStarted = true;
    if (this.paused) return;
    const held = this.queue.splice(0);
    setTimeout(() => {
      for (const instruction of held) this._inject(instruction);
    }, 750);
  }

  async sendInstruction({ text, from }) {
    if (this.paused || !this.sessionStarted) {
      this.queue.push({ text, from });
      return { queued: true };
    }
    return this._inject({ text, from });
  }

  async _inject({ text, from }) {
    const line = formatInstructionLine({ text, from });
    this._recentInjections.push({ text: line, ts: Date.now() });
    if (this._recentInjections.length > 20) this._recentInjections.shift();
    try {
      await this._post('/tui/append-prompt', { text: line });
      await this._post('/tui/submit-prompt', {});
      // Slash commands drive the TUI's own UI, not a turn — no "working".
      if (!isSlashCommand(text)) this.emit({ kind: 'agent_status', status: 'working' });
    } catch (err) {
      this.emit({ kind: 'error', message: `could not reach opencode's composer: ${err.message}` });
    }
    return { queued: false };
  }

  _wasInjected(text) {
    const now = Date.now();
    this._recentInjections = this._recentInjections.filter((e) => now - e.ts < 30_000);
    return this._recentInjections.some((e) => e.text.trim() === String(text).trim());
  }

  async _post(pathname, body) {
    const res = await fetch(`${this.base}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`${pathname} → ${res.status}`);
    return res;
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
    if (!this.sessionStarted) return;
    const held = this.queue.splice(0);
    for (const instruction of held) await this._inject(instruction);
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
    process.stdout.write('\x1b[?25h');
  }

  async disconnect() {
    this.stopping = true;
    this._sse?.abort();
    this._restoreTerminal();
    try { this.pty?.kill(); } catch { /* ignore */ }
    this.pty = null;
  }
}

export function newTranslationState() {
  return {
    sessionId: null,
    title: null,
    roles: new Map(), // messageID -> role
    parts: new Map(), // partID -> latest text (assistant prose, this turn)
    order: [], // partIDs in arrival order
    seenUserParts: new Set(),
    tools: new Map(), // partID -> reported status
  };
}

/**
 * One SSE bus event → zero or more normalized events. Assistant text parts
 * accumulate (updates replace by part id) and flush as one agent_message when
 * the session goes idle. Pure apart from `state`; exported for tests.
 */
export function translateOpencodeEvent(evt = {}, state = newTranslationState()) {
  const p = evt.properties ?? {};
  const events = [];

  switch (evt.type) {
    case 'session.created':
    case 'session.updated': {
      const info = p.info ?? {};
      const id = p.sessionID ?? info.id;
      if (id && !state.sessionId) {
        state.sessionId = id;
        events.push({ kind: 'agent_status', status: 'ready', detail: { sessionId: id, cwd: info.directory } });
      }
      if (info.title && info.title !== state.title) {
        state.title = info.title;
        events.push({ kind: 'session_title', title: info.title });
      }
      break;
    }

    case 'message.updated': {
      const info = p.info ?? {};
      if (info.id && info.role) state.roles.set(info.id, info.role);
      break;
    }

    case 'message.part.updated': {
      const part = p.part ?? {};
      const role = state.roles.get(part.messageID);
      if (part.type === 'text') {
        if (role === 'user') {
          if (!state.seenUserParts.has(part.id)) {
            state.seenUserParts.add(part.id);
            events.push({ kind: 'local_prompt', text: part.text ?? '' });
          }
        } else if (part.id) {
          if (!state.parts.has(part.id)) state.order.push(part.id);
          state.parts.set(part.id, part.text ?? '');
        }
      } else if (part.type === 'tool') {
        const status = part.state?.status;
        const seen = state.tools.get(part.id);
        if ((status === 'running' || status === 'pending') && !seen) {
          state.tools.set(part.id, 'started');
          events.push({ kind: 'tool_use', tool: part.tool ?? 'tool', input: compact(part.state?.input) });
        } else if ((status === 'completed' || status === 'error') && seen !== 'done') {
          if (!seen) events.push({ kind: 'tool_use', tool: part.tool ?? 'tool', input: compact(part.state?.input) });
          state.tools.set(part.id, 'done');
          events.push({
            kind: 'tool_result',
            tool: part.tool,
            summary: compact(part.state?.output ?? '', 200),
            isError: status === 'error',
          });
        }
      }
      break;
    }

    case 'session.status': {
      if (p.status?.type === 'busy') events.push({ kind: 'agent_status', status: 'working' });
      break;
    }

    case 'session.idle': {
      const text = state.order.map((id) => state.parts.get(id)).filter(Boolean).join('\n');
      state.parts.clear();
      state.order = [];
      if (text.trim()) events.push({ kind: 'agent_message', text });
      events.push({ kind: 'result', ok: true });
      events.push({ kind: 'agent_status', status: 'idle' });
      break;
    }

    case 'session.error': {
      events.push({ kind: 'error', message: compact(p.error ?? 'opencode error', 200) });
      break;
    }

    case 'permission.asked': {
      events.push({ kind: 'notice', message: 'OpenCode is asking the host for permission' });
      break;
    }

    default:
      break; // heartbeats, file watchers, tui internals
  }
  return events;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Stored payloads stay complete (up to the safety cap); renderers truncate.
const compact = (value) => capture(value);
