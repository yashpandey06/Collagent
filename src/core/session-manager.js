import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Session } from './session.js';
import { sessionCode } from './ids.js';
import { buildRoomSummary } from './room-summary.js';
import { createStore } from '../store/index.js';

const EVENT_CACHE = Number(process.env.COLLAGENT_EVENT_CACHE ?? 5000);

export class SessionManager {
  constructor({ dataDir = defaultDataDir(), databaseUrl, eventCache = EVENT_CACHE } = {}) {
    this.dataDir = dataDir;
    this.eventCache = eventCache;
    this.sessions = new Map();
    this.store = createStore({ dataDir, ...(databaseUrl !== undefined ? { databaseUrl } : {}) });
  }

  /** The database is authoritative on postgres; local files elsewhere. */
  get authoritative() {
    return this.store.backend === 'postgres';
  }

  async restore() {
    await this.store.ready?.();
    if (this.authoritative) return this._restoreFromStore();
    return this._restoreFromFiles();
  }

  async _restoreFromStore() {
    const metaByCode = await this.store.loadAllMeta();
    let restored = 0;
    for (const [code, meta] of metaByCode) {
      if (this.sessions.has(code) || meta.lifecycle === 'ended') continue;
      const session = new Session({ code, agentType: meta.agentType ?? 'unknown', persistPath: null });

      // Fold the room's history in pages: summary facts survive in the seed,
      // only the tail stays in memory.
      let seed = null;
      const tail = [];
      let since = 0;
      let ended = false;
      for (;;) {
        const batch = (await this.store.readEvents(code, { since, limit: 1000 })) ?? [];
        if (!batch.length) break;
        if (batch.some((e) => e.kind === 'session_ended')) { ended = true; break; }
        tail.push(...batch);
        since = batch.at(-1).seq;
        if (tail.length > this.eventCache) {
          seed = buildRoomSummary(tail.splice(0, tail.length - this.eventCache), seed);
        }
        if (batch.length < 1000) break;
      }
      if (ended) continue;

      session.log.seed(tail);
      session._summarySeed = seed;
      session.applyMeta(meta);
      this._finishRestore(session);
      restored++;
    }
    return restored;
  }

  _restoreFromFiles() {
    if (!this.dataDir) return 0;
    const metaByCode = this.store.loadAllMeta();
    const dir = path.join(this.dataDir, 'history');
    let restored = 0;
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return 0;
    }
    for (const file of files) {
      const code = path.basename(file, '.jsonl').toUpperCase();
      if (this.sessions.has(code)) continue;
      const entries = [];
      try {
        for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
          if (line.trim()) entries.push(JSON.parse(line));
        }
      } catch {
        continue;
      }
      if (!entries.length || entries.some((e) => e.kind === 'session_ended')) continue;
      const meta = metaByCode.get(code);
      if (meta?.lifecycle === 'ended') continue;

      const created = entries.find((e) => e.kind === 'session_created');
      const session = new Session({
        code,
        agentType: created?.data?.agentType ?? 'unknown',
        persistPath: path.join(dir, file),
      });
      session.log.seed(entries);
      if (meta) session.applyMeta(meta);
      this.store.importEvents(code, entries);
      this._finishRestore(session);
      restored++;
    }
    return restored;
  }

  _finishRestore(session) {
    const lastMode = [...session.log.events].reverse().find((e) => e.kind === 'mode_changed');
    if (lastMode) session.mode = lastMode.data.mode;

    // Legacy rooms predate AgentSession meta: reconstruct the primary agent
    // from history so `open` can resume it.
    if (!session.agentSessions.size && session.agentType !== 'unknown') {
      session.addAgentSession({
        adapterType: session.agentType,
        nativeSessionId: session.lastAgentSessionId(),
      }).markDetached();
    }

    this._wire(session);
    this.saveMeta(session);
    this.sessions.set(session.code, session);
  }

  create({ agentType }) {
    let code;
    do {
      code = sessionCode();
    } while (this.sessions.has(code));
    // On postgres the database is the source of truth — no local mirror file.
    const persistPath = this.dataDir && !this.authoritative
      ? path.join(this.dataDir, 'history', `${code}.jsonl`)
      : null;
    const session = new Session({ code, agentType, persistPath });
    this._wire(session);
    session.append('session_created', { type: 'system', name: 'collagent' }, { code, agentType });
    this.sessions.set(code, session);
    return session;
  }

  _wire(session) {
    session.log.onAppend = (entry) => this.store.appendEvent(session.code, entry);
    // Bound in-memory history whenever the store can serve the trimmed prefix.
    if (this.authoritative || this.store.backend === 'sqlite') {
      session.applyEventCache(this.eventCache, (since, limit) =>
        this.store.readEvents(session.code, { since, limit }));
    }
  }

  /** Persist a room's durable state (agent sessions, participants, keys, lifecycle). */
  saveMeta(session) {
    this.store.saveMeta(session.code, session.meta());
  }

  get(code) {
    return this.sessions.get(String(code).toUpperCase()) ?? null;
  }

  end(code) {
    const session = this.get(code);
    if (session) {
      session.lifecycle = 'ended';
      this.saveMeta(session);
      this.sessions.delete(session.code);
    }
    return session;
  }

  // Remove a room's persisted history. Returns true if anything was deleted.
  deleteHistory(code) {
    this.store.deleteRoom(code);
    if (!this.dataDir) return this.authoritative;
    const file = path.join(this.dataDir, 'history', `${String(code).toUpperCase()}.jsonl`);
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      return this.authoritative;
    }
  }

  list() {
    return [...this.sessions.values()];
  }

  close() {
    return this.store.close();
  }
}

export function defaultDataDir() {
  return process.env.COLLAGENT_DATA_DIR || path.join(os.homedir(), '.collagent');
}
