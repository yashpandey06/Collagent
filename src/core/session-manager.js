import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Session } from './session.js';
import { sessionCode } from './ids.js';

export class SessionManager {
  constructor({ dataDir = defaultDataDir() } = {}) {
    this.dataDir = dataDir;
    this.sessions = new Map(); 
  }

  restore() {
    if (!this.dataDir) return 0;
    const dir = path.join(this.dataDir, 'history');
    let restored = 0;
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return 0;
    }
    for (const file of files) {
      const code = path.basename(file, '.jsonl').toUpperCase();
      if (this.sessions.has(code)) continue;
      const entries = [];
      try {
        for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
          if (line.trim()) entries.push(JSON.parse(line));
        }
      } catch {
        continue;
      }
      if (!entries.length || entries.some((e) => e.kind === 'session_ended')) continue;

      const created = entries.find((e) => e.kind === 'session_created');
      const session = new Session({
        code,
        agentType: created?.data?.agentType ?? 'claude-code',
        persistPath: path.join(dir, file),
      });
      session.log.seed(entries);
      session.status = 'waiting_agent';
      const lastMode = [...entries].reverse().find((e) => e.kind === 'mode_changed');
      if (lastMode) session.mode = lastMode.data.mode;
      this.sessions.set(code, session);
      restored++;
    }
    return restored;
  }

  create({ agentType }) {
    let code;
    do {
      code = sessionCode();
    } while (this.sessions.has(code));
    const persistPath = this.dataDir
      ? path.join(this.dataDir, 'history', `${code}.jsonl`)
      : null;
    const session = new Session({ code, agentType, persistPath });
    session.append('session_created', { type: 'system', name: 'collagent' }, { code, agentType });
    this.sessions.set(code, session);
    return session;
  }

  get(code) {
    return this.sessions.get(String(code).toUpperCase()) ?? null;
  }

  end(code) {
    const session = this.get(code);
    if (session) {
      session.status = 'ended';
      this.sessions.delete(session.code);
    }
    return session;
  }

  list() {
    return [...this.sessions.values()];
  }
}

export function defaultDataDir() {
  return process.env.COLLAGENT_DATA_DIR || path.join(os.homedir(), '.collagent');
}
