import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite persistence (node:sqlite, Node ≥ 22.5): durable room meta plus an
 * indexed copy of every event, queryable by room / kind / agent / turn.
 * JSONL history files are imported once per room (idempotent, files kept).
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
    `);
    this._insertEvent = this.db.prepare(
      'INSERT OR IGNORE INTO events (code, seq, ts, kind, agent_id, turn_id, json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this._upsertMeta = this.db.prepare(
      'INSERT INTO rooms (code, meta) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET meta = excluded.meta',
    );
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

  readEvents(code, { since = 0, limit = 500 } = {}) {
    try {
      return this.db
        .prepare('SELECT json FROM events WHERE code = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(String(code).toUpperCase(), since, limit)
        .map((row) => JSON.parse(row.json));
    } catch {
      return null;
    }
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
