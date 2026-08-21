import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Cursor CLI chat-store tailing. Cursor persists every session to
 * ~/.cursor/chats/<md5(cwd)>/<chatId>/store.db — a SQLite `blobs` table of
 * JSON message records ({role, content}) plus a hex-encoded `meta` row
 * carrying the chat id and name. Current CLI builds ship hooks.json support
 * in the bundle but never execute it (verified live), so tailing this store
 * is how a Cursor room stays transparent — the same pattern claude-native
 * uses with Claude Code's transcript file.
 */

export const chatsDirFor = (cwd, home = os.homedir()) =>
  path.join(home, '.cursor', 'chats', createHash('md5').update(path.resolve(cwd)).digest('hex'));

/**
 * One store blob → zero or more normalized events. Reasoning blocks are
 * private and never mirrored; an assistant record with prose and no tool
 * calls ends the turn. Pure, exported for tests.
 */
export function extractBlobEvents(record) {
  const { role, content } = record ?? {};
  const events = [];

  if (role === 'assistant' && Array.isArray(content)) {
    let text = '';
    const tools = [];
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) text += (text ? '\n' : '') + block.text;
      else if (block.type === 'tool-call') tools.push(block);
    }
    if (text) events.push({ kind: 'agent_message', text });
    for (const t of tools) {
      events.push({ kind: 'tool_use', tool: t.toolName ?? 'tool', input: compact(t.args) });
    }
    if (text && !tools.length) {
      events.push({ kind: 'result', ok: true });
      events.push({ kind: 'agent_status', status: 'idle' });
    }
  } else if (role === 'tool' && Array.isArray(content)) {
    for (const block of content) {
      if (block.type !== 'tool-result') continue;
      const summary = typeof block.result === 'string' ? block.result : JSON.stringify(block.result ?? '');
      events.push({
        kind: 'tool_result',
        tool: block.toolName,
        summary: compact(summary, 200),
        isError: /^Exit code: (?!0\b)/.test(summary),
      });
    }
  } else if (role === 'user' && Array.isArray(content)) {
    // real prompts arrive wrapped in <user_query>; other user records are
    // injected context (user_info, system reminders) and stay out of the room
    for (const block of content) {
      if (block.type !== 'text') continue;
      const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(block.text ?? '');
      if (!m) continue;
      events.push({ kind: 'agent_status', status: 'working' });
      events.push({ kind: 'local_prompt', text: m[1] });
    }
  }
  return events;
}

/**
 * Polls the chat store and emits normalized events. Attaches to the chat the
 * launched CLI creates (or the one being resumed), survives the db not
 * existing yet, and follows the newest chat if the host starts a new one
 * inside Cursor's UI.
 */
export class CursorChatTail {
  constructor({ cwd, home, sessionId = null, resume = false, onEvent, intervalMs = 700 }) {
    this.chatsDir = chatsDirFor(cwd, home);
    this.sessionId = sessionId;
    this.resume = resume;
    this.onEvent = onEvent;
    this.intervalMs = intervalMs;
    this.sinceMs = Date.now();
    this.db = null;
    this.dir = null;
    this.dirBirth = 0;
    this.lastRowid = 0;
    this._timer = null;
    this._sqlite = null;
  }

  async start() {
    try {
      this._sqlite = await import('node:sqlite');
    } catch {
      this.onEvent({
        kind: 'notice',
        message: 'cursor transparency needs Node 22.5+ (node:sqlite) — room will not see replies',
      });
      return;
    }
    this._timer = setInterval(() => this._poll(), this.intervalMs);
    this._poll();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
  }

  _poll() {
    try {
      if (!this.db) this._attach();
      else this._switchIfNewerChat();
      if (!this.db) return;

      const rows = this.db
        .prepare('SELECT rowid, data FROM blobs WHERE rowid > ? ORDER BY rowid')
        .all(this.lastRowid);
      for (const row of rows) {
        this.lastRowid = row.rowid;
        const buf = Buffer.from(row.data);
        if (buf[0] !== 0x7b) continue; // binary snapshot blobs, not messages
        let record;
        try {
          record = JSON.parse(buf.toString('utf8'));
        } catch {
          continue;
        }
        for (const event of extractBlobEvents(record)) this.onEvent(event);
      }
    } catch {
      // db mid-write or gone — reattach on a later tick
      try { this.db?.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }

  _candidateDirs() {
    let names;
    try {
      names = fs.readdirSync(this.chatsDir);
    } catch {
      return [];
    }
    const dirs = [];
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(this.chatsDir, name));
        if (st.isDirectory()) dirs.push({ name, birth: st.birthtimeMs || st.mtimeMs });
      } catch { /* raced away */ }
    }
    return dirs.sort((a, b) => b.birth - a.birth);
  }

  _attach() {
    let target = null;
    if (this.sessionId) {
      target = { name: this.sessionId, birth: 0 };
    } else {
      // the chat the CLI we just launched created; allow slight clock slack
      target = this._candidateDirs().find((d) => d.birth >= this.sinceMs - 10_000) ?? null;
    }
    if (!target) return;
    this._open(target);
  }

  // The host can start a fresh chat inside Cursor's UI; follow it.
  _switchIfNewerChat() {
    const newest = this._candidateDirs()[0];
    if (newest && newest.name !== this.dir && newest.birth > this.dirBirth) {
      try { this.db?.close(); } catch { /* ignore */ }
      this.db = null;
      this._open(newest, { fresh: true });
    }
  }

  _open(target, { fresh = false } = {}) {
    const dbPath = path.join(this.chatsDir, target.name, 'store.db');
    if (!fs.existsSync(dbPath)) return;
    this.db = new this._sqlite.DatabaseSync(dbPath, { readOnly: true });
    this.dir = target.name;
    this.dirBirth = target.birth;
    // resuming replays nothing: history is already in the room's event log
    this.lastRowid = this.resume && !fresh
      ? (this.db.prepare('SELECT COALESCE(MAX(rowid), 0) m FROM blobs').get()?.m ?? 0)
      : 0;

    this.onEvent({ kind: 'agent_status', status: 'ready', detail: { sessionId: this.dir } });
    const title = this._metaName(target.name);
    if (title) this.onEvent({ kind: 'session_title', title });
  }

  _metaName(dirName) {
    try {
      const metaFile = path.join(this.chatsDir, dirName, 'meta.json');
      if (fs.existsSync(metaFile)) {
        return JSON.parse(fs.readFileSync(metaFile, 'utf8'))?.name ?? null;
      }
      const raw = this.db.prepare('SELECT value FROM meta LIMIT 1').get()?.value;
      return raw ? JSON.parse(Buffer.from(raw, 'hex').toString('utf8'))?.name ?? null : null;
    } catch {
      return null;
    }
  }
}

function compact(value, max = 400) {
  let s;
  if (typeof value === 'string') s = value;
  else {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  }
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
