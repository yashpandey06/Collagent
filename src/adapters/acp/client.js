import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AgentAdapter } from '../adapter.js';
import { formatInstructionLine } from '../instruction-format.js';
import { VERSION } from '../../version.js';
import { encode, isRequest, isResponse, translateAcpUpdate, turnEnd } from './protocol.js';

/**
 * Drives any ACP agent (`gemini --acp`, `goose acp`, `opencode acp`) over
 * JSON-RPC on stdio: initialize → session/new (or session/load on resume) →
 * one session/prompt per instruction. Turns run one at a time; instructions
 * arriving mid-turn or while paused queue.
 * Options: command (required), args, cwd, env, autoApprove (default true),
 *          label, sessionId+resume, extraArgs, onExit(code)
 */
export class AcpAdapter extends AgentAdapter {
  constructor(options = {}) {
    super(options);
    this.proc = null;
    this.sessionId = options.sessionId ?? null;
    this.paused = false;
    this.busy = false;
    this.queue = [];
    this.stopping = false;
    this._nextId = 1;
    this._pending = new Map();
    this._buffer = { text: '' };
    this._capabilities = null;
  }

  get info() {
    return {
      type: this.options.label ?? 'acp',
      ui: `collagent feed (${this.options.command ?? 'acp'} agent)`,
      cwd: this.options.cwd || process.cwd(),
      sessionId: this.sessionId ?? undefined,
    };
  }

  async createSession() {
    const {
      command,
      args = [],
      cwd = process.cwd(),
      env = {},
      extraArgs = [],
    } = this.options;

    this.emit({ kind: 'agent_status', status: 'starting', detail: { cwd } });

    this.proc = spawn(command, [...args, ...extraArgs], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.on('error', (err) => {
      const message = err.code === 'ENOENT'
        ? `${command} not found — install it first`
        : `failed to start ${command}: ${err.message}`;
      this.emit({ kind: 'error', message });
      this.emit({ kind: 'agent_status', status: 'error', detail: { message } });
      this._rejectAllPending(new Error(message));
    });

    let stderrBuf = '';
    this.proc.stderr.on('data', (d) => { stderrBuf = (stderrBuf + d).slice(-4000); });

    this.proc.on('exit', (code) => {
      this._rejectAllPending(new Error(`${command} exited`));
      if (this.stopping) return;
      this.emit({
        kind: 'agent_status',
        status: 'exited',
        detail: { code, stderr: stderrBuf.trim().slice(-500) || undefined },
      });
      this.options.onExit?.(code);
    });

    createInterface({ input: this.proc.stdout }).on('line', (line) => this._onLine(line));

    const init = await this._request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'collagent', version: VERSION },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    this._capabilities = init?.agentCapabilities ?? {};

    if (this.options.resume && this.sessionId && this._capabilities.loadSession) {
      await this._request('session/load', { sessionId: this.sessionId, cwd, mcpServers: [] });
    } else {
      const started = await this._request('session/new', { cwd, mcpServers: [] });
      this.sessionId = started?.sessionId ?? this.sessionId;
    }

    this.emit({
      kind: 'agent_status',
      status: 'ready',
      detail: { sessionId: this.sessionId, cwd, agent: init?.agentInfo?.name },
    });
    return this.info;
  }

  async sendInstruction({ text, from }) {
    if (this.paused || this.busy) {
      this.queue.push({ text, from });
      return { queued: true };
    }
    return this._prompt({ text, from });
  }

  async _prompt({ text, from }) {
    if (!this.sessionId) return { queued: false };
    this.busy = true;
    this.emit({ kind: 'agent_status', status: 'working' });
    try {
      const res = await this._request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: formatInstructionLine({ text, from }) }],
      }, 600_000);
      for (const event of turnEnd(res?.stopReason, this._buffer)) this.emit(event);
    } catch (err) {
      this.emit({ kind: 'error', message: `${this.options.command ?? 'agent'} refused the instruction: ${err.message}` });
      this.emit({ kind: 'agent_status', status: 'idle' });
    }
    this.busy = false;
    if (!this.paused && this.queue.length) this._prompt(this.queue.shift());
    return { queued: false };
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
    if (!this.busy && this.queue.length) await this._prompt(this.queue.shift());
  }

  async handoff(info) {
    this.lastHandoff = info;
  }

  async disconnect() {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;
    if (this.busy && this.sessionId) {
      this._notify('session/cancel', { sessionId: this.sessionId });
    }
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
      return; // agents log noise to stdout sometimes
    }

    if (isResponse(msg)) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? 'acp error'));
      else pending.resolve(msg.result);
      return;
    }

    if (isRequest(msg)) return this._onAgentRequest(msg);

    if (msg.method === 'session/update') {
      const { sessionId, update } = msg.params ?? {};
      if (sessionId && this.sessionId && sessionId !== this.sessionId) return;
      for (const event of translateAcpUpdate(update, this._buffer)) this.emit(event);
    }
  }

  // Agent→client requests. Rooms run unattended, so permission requests are
  // answered by policy: pick an approve-kind option (acceptEdits spirit) or
  // cancel when autoApprove is off. Declared-off fs methods are refused.
  _onAgentRequest(msg) {
    if (msg.method === 'session/request_permission') {
      const options = msg.params?.options ?? [];
      const approve = options.find((o) => String(o.kind ?? '').startsWith('allow') || o.kind === 'approve');
      const autoApprove = this.options.autoApprove ?? true;
      if (autoApprove && approve) {
        this.emit({ kind: 'notice', message: `auto-approved: ${msg.params?.toolCall?.title ?? 'tool call'}` });
        return this._send({ id: msg.id, result: { outcome: { outcome: 'selected', optionId: approve.id } } });
      }
      this.emit({ kind: 'notice', message: `${this.options.command ?? 'agent'} asked for approval — declined (room runs unattended)` });
      return this._send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
    }
    this._send({ id: msg.id, error: { code: -32601, message: `collagent does not support ${msg.method}` } });
  }

  _request(method, params, timeoutMs = 30_000) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
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
