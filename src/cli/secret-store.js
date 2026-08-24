import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { defaultDataDir } from '../core/session-manager.js';

const SERVICE = 'collagent';
let cached = null;

function keychainGet() {
  try {
    const out = execFileSync(
      'security', ['find-generic-password', '-s', SERVICE, '-a', 'master', '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    return /^[0-9a-f]{64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

function keychainSet(hex) {
  try {
    execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', 'master', '-w', hex, '-U'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function masterKey() {
  if (cached) return cached;
  const env = process.env.COLLAGENT_MASTER_KEY;
  if (env && /^[0-9a-f]{64}$/.test(env)) return (cached = Buffer.from(env, 'hex'));

  if (process.platform === 'darwin') {
    const existing = keychainGet();
    if (existing) return (cached = Buffer.from(existing, 'hex'));
    const fresh = randomBytes(32);
    if (keychainSet(fresh.toString('hex'))) return (cached = fresh);
  }

  const file = path.join(defaultDataDir(), 'master.key');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return (cached = Buffer.from(hex, 'hex'));
  } catch {}
  const fresh = randomBytes(32);
  fs.mkdirSync(defaultDataDir(), { recursive: true });
  fs.writeFileSync(file, fresh.toString('hex') + '\n', { mode: 0o600 });
  return (cached = fresh);
}

export function readSecretJson(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(`${file}.enc`, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSecretJson(file, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.enc`, JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }), { mode: 0o600 });
  try { fs.unlinkSync(file); } catch {}
}
