import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentAdapter } from '../adapter.js';
import { token } from '../../core/ids.js';
import { buildHooksConfig, translateGooseHookEvent } from './hooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_BIN = path.join(__dirname, '..', '..', '..', 'bin', 'collagent-hook.js');

/**
 * Multiplayer around the real interactive `goose session`: PTY passthrough,
 * hooks via Collagent's own plugin dir (<cwd>/.agents/plugins/collagent/,
 * created on start and removed on disconnect — other plugins untouched), and
 * remote instructions typed visibly into the prompt. The Stop hook carries
 * the turn's final reply, so rooms see the agent's prose.
 * Options: cwd, model, goosePath, extraArgs, onExit(code)
 */
export class GooseNativeAdapter extends AgentAdapter {
  constructor(options = {}) {
    super(options);
    this.pty = null;
    this.receiver = null;
    this.paused = false;
    this.queue = [];
    this.stopping = false;
    this.sessionStarted = false;
    this._recentInjections = [];
    this._stdinHandler = null;
    this._resizeHandler = null;
    this._pluginDir = null;
  }

  get info() {
    return {
      type: 'goose-native',
      ui: 'interactive goose session (PTY passthrough)',
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
        'or use headless mode: collagent create --adapter goose',
      );
    }

    const {
      cwd = process.cwd(),
      model,
      goosePath = 'goose',
      extraArgs = [],
    } = this.options;

    const hookUrl = await this._startHookReceiver();
    this._installHooks(hookUrl, cwd);

    this.pty = pty.spawn(goosePath, ['session', ...(model ? ['--model', model] : []), ...extraArgs], {
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

    // if hooks never fire, release queued instructions anyway
    this._startupFallback = setTimeout(() => this._markSessionStarted(), 20_000);

    this.emit({ kind: 'agent_status', status: 'ready', detail: this.info });
    return this.info;
  }

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

  _installHooks(hookUrl, cwd) {
    const dir = path.join(cwd, '.agents', 'plugins', 'collagent', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    const command = `"${process.execPath}" "${HOOK_BIN}" "${hookUrl}"`;
    fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify(buildHooksConfig(command), null, 2));
    this._pluginDir = path.join(cwd, '.agents', 'plugins', 'collagent');
  }

  _restoreHooks() {
    if (!this._pluginDir) return;
    const plugin = this._pluginDir;
    this._pluginDir = null;
    try {
      fs.rmSync(plugin, { recursive: true, force: true });
      // tidy the parents if we were the only plugin
      for (const dir of [path.dirname(plugin), path.dirname(path.dirname(plugin))]) {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      }
    } catch { /* leave whatever state we can't clean */ }
  }

  _onHook(payload) {
    const events = translateGooseHookEvent(payload);
    if (events.some((e) => e.status === 'ready')) this._markSessionStarted();
    for (const event of events) {
      // an injected instruction echoes back as UserPromptSubmit — don't show it twice
      if (event.kind === 'local_prompt' && this._wasInjected(event.text)) continue;
      this.emit(event);
    }
  }

  _markSessionStarted() {
    if (this.sessionStarted) return;
    this.sessionStarted = true;
    if (this.paused) return;
    const held = this.queue.splice(0);
    // settle delay: the prompt isn't ready immediately after startup output
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
    this._restoreTerminal();
    try { this.pty?.kill(); } catch { /* ignore */ }
    this.pty = null;
    this.receiver?.close();
    this.receiver = null;
    this._restoreHooks();
  }
}
