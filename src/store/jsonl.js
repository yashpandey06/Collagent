import fs from 'node:fs';
import path from 'node:path';

/**
 * Persistence without SQLite or Postgres: plain JSON files. Room meta, users
 * and workspaces stay durable (0600 — they carry secrets); event indexing is
 * not available on this backend — readEvents returns null and callers fall
 * back to the in-memory log + per-room JSONL history files.
 */
export class JsonlMetaStore {
  backend = 'jsonl';

  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'rooms-meta.json');
    this.usersFile = path.join(dataDir, 'users.json');
    this.workspacesFile = path.join(dataDir, 'workspaces.json');
  }

  ready() {}
  ping() { return true; }

  _read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  }

  _write(file, all) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
    } catch { /* persistence is best-effort; the session stays live */ }
  }

  // ---- rooms ---------------------------------------------------------------

  loadAllMeta() {
    const all = this._read(this.file);
    return new Map(Object.entries(all).map(([code, meta]) => [code.toUpperCase(), meta]));
  }

  saveMeta(code, meta) {
    const all = this._read(this.file);
    all[String(code).toUpperCase()] = meta;
    this._write(this.file, all);
  }

  deleteRoom(code) {
    const all = this._read(this.file);
    delete all[String(code).toUpperCase()];
    this._write(this.file, all);
  }

  appendEvent() {}
  importEvents() {}
  readEvents() { return null; }
  saveTurn() {}

  // ---- users & workspaces ----------------------------------------------------

  createUser({ id, name, tokenHash }) {
    const users = this._read(this.usersFile);
    users[id] = { id, name, tokenHash, createdAt: Date.now() };
    this._write(this.usersFile, users);
    return { id, name };
  }

  getUser(id) {
    const u = this._read(this.usersFile)[id];
    return u ? { id: u.id, name: u.name } : null;
  }

  getUserByTokenHash(tokenHash) {
    for (const u of Object.values(this._read(this.usersFile))) {
      if (u.tokenHash === tokenHash) return { id: u.id, name: u.name };
    }
    return null;
  }

  ensureWorkspace({ id, name, ownerId }) {
    const all = this._read(this.workspacesFile);
    all[id] ??= { id, name, createdBy: ownerId, members: {} };
    all[id].members[ownerId] ??= 'owner';
    this._write(this.workspacesFile, all);
    return { id, name };
  }

  addMember(workspaceId, userId, role = 'member') {
    const all = this._read(this.workspacesFile);
    if (!all[workspaceId]) return;
    all[workspaceId].members[userId] ??= role;
    this._write(this.workspacesFile, all);
  }

  listWorkspacesFor(userId) {
    return Object.values(this._read(this.workspacesFile))
      .filter((w) => w.members[userId])
      .map((w) => ({ id: w.id, name: w.name, role: w.members[userId] }));
  }

  isMember(workspaceId, userId) {
    return Boolean(this._read(this.workspacesFile)[workspaceId]?.members[userId]);
  }

  roomCodesForUser(userId) {
    const workspaces = new Set(this.listWorkspacesFor(userId).map((w) => w.id));
    const codes = [];
    for (const [code, meta] of this.loadAllMeta()) {
      const member = meta.workspaceId && workspaces.has(meta.workspaceId);
      const sat = (meta.participants ?? []).some((p) => p.userId === userId);
      if (member || sat) codes.push(code);
    }
    return codes;
  }

  close() {}
}
