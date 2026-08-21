import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from '../core/session-manager.js';

/**
 * Per-room local memory: this user's identity in each room and how far they
 * have read (lastSeenSeq). Powers resume-as-the-same-person, the
 * "YOU JOINED HERE" divider, and the returning-user catch-up.
 */
function file() {
  return path.join(defaultDataDir(), 'rooms.json');
}

export function loadRoomState(code) {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'))[String(code).toUpperCase()] ?? null;
  } catch {
    return null;
  }
}

export function saveRoomState(code, state) {
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch { /* first write */ }
  all[String(code).toUpperCase()] = { ...all[String(code).toUpperCase()], ...state, updatedAt: Date.now() };
  try {
    fs.mkdirSync(defaultDataDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
  } catch { /* non-fatal */ }
}
