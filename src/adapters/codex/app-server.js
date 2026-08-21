import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AgentAdapter } from '../adapter.js';
import { formatInstructionLine } from '../instruction-format.js';
import { encode, isServerRequest, isResponse, translateAppServerEvent } from './protocol.js';
import { VERSION } from '../../version.js';

/**
 * Drives Codex through `codex app-server` (JSON-RPC over stdio). One
 * long-lived process holds one thread; instructions become turn/start calls.
 * approvalPolicy defaults to "never" — anything else can block a turn on an
 * approval no remote participant can answer.
 * Options: cwd, model, approvalPolicy, sandbox, codexPath, threadId+resume, extraArgs
 */
export class CodexAppServerAdapter extends AgentAdapter {
  constructor(options = {}) {
    super(options);
    this.proc = null;
    this.threadId = options.threadId ?? null;
    this.paused = false;
    this.queue = [];
    this.stopping = false;
    this.turnId = null;
    this._nextId = 1;
    this._pending = new Map(); // rpc id -> {resolve, reject}
  }

  get info() {
    return {
      type: 'codex',
      ui: 'collagent feed (codex app server)',
      cwd: this.options.cwd || process.cwd(),
      sessionId: this.threadId ?? undefined,
    };
  }

  async createSession() {
    const {
      cwd = process.cwd(),
      codexPath = 'codex',
      extraArgs = [],
      model,
      approvalPolicy = 'never',
      sandbox = 'workspace-write',
    } = this.options;

    this.emit({ kind: 'agent_status', status: 'starting', detail: { cwd } });

    this.proc = spawn(codexPath, ['app-server', ...extraArgs], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.on('error', (err) => {
      const message = err.code === 'ENOENT'
        ? `codex CLI not found (tried "${codexPath}") — install it from https://developers.openai.com/codex`
        : `failed to start codex: ${err.message}`;
      this.emit({ kind: 'error', message });
      this.emit({ kind: 'agent_status', status: 'error', detail: { message } });
      // Fail the handshake now; otherwise createSession waits out its timeout.
      this._rejectAllPending(new Error(message));
    });

    let stderrBuf = '';
    this.proc.stderr.on('data', (d) => { stderrBuf = (stderrBuf + d).slice(-4000); });

    this.proc.on('exit', (code) => {
      this._rejectAllPending(new Error('codex app server exited'));
      if (this.stopping) return;
      this.emit({
        kind: 'agent_status',
        status: 'exited',
        detail: { code, stderr: stderrBuf.trim().slice(-500) || undefined },
      });
      this.options.onExit?.(code);
    });

    createInterface({ input: this.proc.stdout }).on('line', (line) => this._onLine(line));

    // any request before the `initialized` notification gets "Not initialized"
    await this._request('initialize', {
      clientInfo: { name: 'collagent', title: 'Collagent', version: VERSION },
      capabilities: null,
    });
    this._notify('initialized');

    const started = this.options.resume && this.threadId
      ? await this._request('thread/resume', { threadId: this.threadId })
      : await this._request('thread/start', { cwd, approvalPolicy, sandbox, ...(model && { model }) });

    this.threadId = started?.thread?.id ?? started?.thread?.sessionId ?? this.threadId;

    // detail.sessionId is how Collagent remembers the thread for `open`.
    this.emit({
      kind: 'agent_status',
      status: 'ready',
      detail: {
        sessionId: this.threadId,
        model: started?.model,
        cwd: started?.cwd ?? cwd,
      },
    });
    if (started?.thread?.name) {
      this.emit({ kind: 'session_title', title: started.thread.name });
    }
    return this.info;
  }

  async sendInstruction({ text, from }) {
    if (this.paused) {
      this.queue.push({ text, from });
      return { queued: true };
    }
    return this._startTurn({ text, from });
  }

  async _startTurn({ text, from }) {
    if (!this.threadId) return { queued: false };
    // Speaker-tagged so the shared agent knows who is talking; slash
    // commands pass through bare so the runtime can parse them.
    this.emit({ kind: 'agent_status', status: 'working' });
    try {
      const res = await this._request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: formatInstructionLine({ text, from }) }],
      });
      this.turnId = res?.turn?.id ?? null;
    } catch (err) {
      this.emit({ kind: 'error', message: `codex refused the instruction: ${err.message}` });
      this.emit({ kind: 'agent_status', status: 'idle' });
    }
    return { queued: false };
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
    const held = this.queue.splice(0);
    for (const instruction of held) await this._startTurn(instruction);
  }

  async handoff(info) {
    this.lastHandoff = info;
  }

  async disconnect() {
    this.stopping = true;
    if (!this.proc) return;
    if (this.turnId) {
      try {
        await this._request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
      } catch { /* shutting down anyway */ }
    }
    const proc = this.proc;
    try { proc.stdin.end(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        resolve();
      }, 1500);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
    this.proc = null;
  }

  // ---- JSON-RPC plumbing --------------------------------------------------

  _onLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout
    }

    if (isResponse(msg)) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? 'codex rpc error'));
      else pending.resolve(msg.result);
      return;
    }

    // A server→client request blocks the turn until answered; with no host to
    // ask, decline rather than hang the thread forever.
    if (isServerRequest(msg)) {
      this._send({ id: msg.id, error: { code: -32601, message: 'collagent runs codex unattended' } });
      this.emit({ kind: 'notice', message: `codex asked for approval (${msg.method}) — declined` });
      return;
    }

    for (const event of translateAppServerEvent(msg)) this.emit(event);
  }

  _request(method, params) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      // clear the timer on settle, or every request pins the event loop for its full timeout
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`codex did not answer ${method} in time`));
      }, 30_000);
      this._pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this._send({ id, method, params });
    });
  }

  _notify(method, params) {
    this._send({ method, ...(params && { params }) });
  }

  _send(msg) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(encode(msg));
  }

  _rejectAllPending(err) {
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
  }
}
