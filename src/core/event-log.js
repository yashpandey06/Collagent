import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only, seq-numbered event log; optionally mirrored to a JSONL file
 * and to an extra sink (the indexed store) via onAppend.
 */
export class EventLog {
  constructor({ persistPath = null } = {}) {
    this.events = [];
    this.seq = 0;
    this.persistPath = persistPath;
    this.onAppend = null;
    if (persistPath) {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    }
  }

  // Seed from persisted entries without re-writing them to disk.
  seed(entries) {
    this.events = [...entries];
    this.seq = entries.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
  }

  append(event) {
    const entry = { seq: ++this.seq, ts: Date.now(), ...event };
    this.events.push(entry);
    if (this.persistPath) {
      // best-effort: disk issues must never break the session
      try {
        fs.appendFileSync(this.persistPath, JSON.stringify(entry) + '\n');
      } catch {
        /* ignore */
      }
    }
    try { this.onAppend?.(entry); } catch { /* index sink is best-effort too */ }
    return entry;
  }

  since(seq = 0) {
    if (seq <= 0) return [...this.events];
    return this.events.filter((e) => e.seq > seq);
  }

  get length() {
    return this.events.length;
  }
}
