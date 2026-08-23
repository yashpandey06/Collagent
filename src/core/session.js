import { EventLog } from './event-log.js';
import { participantId, token, joinKey } from './ids.js';
import { buildRoomSummary } from './room-summary.js';
import { AgentSession, runtimeOf } from './agent-session.js';

/**
 * A room: persistent shared work container — human participants, shared
 * event history, and one or many agent sessions. Room lifecycle and agent
 * state are separate concepts:
 *
 *   lifecycle: active | archived | ended        (the room itself)
 *   status:    waiting_agent | idle | working | paused | ended  (derived,
 *              kept for wire/UI compatibility — never stored)
 *
 * mode: open (anyone instructs) | driver (only the driver).
 */
export class Session {
  constructor({ code, agentType = 'unknown', persistPath = null }) {
    this.code = code;
    this.agentType = agentType; // primary adapter id — legacy field, kept for compat
    this.workspaceId = null;
    this.createdAt = Date.now();
    this.lifecycle = 'active';
    this.paused = false;
    this.mode = 'open';
    this.driverId = null;
    this.defaultAgentId = null; // room-wide instruction focus (handoff @agent)
    this.participants = new Map(); // id -> participant
    this.agentSessions = new Map(); // agentId -> AgentSession
    this.joinKey = joinKey();
    this.agentInfo = null; // primary agent's ready detail — legacy field
    this.pending = []; // instructions waiting for an agent to attach
    this.eventCache = 0; // 0 = unbounded; applyEventCache() bounds it
    this.eventReader = null;
    this._summarySeed = null;
    this.log = new EventLog({ persistPath });
  }

  // ---- agent sessions ------------------------------------------------------

  /** Create a new AgentSession with a stable room-local id (claude-1, codex-2…). */
  addAgentSession({ adapterType, hostId = null, nativeSessionId = null, metadata = {} }) {
    const runtime = runtimeOf(adapterType);
    let n = 1;
    while (this.agentSessions.has(`${runtime}-${n}`)) n++;
    const agent = new AgentSession({
      roomId: this.code,
      agentId: `${runtime}-${n}`,
      adapterType,
      hostId,
      nativeSessionId,
      metadata,
    });
    this.agentSessions.set(agent.agentId, agent);
    if (this.agentSessions.size === 1) this.agentType = adapterType;
    return agent;
  }

  restoreAgentSession(snapshot) {
    const agent = AgentSession.restore(this.code, snapshot);
    this.agentSessions.set(agent.agentId, agent);
    return agent;
  }

  getAgentSession(agentId) {
    return this.agentSessions.get(agentId) ?? null;
  }

  /** Resolve "@claude-1", "@claude" (when unique), or an AgentSession id. */
  findAgentSession(ref) {
    if (!ref) return null;
    const wanted = String(ref).toLowerCase().replace(/^@/, '');
    const direct = this.agentSessions.get(wanted);
    if (direct) return direct;
    const all = [...this.agentSessions.values()];
    const byId = all.find((a) => a.id === wanted);
    if (byId) return byId;
    const byRuntime = all.filter((a) => a.runtime.toLowerCase() === wanted);
    return byRuntime.length === 1 ? byRuntime[0] : null;
  }

  agentSessionByToken(agentToken) {
    for (const a of this.agentSessions.values()) {
      if (a.agentToken === agentToken) return a;
    }
    return null;
  }

  attachedAgents() {
    return [...this.agentSessions.values()].filter((a) => a.attached);
  }

  /** The room's first agent session — what legacy single-agent flows mean by "the agent". */
  primaryAgent() {
    return [...this.agentSessions.values()][0] ?? null;
  }

  /** Legacy accessor: the primary agent's attach token (create/open flows). */
  get agentToken() {
    return this.primaryAgent()?.agentToken ?? null;
  }

  // ---- derived status (wire/UI compatibility) ------------------------------

  get status() {
    if (this.lifecycle === 'ended') return 'ended';
    if (this.paused) return 'paused';
    const live = this.attachedAgents();
    if (!live.length) return 'waiting_agent';
    if (live.some((a) => a.status === 'working')) return 'working';
    return 'idle';
  }

  // ---- participants --------------------------------------------------------

  addParticipant({ name, role = 'collaborator', userId = null }) {
    const p = {
      id: participantId(),
      resumeToken: token(),
      name: this._uniqueName(name),
      role,
      userId,
      connected: true,
      defaultAgentId: null,
      joinedAt: Date.now(),
    };
    this.participants.set(p.id, p);
    if (role === 'host' && !this.driverId) this.driverId = p.id;
    return p;
  }

  // Names must be unique per session: handoff and presence are name-based.
  _uniqueName(name) {
    const base = String(name || 'guest').trim() || 'guest';
    if (!this.findParticipantByName(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!this.findParticipantByName(candidate)) return candidate;
    }
  }

