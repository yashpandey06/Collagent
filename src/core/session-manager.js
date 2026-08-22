import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Session } from './session.js';
import { sessionCode } from './ids.js';
import { createStore } from '../store/index.js';

export class SessionManager {
  constructor({ dataDir = defaultDataDir() } = {}) {
    this.dataDir = dataDir;
    this.sessions = new Map();
    this.store = createStore({ dataDir });
  }

  restore() {
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
      const lastMode = [...entries].reverse().find((e) => e.kind === 'mode_changed');
      if (lastMode) session.mode = lastMode.data.mode;
      if (meta) session.applyMeta(meta);

      // Legacy rooms predate AgentSession meta: reconstruct the primary agent
      // from history so `open` can resume it.
      if (!session.agentSessions.size && session.agentType !== 'unknown') {
        session.addAgentSession({
          adapterType: session.agentType,
          nativeSessionId: session.lastAgentSessionId(),
        }).markDetached();
      }

      this._wire(session);
      this.store.importEvents(code, entries);
      this.saveMeta(session);
      this.sessions.set(code, session);
      restored++;
    }
    return restored;
  }

  create({ agentType }) {
    let code;
    do {
      code = sessionCode();
    } while (this.sessions.has(code));
    const persistPath = this.dataDir
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

  // Remove a room's persisted history. Returns true if a file was deleted.
  deleteHistory(code) {
    this.store.deleteRoom(code);
    if (!this.dataDir) return false;
    const file = path.join(this.dataDir, 'history', `${String(code).toUpperCase()}.jsonl`);
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  list() {
    return [...this.sessions.values()];
  }

  close() {
    this.store.close();
  }
}

export function defaultDataDir() {
  return process.env.COLLAGENT_DATA_DIR || path.join(os.homedir(), '.collagent');
}
