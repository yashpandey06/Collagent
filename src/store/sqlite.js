import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite persistence (node:sqlite, Node ≥ 22.5): the local-development
 * backend. Same repository surface as PgStore — durable room meta, indexed
 * events, turns, users and workspaces — synchronous under the hood, so every
 * method is also safe to await. JSONL history files are imported once per
 * room (idempotent, files kept).
 */
export class SqliteStore {
  backend = 'sqlite';

  constructor({ dataDir }) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'collagent.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        meta TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        code     TEXT NOT NULL,
        seq      INTEGER NOT NULL,
        ts       INTEGER,
        kind     TEXT,
        agent_id TEXT,
        turn_id  TEXT,
        json     TEXT NOT NULL,
        PRIMARY KEY (code, seq)
      );
      CREATE INDEX IF NOT EXISTS events_by_kind ON events (code, kind);
      CREATE INDEX IF NOT EXISTS events_by_turn ON events (code, turn_id);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
        added_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS turns (
        room_code TEXT NOT NULL, turn_id TEXT NOT NULL, agent_session_id TEXT, agent_id TEXT,
        ok INTEGER, duration_ms INTEGER, tool_calls INTEGER,
        provider TEXT, runtime TEXT, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        provider_cost REAL, currency TEXT, completed_at INTEGER,
        PRIMARY KEY (room_code, turn_id)
      );
    `);
    // additive migration for databases created before participant queryability
    try { this.db.exec('ALTER TABLE events ADD COLUMN participant_id TEXT'); } catch { /* exists */ }
    this._insertEvent = this.db.prepare(
      'INSERT OR IGNORE INTO events (code, seq, ts, kind, agent_id, turn_id, participant_id, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this._upsertMeta = this.db.prepare(
      'INSERT INTO rooms (code, meta) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET meta = excluded.meta',
    );
  }

  ready() {}

  ping() {
    this.db.prepare('SELECT 1').get();
    return true;
  }

  loadAllMeta() {
    const rows = this.db.prepare('SELECT code, meta FROM rooms').all();
    const map = new Map();
    for (const row of rows) {
      try {
        map.set(row.code, JSON.parse(row.meta));
      } catch { /* skip a corrupt row rather than fail boot */ }
    }
    return map;
  }

  saveMeta(code, meta) {
    try {
      this._upsertMeta.run(String(code).toUpperCase(), JSON.stringify(meta));
    } catch { /* best-effort */ }
  }

  deleteRoom(code) {
    const c = String(code).toUpperCase();
    try {
      this.db.prepare('DELETE FROM rooms WHERE code = ?').run(c);
      this.db.prepare('DELETE FROM events WHERE code = ?').run(c);
      this.db.prepare('DELETE FROM turns WHERE room_code = ?').run(c);
    } catch { /* best-effort */ }
  }

  appendEvent(code, entry) {
    try {
      this._insertEvent.run(
        String(code).toUpperCase(),
        entry.seq,
        entry.ts ?? null,
        entry.kind ?? null,
        entry.agentId ?? null,
        entry.turnId ?? null,
        entry.actor?.type === 'user' ? entry.actor.id ?? null : null,
        JSON.stringify(entry),
      );
    } catch { /* an unwritable index never breaks the live session */ }
  }

  /** Idempotent bulk import of a room's JSONL history (migration path). */
  importEvents(code, entries) {
    const c = String(code).toUpperCase();
    try {
      const existing = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE code = ?').get(c);
      if (existing?.n >= entries.length) return;
      this.db.exec('BEGIN');
      try {
        for (const entry of entries) this.appendEvent(c, entry);
        this.db.exec('COMMIT');
      } catch {
        this.db.exec('ROLLBACK');
      }
    } catch { /* best-effort */ }
  }

  readEvents(code, { since = 0, limit = 500, kind, agentId, turnId, participantId, afterTs } = {}) {
    try {
      const where = ['code = ?', 'seq > ?'];
      const params = [String(code).toUpperCase(), since];
      if (kind) { where.push('kind = ?'); params.push(kind); }
      if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
      if (turnId) { where.push('turn_id = ?'); params.push(turnId); }
      if (participantId) { where.push('participant_id = ?'); params.push(participantId); }
      if (afterTs) { where.push('ts >= ?'); params.push(afterTs); }
      params.push(Math.min(limit, 1000));
      return this.db
        .prepare(`SELECT json FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`)
        .all(...params)
        .map((row) => JSON.parse(row.json));
    } catch {
      return null;
    }
  }

  saveTurn(code, turn) {
    const u = turn.usage ?? {};
    try {
      this.db.prepare(
        `INSERT OR IGNORE INTO turns (room_code, turn_id, agent_session_id, agent_id, ok, duration_ms, tool_calls,
          provider, runtime, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          provider_cost, currency, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        String(code).toUpperCase(), turn.turnId, turn.agentSessionId ?? null, turn.agentId ?? null,
        turn.ok == null ? null : Number(turn.ok), turn.durationMs ?? null, turn.toolCalls ?? null,
        u.provider ?? null, u.runtime ?? null, u.model ?? null,
        u.inputTokens ?? null, u.outputTokens ?? null, u.cacheReadTokens ?? null, u.cacheWriteTokens ?? null,
        u.providerCost ?? null, u.currency ?? null, Date.now(),
      );
    } catch { /* best-effort */ }
  }

  // ---- users & workspaces ----------------------------------------------------

  createUser({ id, name, tokenHash }) {
    this.db.prepare('INSERT INTO users (id, name, token_hash, created_at) VALUES (?,?,?,?)')
      .run(id, name, tokenHash, Date.now());
    return { id, name };
  }

  getUser(id) {
    return this.db.prepare('SELECT id, name FROM users WHERE id = ?').get(id) ?? null;
  }

  getUserByTokenHash(tokenHash) {
    return this.db.prepare('SELECT id, name FROM users WHERE token_hash = ?').get(tokenHash) ?? null;
  }

  ensureWorkspace({ id, name, ownerId }) {
    this.db.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_by, created_at) VALUES (?,?,?,?)')
      .run(id, name, ownerId, Date.now());
    this.db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, added_at) VALUES (?,?,'owner',?)")
      .run(id, ownerId, Date.now());
    return { id, name };
  }

  addMember(workspaceId, userId, role = 'member') {
    this.db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, added_at) VALUES (?,?,?,?)')
      .run(workspaceId, userId, role, Date.now());
  }

  listWorkspacesFor(userId) {
    return this.db.prepare(
      `SELECT w.id, w.name, m.role FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ?`,
    ).all(userId);
  }

  isMember(workspaceId, userId) {
    return Boolean(
      this.db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .get(workspaceId, userId),
    );
  }

  roomCodesForUser(userId) {
    // local scale: scan meta rather than maintain another index
    const workspaces = new Set(this.listWorkspacesFor(userId).map((w) => w.id));
    const codes = [];
    for (const [code, meta] of this.loadAllMeta()) {
      const member = meta.workspaceId && workspaces.has(meta.workspaceId);
      const sat = (meta.participants ?? []).some((p) => p.userId === userId);
      if (member || sat) codes.push(code);
    }
    return codes;
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
