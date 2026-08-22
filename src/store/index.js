import { JsonlMetaStore } from './jsonl.js';

/**
 * Persistence behind the SessionManager. Two responsibilities:
 *
 *   meta   — durable rooms, agent sessions, participants, join keys
 *   events — an indexed, search-ready copy of the event stream
 *
 * The per-room JSONL history files remain the canonical event mirror (they
 * power offline listing and are never rewritten or deleted here). SQLite is
 * the preferred backend for everything else; when node:sqlite is unavailable
 * (Node < 22.5) a JSON meta file keeps rooms durable, minus event indexing.
 * COLLAGENT_STORE=jsonl forces the fallback.
 */
let SqliteStore = null;
try {
  ({ SqliteStore } = await import('./sqlite.js')); // throws when node:sqlite is unavailable
} catch { /* Node < 22.5 — JSON meta fallback below */ }

export function createStore({ dataDir }) {
  if (!dataDir) return new NullStore();
  if (SqliteStore && process.env.COLLAGENT_STORE !== 'jsonl') {
    try {
      return new SqliteStore({ dataDir });
    } catch { /* unreadable/corrupt db — fall back rather than fail boot */ }
  }
  return new JsonlMetaStore({ dataDir });
}

/** No persistence (dataDir: null — tests, ephemeral servers). */
export class NullStore {
  backend = 'memory';
  loadAllMeta() { return new Map(); }
  saveMeta() {}
  deleteRoom() {}
  appendEvent() {}
  importEvents() {}
  readEvents() { return null; }
  close() {}
}
