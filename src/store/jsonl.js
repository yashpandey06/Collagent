import fs from 'node:fs';
import path from 'node:path';

/**
 * Meta persistence without SQLite: one JSON file mapping room code → meta
 * (join keys, agent sessions, participants, lifecycle). Contains secrets, so
 * it is written 0600. Event indexing is not available on this backend —
 * readEvents returns null and callers fall back to the in-memory log.
 */
export class JsonlMetaStore {
  backend = 'jsonl';

  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'rooms-meta.json');
  }

  _readAll() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  _writeAll(all) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
    } catch { /* persistence is best-effort; the session stays live */ }
  }

  loadAllMeta() {
    const all = this._readAll();
    return new Map(Object.entries(all).map(([code, meta]) => [code.toUpperCase(), meta]));
  }

  saveMeta(code, meta) {
    const all = this._readAll();
    all[String(code).toUpperCase()] = meta;
    this._writeAll(all);
  }

  deleteRoom(code) {
    const all = this._readAll();
    delete all[String(code).toUpperCase()];
    this._writeAll(all);
  }

  appendEvent() {}
  importEvents() {}
  readEvents() { return null; }
  close() {}
}
