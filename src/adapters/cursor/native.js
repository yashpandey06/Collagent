import { AgentAdapter } from '../adapter.js';
import { CursorChatTail } from './store.js';

/**
 * Multiplayer around the real interactive Cursor CLI (`agent`): PTY
 * passthrough, remote instructions typed visibly into the composer, and
 * observation by tailing Cursor's own chat store (~/.cursor/chats) — current
 * CLI builds ignore hooks.json entirely (verified live), so the store is the
 * transparent feed: prose, tool calls, tool results, host prompts, titles.
 * Options: cwd, model, cursorPath, extraArgs, sessionId+resume, onExit(code)
 */
export class CursorNativeAdapter extends AgentAdapter {
  constructor(options = {}) {
    super(options);
    this.pty = null;
    this.tail = null;
    this.paused = false;
    this.queue = [];
    this.stopping = false;
    this.sessionStarted = false;
    this._recentInjections = [];
    this._stdinHandler = null;
    this._resizeHandler = null;
  }

  get info() {
    return {
      type: 'cursor-native',
      ui: 'interactive cursor cli (PTY passthrough)',
      cwd: this.options.cwd || process.cwd(),
      sessionId: this.options.sessionId ?? undefined,
    };
  }

  async createSession() {
    const { default: pty } = await import('node-pty')
      .then((m) => ({ default: m }))
      .catch(() => ({ default: null }));
    if (!pty) {
      throw new Error(
        'node-pty is not available (native build missing). Run scripts/setup.sh, ' +
        'or use headless mode: collagent create --adapter cursor',
      );
    }

    const {
      cwd = process.cwd(),
      model,
      cursorPath = 'agent',
      extraArgs = [],
    } = this.options;

    this.pty = pty.spawn(cursorPath, [...(model ? ['--model', model] : []), ...extraArgs], {
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

    this.tail = new CursorChatTail({
      cwd,
      sessionId: this.options.sessionId ?? null,
      resume: Boolean(this.options.resume),
      onEvent: (event) => this._onStoreEvent(event),
    });
    this.tail.start();

    // if the chat store never appears (trust screen, login), inject anyway
    this._startupFallback = setTimeout(() => this._markSessionStarted(), 20_000);

    this.emit({ kind: 'agent_status', status: 'ready', detail: this.info });
    return this.info;
  }

  _onStoreEvent(event) {
    if (event.kind === 'agent_status' && event.status === 'ready') this._markSessionStarted();
    // an injected instruction comes back as the chat's user record — don't show it twice
    if (event.kind === 'local_prompt' && this._wasInjected(event.text)) return;
    this.emit(event);
  }

  _markSessionStarted() {
    if (this.sessionStarted) return;
    this.sessionStarted = true;
    if (this.paused) return;
    const held = this.queue.splice(0);
    // settle delay: the composer isn't focused immediately after startup screens
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

  _inject({ text, from }) {
    const speaker = from?.name ? `[${from.name}] ` : '';
    const line = `${speaker}${text}`;
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
    if (!this.sessionStarted) return;
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
    process.stdout.write('\x1b[?25h');
  }

  async disconnect() {
    this.stopping = true;
    clearTimeout(this._startupFallback);
    this.tail?.stop();
    this.tail = null;
    this._restoreTerminal();
    try { this.pty?.kill(); } catch { /* ignore */ }
    this.pty = null;
  }
}
