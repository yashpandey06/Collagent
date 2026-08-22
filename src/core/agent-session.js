import { agentSessionId, token } from './ids.js';

/**
 * One independently running/attached agent inside a room. The room owns
 * shared coordination context; each AgentSession keeps its own private
 * runtime context (native conversation, tools, filesystem, process state) —
 * Collagent never merges those.
 *
 * status: created | connecting | starting | working | waiting | paused |
 *         idle | completed | failed | disconnected
 */
export class AgentSession {
  constructor({ roomId, agentId, adapterType, hostId = null, nativeSessionId = null, metadata = {} }) {
    this.id = agentSessionId();
    this.roomId = roomId;
    this.agentId = agentId;
    this.runtime = runtimeOf(adapterType);
    this.adapterType = adapterType;
    this.status = 'created';
    this.hostId = hostId;
    this.agentToken = token();
    this.nativeSessionId = nativeSessionId;
    this.createdAt = Date.now();
    this.attachedAt = null;
    this.detachedAt = null;
    this.attached = false;
    this.currentTurnId = null;
    this.metadata = metadata;
  }

  /** Adapter-reported agent_status → AgentSession status. */
  applyAgentStatus(status) {
    const map = {
      starting: 'starting',
      ready: 'idle',
      working: 'working',
      idle: 'idle',
      exited: 'disconnected',
      disconnected: 'disconnected',
      error: 'failed',
    };
    if (map[status]) this.status = map[status];
  }

  markAttached(hostId = null) {
    this.attached = true;
    this.attachedAt = Date.now();
    this.detachedAt = null;
    if (hostId) this.hostId = hostId;
    if (this.status === 'created' || this.status === 'disconnected') this.status = 'connecting';
  }

  markDetached() {
    this.attached = false;
    this.detachedAt = Date.now();
    this.status = 'disconnected';
    this.currentTurnId = null;
  }

  /** Public snapshot — never includes the agentToken. */
  toJSON() {
    return {
      id: this.id,
      agentId: this.agentId,
      runtime: this.runtime,
      adapterType: this.adapterType,
      status: this.status,
      hostId: this.hostId,
      nativeSessionId: this.nativeSessionId,
      createdAt: this.createdAt,
      attachedAt: this.attachedAt,
      detachedAt: this.detachedAt,
      attached: this.attached,
      currentTurnId: this.currentTurnId,
    };
  }

  /** Rebuild from a persisted snapshot; tokens are re-minted, never stored. */
  static restore(roomId, snapshot) {
    const session = new AgentSession({ roomId, agentId: snapshot.agentId, adapterType: snapshot.adapterType });
    session.id = snapshot.id ?? session.id;
    session.runtime = snapshot.runtime ?? session.runtime;
    session.hostId = snapshot.hostId ?? null;
    session.nativeSessionId = snapshot.nativeSessionId ?? null;
    session.createdAt = snapshot.createdAt ?? session.createdAt;
    session.detachedAt = snapshot.detachedAt ?? null;
    session.status = 'disconnected';
    session.attached = false;
    return session;
  }
}

/**
 * Room-local runtime name from an adapter id, by pure string rule:
 * "claude-native" → "claude", "claude-code" → "claude", "codex" → "codex".
 * Core stays free of the adapter registry.
 */
export function runtimeOf(adapterType) {
  const base = String(adapterType ?? 'agent').split('-')[0].trim();
  return base || 'agent';
}
