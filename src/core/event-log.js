import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only, sequence-numbered event log for one session.
 * Holds events in memory for replay/sync and optionally mirrors each
 * event to a JSONL file so history survives for auditing.
 */
export class EventLog {
  constructor({ persistPath = null } = {}) {
    this.events = [];
    this.seq = 0;
    this.persistPath = persistPath;
    if (persistPath) {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    }
  }

  /** Seed from persisted entries without re-writing them to disk. */
  seed(entries) {
    this.events = [...entries];
    this.seq = entries.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
  }

  append(event) {
    const entry = { seq: ++this.seq, ts: Date.now(), ...event };
    this.events.push(entry);
    if (this.persistPath) {
      // Best-effort persistence; never let disk issues break the session.
      try {
        fs.appendFileSync(this.persistPath, JSON.stringify(entry) + '\n');
      } catch {
        /* ignore */
      }
    }
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
