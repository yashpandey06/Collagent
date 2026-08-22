import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { turnId } from '../core/ids.js';

/**
 * Participant-side connection. Emits: created, welcome, event, session,
 * server-error, disconnected, reconnected, closed. Reconnects with resume
 * credentials so a drop keeps identity and replays only missed events.
 */
export class CollagentClient extends EventEmitter {
  constructor({ serverUrl, name, userId = null }) {
    super();
    this.serverUrl = normalizeWsUrl(serverUrl);
    this.name = name;
    this.userId = userId;
    this.ws = null;
    this.session = null;
    this.self = null;
    this.lastSeq = 0;
    this.closed = false;
    this._intent = null; // what to (re)send on connect
  }

  async connect() {
    await this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.serverUrl);
      this.ws = ws;
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
      ws.on('message', (raw) => this._onMessage(JSON.parse(raw.toString())));
      ws.on('close', () => this._onClose());
    });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'session_created':
        this.session = msg.session;
        this.self = msg.self;
        if (msg.self?.name) this.name = msg.self.name; // server may dedupe the name
        this.agentToken = msg.agentToken;
        this.joinKey = msg.joinKey ?? null;
        this.agent = msg.agent ?? null;
        this._trackSeq(msg.events);
        this.emit('created', msg);
        break;
      case 'welcome':
        this.session = msg.session;
        this.self = msg.self;
        if (msg.self?.name) this.name = msg.self.name;
        if (msg.agentToken) this.agentToken = msg.agentToken; // host of a reopened room
        if (msg.agents) this.agentGrants = msg.agents; // detached sessions this client may re-host
        if (msg.joinKey) this.joinKey = msg.joinKey; // hosts may invite others
        this._trackSeq(msg.events);
        this.emit(msg.resumed ? 'reconnected' : 'welcome', msg);
        break;
      case 'agent_added':
        this.emit('agent_added', msg);
        break;
      case 'ok':
        this.emit('ok', msg.message);
        break;
      case 'event':
        if (msg.event?.seq) this.lastSeq = Math.max(this.lastSeq, msg.event.seq);
        this.emit('event', msg.event);
        break;
      case 'session':
        this.session = msg.session;
        this.emit('session', msg.session);
        break;
      case 'error':
        this.emit('server-error', msg.message);
        break;
      default:
        break;
    }
  }

  _trackSeq(events = []) {
    for (const e of events) this.lastSeq = Math.max(this.lastSeq, e.seq ?? 0);
  }

  async _onClose() {
    if (this.closed) return this.emit('closed');
    // a failed reconnect fires its own 'close' — don't nest reconnect loops
    if (this._reconnecting) return;
    this.emit('disconnected');
    if (!this.self || !this.session) return this.emit('closed');
    this._reconnecting = true;
    try {
      for (let attempt = 1; attempt <= 10 && !this.closed; attempt++) {
        await sleep(Math.min(250 * 2 ** (attempt - 1), 5000));
        try {
          await this._open();
          this._send({
            type: 'rejoin',
            code: this.session.code,
            participantId: this.self.participantId,
            resumeToken: this.self.resumeToken,
            sinceSeq: this.lastSeq,
          });
          return;
        } catch {
          /* retry */
        }
      }
      this.emit('closed');
    } finally {
      this._reconnecting = false;
    }
  }

  createSession({ agentType = 'unknown' } = {}) {
    this._send({ type: 'create_session', name: this.name, agentType, userId: this.userId });
    return this._await('created');
  }

  join(code, { key = null } = {}) {
    this._send({ type: 'join', code, name: this.name, key, userId: this.userId });
    return this._await('welcome');
  }

  /** Add another agent session to the room; resolves with { agent, agentToken }. */
  addAgent(agentType) {
    this._send({ type: 'add_agent', agentType });
    return this._await('agent_added');
  }

  sendInstruction(text, { to = null } = {}) {
    this._send({ type: 'instruction', text, to });
  }

  control(action, extra = {}) {
    this._send({ type: 'control', action, ...extra });
  }

  leave() {
    this._send({ type: 'leave' });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _await(okEvent, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${okEvent}`));
      }, timeoutMs);
      const onOk = (msg) => { cleanup(); resolve(msg); };
      const onErr = (message) => { cleanup(); reject(new Error(message)); };
      const cleanup = () => {
        clearTimeout(t);
        this.off(okEvent, onOk);
        this.off('server-error', onErr);
      };
      this.once(okEvent, onOk);
      this.once('server-error', onErr);
    });
  }
}

/**
 * Bridges an AgentAdapter to one AgentSession over its own WebSocket, on the
 * machine that owns the agent: server messages → adapter, adapter events →
 * server. The host also owns the turn lifecycle — a turn starts when an
 * instruction (or a host-typed prompt) reaches the adapter and ends with the
 * adapter's `result` contract event — so every event the server stores can
 * carry an explicit turnId, never one inferred from timing.
 */
export class AgentHost {
  constructor({ serverUrl, code, agentToken, adapter }) {
    this.serverUrl = normalizeWsUrl(serverUrl);
    this.code = code;
    this.agentToken = agentToken;
    this.adapter = adapter;
    this.agentId = null; // assigned by the server on attach
    this.ws = null;
    this._turn = null;
  }

  async start() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.serverUrl);
      this.ws = ws;
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'agent_attach', code: this.code, agentToken: this.agentToken }));
      });
      ws.once('error', reject);
      ws.on('message', async (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'agent_attached') {
          this.agentId = msg.agent?.agentId ?? null;
          return resolve();
        }
        if (msg.type === 'error') return reject(new Error(msg.message));
        try {
          await this._route(msg);
        } catch (err) {
          this._emit({ kind: 'error', message: err.message });
        }
      });
    });

    this.adapter.attach((event) => this._onAdapterEvent(event));
    await this.adapter.createSession();
  }

  async _route(msg) {
    switch (msg.type) {
      case 'instruction':
        this._beginTurn('instruction', msg.eventSeq);
        return this.adapter.sendInstruction({ text: msg.text, from: msg.from });
      case 'pause':
        return this.adapter.pause();
      case 'resume':
        return this.adapter.resume();
      case 'handoff':
        return this.adapter.handoff(msg.to);
      case 'end':
        await this.adapter.disconnect();
        this.ws?.close();
        return;
      default:
        return;
    }
  }

  _onAdapterEvent(event) {
    if (event.kind === 'local_prompt') this._beginTurn('local_prompt');
    if (event.kind === 'tool_use' && this._turn) this._turn.toolCalls++;
    this._emit(event);
    if (event.kind === 'result') this._endTurn(event);
    if (event.kind === 'agent_status' && ['exited', 'error'].includes(event.status) && this._turn) {
      this._endTurn({ ok: false });
    }
  }

  _beginTurn(trigger, instructionSeq = null) {
    if (this._turn) return this._turn;
    this._turn = { id: turnId(), startedAt: Date.now(), toolCalls: 0 };
    this._emit({
      kind: 'turn_started',
      turnId: this._turn.id,
      trigger,
      ...(instructionSeq ? { instructionSeq } : {}),
    });
    return this._turn;
  }

  _endTurn(result) {
    const turn = this._turn;
    if (!turn) return;
    this._turn = null;
    const ok = result.ok !== false;
    this._emit({
      kind: ok ? 'turn_completed' : 'turn_failed',
      turnId: turn.id,
      ok,
      durationMs: result.durationMs ?? Date.now() - turn.startedAt,
      toolCalls: turn.toolCalls,
      usage: result.usage ?? null,
    });
  }

  _emit(event) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'agent_event', event, turnId: this._turn?.id ?? event.turnId ?? null }));
    }
  }

  async stop() {
    await this.adapter.disconnect();
    this.ws?.close();
  }
}

function normalizeWsUrl(url) {
  let u = url || 'ws://127.0.0.1:7717';
  if (u.startsWith('http://')) u = 'ws://' + u.slice(7);
  if (u.startsWith('https://')) u = 'wss://' + u.slice(8);
  if (!u.startsWith('ws://') && !u.startsWith('wss://')) u = 'ws://' + u;
  const parsed = new URL(u);
  if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/ws';
  return parsed.toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
