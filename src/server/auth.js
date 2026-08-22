import { createHash, randomBytes } from 'node:crypto';
import { sanitizeName } from '../core/sanitize.js';

/**
 * Token identity for the hosted backend. Personal access tokens are minted
 * once, shown once, and stored only as a SHA-256 hash — the database never
 * holds a usable credential. Loopback development skips all of this.
 */
export function mintToken() {
  return `cgt_${randomBytes(24).toString('hex')}`;
}

export function hashToken(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}

/** Register a user + their personal workspace; returns the one-time token. */
export async function registerUser(store, { name }) {
  const cleanName = sanitizeName(name) || 'user';
  const id = `u_${randomBytes(8).toString('hex')}`;
  const token = mintToken();
  await store.createUser({ id, name: cleanName, tokenHash: hashToken(token) });
  const workspace = await store.ensureWorkspace({
    id: `ws_${id.slice(2)}`,
    name: `${cleanName}'s workspace`,
    ownerId: id,
  });
  return { userId: id, name: cleanName, token, workspaceId: workspace.id };
}

/** Resolve a bearer token (or {token} auth payload) to a user, or null. */
export async function resolveUser(store, token) {
  if (!token || typeof token !== 'string' || !token.startsWith('cgt_')) return null;
  return (await store.getUserByTokenHash(hashToken(token))) ?? null;
}

/** A user's personal workspace id (created at registration). */
export const personalWorkspaceId = (userId) => `ws_${String(userId).replace(/^u_/, '')}`;
