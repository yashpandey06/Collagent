import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentAdapter } from '../adapter.js';
import { token } from '../../core/ids.js';
import { HOOK_EVENTS, translateCodexHookEvent } from './hooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_BIN = path.join(__dirname, '..', '..', '..', 'bin', 'collagent-hook.js');

/**
 * CodexNativeAdapter — multiplayer around the REAL interactive Codex CLI,
 * the same shape as the Claude native adapter:
 *
 *  1. PTY passthrough — `codex` runs interactively inside a pseudo-terminal;
 *     the host's keystrokes and screen pass through untouched.
 *  2. Hooks — Codex reads hook config from $CODEX_HOME. We build a throwaway
 *     CODEX_HOME that symlinks the real one (auth, config, sessions, plugins
 *     all keep working) and adds our own hooks.json on top, so lifecycle
 *     activity is POSTed to a loopback receiver and mirrored to participants.
 *  3. Composer injection — remote instructions are typed into Codex's own
 *     prompt box (bracketed paste + Enter), visibly, as `[Bob] …`.
 *
 * Unlike Claude Code, Codex has no command-backed status line, so room
 * presence cannot be rendered inside Codex's UI — the host reads it from
 * `collagent status` or the web page instead.
 *
 * Options: cwd, model, codexPath, extraArgs, onExit(code)
 */
export class CodexNativeAdapter extends AgentAdapter {
  constructor(options = {}) {
    super(options);
    this.pty = null;
    this.receiver = null;
    this.codexHome = null;
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
      type: 'codex-native',
      ui: 'interactive codex cli (PTY passthrough)',
      cwd: this.options.cwd || process.cwd(),
    };
  }

  async createSession() {
    const { default: pty } = await import('node-pty')
      .then((m) => ({ default: m }))
      .catch(() => ({ default: null }));
    if (!pty) {
      throw new Error(
        'node-pty is not available (native build missing). Run scripts/setup.sh, ' +
        'or use the app-server adapter: collagent create --adapter codex',
      );
    }

    const hookUrl = await this._startHookReceiver();
    this.codexHome = this._writeHookOverlay(hookUrl);

    const {
      cwd = process.cwd(),
      model,
      codexPath = 'codex',
      extraArgs = [],
    } = this.options;

    this.pty = pty.spawn(codexPath, [...(model ? ['--model', model] : []), ...extraArgs], {
      name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 32,
      cwd,
      env: { ...process.env, CODEX_HOME: this.codexHome },
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

    // Codex gates hooks behind a trust prompt; if ours never runs, remote
    // instructions would queue forever. Release them after a startup window.
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

  /**
   * Build a throwaway CODEX_HOME: symlinks to everything in the host's real
   * one, plus our hooks.json. Symlinks mean sessions and auth still live in
   * the host's actual Codex home — we add observation, we don't relocate state.
   */
  _writeHookOverlay(hookUrl) {
    const realHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const overlay = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-codex-'));

    let existing = {};
    try {
      for (const entry of fs.readdirSync(realHome)) {
        if (entry === 'hooks.json') continue; // merged below, ours is written fresh
        try {
          fs.symlinkSync(path.join(realHome, entry), path.join(overlay, entry));
        } catch { /* skip entries we cannot link */ }
      }
      existing = JSON.parse(fs.readFileSync(path.join(realHome, 'hooks.json'), 'utf8'))?.hooks ?? {};
    } catch { /* no real home, or no hooks.json — both fine */ }

    const handler = {
      type: 'command',
      command: `"${process.execPath}" "${HOOK_BIN}" "${hookUrl}"`,
      timeout: 5,
    };
    // Keep the host's own hooks; add ours alongside them.
    const hooks = { ...existing };
    for (const event of HOOK_EVENTS) {
      hooks[event] = [...(hooks[event] ?? []), { hooks: [handler] }];
    }
    fs.writeFileSync(path.join(overlay, 'hooks.json'), JSON.stringify({ hooks }));
    return overlay;
  }

  _onHook(payload) {
    const events = translateCodexHookEvent(payload);
    if (events.some((e) => e.status === 'ready')) this._markSessionStarted();
    for (const event of events) {
      // Injected instructions come back as UserPromptSubmit; don't echo twice.
      if (event.kind === 'local_prompt' && this._wasInjected(event.text)) continue;
      this.emit(event);
    }
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
    if (this.codexHome) {
      // Entries are symlinks; removing them never touches the real Codex home.
      try { fs.rmSync(this.codexHome, { recursive: true, force: true }); } catch { /* ignore */ }
      this.codexHome = null;
    }
  }
}
