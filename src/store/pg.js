import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * PostgreSQL persistence — the production source of truth. Reads go straight
 * to the pool; writes flow through one ordered queue per store so event
 * sequence order on disk matches the in-memory log. File-based migrations
 * (migrations/*.sql) run once each at boot, tracked in schema_migrations.
 */
export class PgStore {
  backend = 'postgres';

  constructor({ databaseUrl, poolSize = 10 }) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: poolSize,
      idleTimeoutMillis: 30_000,
    });
    this.pool.on('error', () => { /* a dropped idle client must not kill the server */ });
    this._chain = Promise.resolve();
    this._readyPromise = null;
  }

  ready() {
    this._readyPromise ??= this._migrate();
    return this._readyPromise;
  }

  async _migrate() {
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)',
    );
    const applied = new Set(
      (await this.pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [file, Date.now()]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${file} failed: ${err.message}`);
      } finally {
        client.release();
      }
    }
  }

  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  // Ordered write queue: persistence errors are logged by omission, never
  // thrown into the live session path.
  _enqueue(op) {
    this._chain = this._chain.then(op).catch(() => {});
    return this._chain;
  }

  // ---- rooms ---------------------------------------------------------------

  async loadAllMeta() {
    await this.ready();
    const rows = (await this.pool.query('SELECT code, meta FROM rooms')).rows;
    return new Map(rows.map((r) => [r.code, r.meta]));
  }

  saveMeta(code, meta) {
    const c = String(code).toUpperCase();
    return this._enqueue(async () => {
      await this.pool.query(
        `INSERT INTO rooms (code, workspace_id, meta, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET workspace_id = $2, meta = $3, updated_at = $4`,
        [c, meta.workspaceId ?? null, meta, Date.now()],
      );
      await this.pool.query('DELETE FROM agent_sessions WHERE room_code = $1', [c]);
      for (const a of meta.agentSessions ?? []) {
        await this.pool.query(
          `INSERT INTO agent_sessions (id, room_code, agent_id, runtime, adapter_type, status, host_id, native_session_id, created_at, attached_at, detached_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
          [a.id, c, a.agentId, a.runtime, a.adapterType, a.status, a.hostId, a.nativeSessionId, a.createdAt, a.attachedAt, a.detachedAt],
        );
      }
    });
  }

  deleteRoom(code) {
    const c = String(code).toUpperCase();
    return this._enqueue(async () => {
      await this.pool.query('DELETE FROM events WHERE code = $1', [c]);
      await this.pool.query('DELETE FROM turns WHERE room_code = $1', [c]);
      await this.pool.query('DELETE FROM agent_sessions WHERE room_code = $1', [c]);
      await this.pool.query('DELETE FROM rooms WHERE code = $1', [c]);
    });
  }

  // ---- events ----------------------------------------------------------------

  appendEvent(code, entry) {
    const c = String(code).toUpperCase();
    return this._enqueue(() => this.pool.query(
      `INSERT INTO events (code, seq, ts, kind, agent_id, turn_id, participant_id, json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [c, entry.seq, entry.ts ?? null, entry.kind ?? null, entry.agentId ?? null,
        entry.turnId ?? null, participantOf(entry), entry],
    ));
  }

  async importEvents(code, entries) {
    const c = String(code).toUpperCase();
    await this.ready();
    const { rows } = await this.pool.query('SELECT COUNT(*)::int AS n FROM events WHERE code = $1', [c]);
    if (rows[0].n >= entries.length) return;
    for (const entry of entries) await this.appendEvent(c, entry);
    await this._chain;
  }

  async readEvents(code, { since = 0, limit = 500, kind, agentId, turnId, participantId, afterTs } = {}) {
    await this.ready();
    const where = ['code = $1', 'seq > $2'];
    const params = [String(code).toUpperCase(), since];
    const add = (clause, value) => {
      params.push(value);
      where.push(`${clause} $${params.length}`);
    };
    if (kind) add('kind =', kind);
    if (agentId) add('agent_id =', agentId);
    if (turnId) add('turn_id =', turnId);
    if (participantId) add('participant_id =', participantId);
    if (afterTs) add('ts >=', afterTs);
    params.push(Math.min(limit, 1000));
    const { rows } = await this.pool.query(
      `SELECT json FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => r.json);
  }

  // ---- turns / usage ---------------------------------------------------------

  saveTurn(code, turn) {
    const u = turn.usage ?? {};
    return this._enqueue(() => this.pool.query(
      `INSERT INTO turns (room_code, turn_id, agent_session_id, agent_id, ok, duration_ms, tool_calls,
                          provider, runtime, model, input_tokens, output_tokens, cache_read_tokens,
                          cache_write_tokens, provider_cost, currency, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (room_code, turn_id) DO NOTHING`,
      [String(code).toUpperCase(), turn.turnId, turn.agentSessionId ?? null, turn.agentId ?? null,
        turn.ok ?? null, turn.durationMs ?? null, turn.toolCalls ?? null,
        u.provider ?? null, u.runtime ?? null, u.model ?? null,
        u.inputTokens ?? null, u.outputTokens ?? null, u.cacheReadTokens ?? null,
        u.cacheWriteTokens ?? null, u.providerCost ?? null, u.currency ?? null, Date.now()],
    ));
  }

  // ---- users & workspaces ------------------------------------------------------

  async createUser({ id, name, tokenHash }) {
    await this.ready();
    await this.pool.query(
      'INSERT INTO users (id, name, token_hash, created_at) VALUES ($1,$2,$3,$4)',
      [id, name, tokenHash, Date.now()],
    );
    return { id, name };
  }

  async getUser(id) {
    const { rows } = await this.pool.query('SELECT id, name FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async getUserByTokenHash(tokenHash) {
    const { rows } = await this.pool.query('SELECT id, name FROM users WHERE token_hash = $1', [tokenHash]);
    return rows[0] ?? null;
  }

  async ensureWorkspace({ id, name, ownerId }) {
    await this.pool.query(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
      [id, name, ownerId, Date.now()],
    );
    await this.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES ($1,$2,'owner',$3)
       ON CONFLICT DO NOTHING`,
      [id, ownerId, Date.now()],
    );
    return { id, name };
  }

  async addMember(workspaceId, userId, role = 'member') {
    await this.pool.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [workspaceId, userId, role, Date.now()],
    );
  }

  async listWorkspacesFor(userId) {
    const { rows } = await this.pool.query(
      `SELECT w.id, w.name, m.role FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = $1`,
      [userId],
    );
    return rows;
  }

  async isMember(workspaceId, userId) {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    return rows.length > 0;
  }

  /** Rooms visible to a user: their workspaces' rooms + rooms they sat in. */
  async roomCodesForUser(userId) {
    const { rows } = await this.pool.query(
      `SELECT code FROM rooms
       WHERE workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $1)
          OR meta->'participants' @> $2::jsonb`,
      [userId, JSON.stringify([{ userId }])],
    );
    return rows.map((r) => r.code);
  }

  async close() {
    await this._chain.catch(() => {});
    await this.pool.end().catch(() => {});
  }
}

const participantOf = (entry) =>
  (entry.actor?.type === 'user' ? entry.actor.id ?? null : null);
