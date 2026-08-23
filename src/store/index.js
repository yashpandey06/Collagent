import { JsonlMetaStore } from './jsonl.js';

/**
 * Persistence behind the SessionManager — one repository surface, three
 * backends:
 *
 *   postgres — production source of truth (DATABASE_URL / COLLAGENT_DATABASE_URL)
 *   sqlite   — local default on Node ≥ 22.5 (node:sqlite)
 *   jsonl    — plain-file fallback (COLLAGENT_STORE=jsonl, or old Node)
 *
 * The per-room JSONL history files remain a local event mirror on the sqlite
 * and jsonl backends (they power offline listing and are never rewritten or
 * deleted here); on postgres the database is authoritative and no local
 * mirror is written.
 */
let SqliteStore = null;
try {
  ({ SqliteStore } = await import('./sqlite.js')); // throws when node:sqlite is unavailable
} catch { /* Node < 22.5 — JSON meta fallback below */ }

export function createStore({ dataDir, databaseUrl = defaultDatabaseUrl() }) {
  if (databaseUrl) {
    // Lazy import keeps `pg` out of the require path for pure-local use.
    return new LazyPgStore({ databaseUrl });
  }
  if (!dataDir) return new NullStore();
  if (SqliteStore && process.env.COLLAGENT_STORE !== 'jsonl') {
    try {
      return new SqliteStore({ dataDir });
    } catch { /* unreadable/corrupt db — fall back rather than fail boot */ }
  }
  return new JsonlMetaStore({ dataDir });
}

export function defaultDatabaseUrl() {
  return process.env.COLLAGENT_DATABASE_URL || process.env.DATABASE_URL || null;
}

/** Defers the pg import to ready() so constructing the manager stays sync. */
class LazyPgStore {
  backend = 'postgres';

  constructor({ databaseUrl }) {
    this.databaseUrl = databaseUrl;
    this._store = null;
    this._readyPromise = null;
  }

  ready() {
    this._readyPromise ??= import('./pg.js').then(({ PgStore }) => {
      this._store = new PgStore({ databaseUrl: this.databaseUrl });
      return this._store.ready();
    });
    return this._readyPromise;
  }

  _s() {
    if (!this._store) throw new Error('postgres store not ready — await manager.restore() first');
    return this._store;
  }

  ping() { return this._s().ping(); }
  loadAllMeta() { return this._s().loadAllMeta(); }
  saveMeta(code, meta) { return this._s().saveMeta(code, meta); }
  deleteRoom(code) { return this._s().deleteRoom(code); }
  appendEvent(code, entry) { return this._s().appendEvent(code, entry); }
  importEvents(code, entries) { return this._s().importEvents(code, entries); }
  readEvents(code, opts) { return this._s().readEvents(code, opts); }
  saveTurn(code, turn) { return this._s().saveTurn(code, turn); }
  createUser(u) { return this._s().createUser(u); }
  getUser(id) { return this._s().getUser(id); }
  getUserByTokenHash(h) { return this._s().getUserByTokenHash(h); }
  ensureWorkspace(w) { return this._s().ensureWorkspace(w); }
  addMember(w, u, r) { return this._s().addMember(w, u, r); }
  listWorkspacesFor(u) { return this._s().listWorkspacesFor(u); }
  isMember(w, u) { return this._s().isMember(w, u); }
  roomCodesForUser(u) { return this._s().roomCodesForUser(u); }
  close() { return this._store?.close(); }
}

/** In-memory persistence (dataDir: null — tests, ephemeral servers). */
export class NullStore {
  backend = 'memory';

  constructor() {
    this.users = new Map();
    this.workspaces = new Map();
  }

  ready() {}
  ping() { return true; }
  loadAllMeta() { return new Map(); }
  saveMeta() {}
  deleteRoom() {}
  appendEvent() {}
  importEvents() {}
  readEvents() { return null; }
  saveTurn() {}

  createUser({ id, name, tokenHash }) {
    this.users.set(id, { id, name, tokenHash });
    return { id, name };
  }

  getUser(id) {
    const u = this.users.get(id);
    return u ? { id: u.id, name: u.name } : null;
  }

  getUserByTokenHash(tokenHash) {
    for (const u of this.users.values()) {
      if (u.tokenHash === tokenHash) return { id: u.id, name: u.name };
    }
    return null;
  }

  ensureWorkspace({ id, name, ownerId }) {
    const w = this.workspaces.get(id) ?? { id, name, members: new Map() };
    w.members.set(ownerId, 'owner');
    this.workspaces.set(id, w);
    return { id, name };
  }

  addMember(workspaceId, userId, role = 'member') {
    const w = this.workspaces.get(workspaceId);
    if (w && !w.members.has(userId)) w.members.set(userId, role);
  }

  listWorkspacesFor(userId) {
    return [...this.workspaces.values()]
      .filter((w) => w.members.has(userId))
      .map((w) => ({ id: w.id, name: w.name, role: w.members.get(userId) }));
  }

  isMember(workspaceId, userId) {
    return Boolean(this.workspaces.get(workspaceId)?.members.has(userId));
  }

  roomCodesForUser() { return []; }
  close() {}
}
