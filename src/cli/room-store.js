import path from 'node:path';
import { defaultDataDir } from '../core/session-manager.js';
import { readSecretJson, writeSecretJson } from './secret-store.js';

function file() {
  return path.join(defaultDataDir(), 'rooms.json');
}

export function loadRoomState(code) {
  return readSecretJson(file())?.[String(code).toUpperCase()] ?? null;
}

export function saveRoomState(code, state) {
  const all = readSecretJson(file()) ?? {};
  all[String(code).toUpperCase()] = { ...all[String(code).toUpperCase()], ...state, updatedAt: Date.now() };
  try {
    writeSecretJson(file(), all);
  } catch { /* non-fatal */ }
}