  getParticipant(id) {
    return this.participants.get(id) ?? null;
  }

  findParticipantByName(name) {
    const lower = String(name).toLowerCase();
    for (const p of this.participants.values()) {
      if (p.name.toLowerCase() === lower) return p;
    }
    return null;
  }

  removeParticipant(id) {
    const p = this.participants.get(id);
    if (!p) return null;
    this.participants.delete(id);
    if (this.driverId === id) {
      // Control falls back to the host (or the first remaining participant).
      const host = [...this.participants.values()].find((x) => x.role === 'host');
      this.driverId = host?.id ?? [...this.participants.keys()][0] ?? null;
    }
    return p;
  }

  hasHost() {
    return [...this.participants.values()].some((p) => p.role === 'host');
  }

  hasConnectedHost() {
    return [...this.participants.values()].some((p) => p.role === 'host' && p.connected);
  }

  // ---- events ----------------------------------------------------------------

  /** Append an event; ctx may carry agentId / agentSessionId / turnId. */
  append(kind, actor, data = {}, ctx = {}) {
    const entry = this.log.append({ kind, actor, data, roomId: this.code, ...ctx });
    this._maybeTrim();
    return entry;
  }

  /**
   * Cap the in-memory log at `size`, folding trimmed events into the summary
   * seed; `reader(sinceSeq, limit)` serves the trimmed prefix from the store.
   */
  applyEventCache(size, reader) {
    this.eventCache = size;
    this.eventReader = reader;
    this._maybeTrim();
  }

  _maybeTrim() {
    if (!this.eventCache || this.log.events.length <= this.eventCache) return;
    const dropped = this.log.trimTo(this.eventCache);
    this._summarySeed = buildRoomSummary(dropped, this._summarySeed);
  }

  /** Events after `seq`, reaching into the store when the log is trimmed. */
  async eventsSince(seq = 0) {
    const floor = this.log.floorSeq;
    if (seq >= floor - 1 || !this.eventReader) return this.log.since(seq);
    const older = (await this.eventReader(seq, Math.min(floor - 1 - seq, 10_000))) ?? [];
    return [...older.filter((e) => e.seq < floor), ...this.log.since(seq)];
  }

  /** Agent-runtime session id (e.g. Claude Code's), from the event history. */
  lastAgentSessionId() {
    const primary = this.primaryAgent();
    if (primary?.nativeSessionId) return primary.nativeSessionId;
    for (let i = this.log.events.length - 1; i >= 0; i--) {
      const e = this.log.events[i];
      if (e.kind === 'agent_status' && e.data?.detail?.sessionId) {
        return e.data.detail.sessionId;
      }
    }
    return null;
  }

  /** Snapshot + history-derived room facts, for listings and status views. */
  summary() {
    const { agentSessionId, firstInstruction, ...facts } = buildRoomSummary(this.log.events, this._summarySeed);
    return { ...this.toJSON(), ...facts, code: this.code };
  }

  /** What the store persists besides events. Secrets included — never sent to clients. */
  meta() {
    return {
      code: this.code,
      agentType: this.agentType,
      workspaceId: this.workspaceId,
      createdAt: this.createdAt,
      lifecycle: this.lifecycle,
      mode: this.mode,
      joinKey: this.joinKey,
      agentSessions: [...this.agentSessions.values()].map((a) => a.toJSON()),
      participants: [...this.participants.values()].map((p) => ({
        id: p.id,
        resumeToken: p.resumeToken,
        name: p.name,
        role: p.role,
        userId: p.userId,
        joinedAt: p.joinedAt,
      })),
    };
  }

  applyMeta(meta = {}) {
    if (meta.createdAt) this.createdAt = meta.createdAt;
    if (meta.workspaceId) this.workspaceId = meta.workspaceId;
    if (meta.lifecycle && meta.lifecycle !== 'ended') this.lifecycle = meta.lifecycle;
    if (meta.mode) this.mode = meta.mode;
    if (meta.joinKey) this.joinKey = meta.joinKey;
    if (meta.agentType) this.agentType = meta.agentType;
    for (const snapshot of meta.agentSessions ?? []) this.restoreAgentSession(snapshot);
    for (const p of meta.participants ?? []) {
      this.participants.set(p.id, {
        ...p,
        connected: false,
        defaultAgentId: null,
      });
    }
  }

  /** Public snapshot safe to send to participants / the web page. */
  toJSON() {
    return {
      code: this.code,
      agentType: this.agentType,
      workspaceId: this.workspaceId,
      agentInfo: this.agentInfo,
      createdAt: this.createdAt,
      lifecycle: this.lifecycle,
      status: this.status,
      mode: this.mode,
      driverId: this.driverId,
      agents: [...this.agentSessions.values()].map((a) => a.toJSON()),
      participants: [...this.participants.values()].map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        connected: p.connected,
      })),
      eventCount: this.log.length,
    };
  }
}
