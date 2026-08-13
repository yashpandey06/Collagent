import { EventLog } from './event-log.js';
import { participantId, token } from './ids.js';
import { buildRoomSummary } from './room-summary.js';

/**
 * A shared agent session — the fundamental Collagent object.
 *
 * Holds participants, the current control state (status / mode / driver)
 * and the ordered event log. Knows nothing about transports or about any
 * particular agent runtime: the server layer routes messages, the adapter
 * layer talks to the agent.
 *
 *   status: waiting_agent | idle | working | paused | ended
 *   mode:   open | driver
 */
export class Session {
  constructor({ code, agentType = 'unknown', persistPath = null }) {
    this.code = code;
    this.agentType = agentType;
    this.createdAt = Date.now();
    this.status = 'waiting_agent';
    this.mode = 'open';
    this.driverId = null;
    this.participants = new Map(); // id -> participant
    this.agentToken = token();
    this.agentInfo = null; // set when adapter reports ready
    this.log = new EventLog({ persistPath });
  }

  addParticipant({ name, role = 'collaborator' }) {
    const p = {
      id: participantId(),
      resumeToken: token(),
      name: this._uniqueName(name),
      role,
      connected: true,
      joinedAt: Date.now(),
    };
    this.participants.set(p.id, p);
    if (role === 'host' && !this.driverId) this.driverId = p.id;
    return p;
  }

  /**
   * Display names must be unique within a session — both humans on one team
   * often share an OS username, and handoff/presence are name-based.
   */
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

  append(kind, actor, data = {}) {
    return this.log.append({ kind, actor, data });
  }

  hasHost() {
    return [...this.participants.values()].some((p) => p.role === 'host');
  }

  /** Agent-runtime session id (e.g. Claude Code's), from the event history. */
  lastAgentSessionId() {
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
    const { agentSessionId, ...facts } = buildRoomSummary(this.log.events);
    return { ...this.toJSON(), ...facts, code: this.code };
  }

  /** Public snapshot safe to send to participants / the web page. */
  toJSON() {
    return {
      code: this.code,
      agentType: this.agentType,
      agentInfo: this.agentInfo,
      createdAt: this.createdAt,
      status: this.status,
      mode: this.mode,
      driverId: this.driverId,
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
