import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient } from '../src/client/client.js';
import { translateHookEvent } from '../src/adapters/claude/native.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-prod-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Hosted-mode servers treat every connection as remote and demand identity.
async function bootHosted(t, options = {}) {
  const server = createCollagentServer({
    trustLoopback: false,
    requireAuth: true,
    requireJoinKey: false,
    ...options,
  });
  const addr = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  return { server, addr, base: `http://127.0.0.1:${addr.port}`, serverUrl: `ws://127.0.0.1:${addr.port}` };
}

async function register(base, name) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

test('hosted mode: registration mints a token; identity gates create and join', async (t) => {
  // Full hosted posture: auth AND join keys required for every remote client.
  const { base, serverUrl } = await bootHosted(t, { dataDir: null, requireJoinKey: 'auto' });

  const anon = new CollagentClient({ serverUrl, name: 'Anon' });
  await anon.connect();
  await assert.rejects(() => anon.createSession({ agentType: 'mock' }), /authentication required/);
  anon.close();

  const account = await register(base, 'Alice');
  assert.match(account.token, /^cgt_/);
  assert.match(account.userId, /^u_/);
  assert.ok(account.workspaceId, 'a personal workspace comes with the account');

  const whoami = await fetch(`${base}/api/auth/whoami`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  assert.equal((await whoami.json()).id, account.userId);
  assert.equal((await fetch(`${base}/api/auth/whoami`)).status, 401);

  const alice = new CollagentClient({ serverUrl, name: 'Alice', auth: { token: account.token } });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  assert.equal(created.session.workspaceId, account.workspaceId, 'rooms land in the creator\'s workspace');

  // A second registered user without the key: not a member, never sat here → refused.
  const bobAccount = await register(base, 'Bob');
  const bob = new CollagentClient({ serverUrl, name: 'Bob', auth: { token: bobAccount.token } });
  await bob.connect();
  const stranger = await bootNothing();
  void stranger;
  await assert.rejects(
    () => bob.join(created.session.code),
    /join key/,
    'auth alone does not grant room access',
  );
  const welcome = await bob.join(created.session.code, { key: created.joinKey });
  assert.equal(welcome.session.code, created.session.code);

  // A dropped member keeps their seat: Bob disconnects (no leave) and gets
  // back in without the key. An explicit /quit would need a fresh invite.
  bob.close();
  await new Promise((r) => setTimeout(r, 50));
  const bob2 = new CollagentClient({ serverUrl, name: 'Bob-2', auth: { token: bobAccount.token } });
  await bob2.connect();
  const back = await bob2.join(created.session.code);
  assert.equal(back.session.code, created.session.code);
  bob2.close();
  alice.close();
});

async function bootNothing() { return null; }

test('room listing over HTTP is scoped to the authenticated user', async (t) => {
  const { base, serverUrl } = await bootHosted(t, { dataDir: tmpDir(t) });
  const aliceAccount = await register(base, 'Alice');
  const bobAccount = await register(base, 'Bob');

  const alice = new CollagentClient({ serverUrl, name: 'Alice', auth: { token: aliceAccount.token } });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });

  const asAlice = await (await fetch(`${base}/api/sessions`, {
    headers: { authorization: `Bearer ${aliceAccount.token}` },
  })).json();
  assert.ok(asAlice.some((r) => r.code === created.session.code), 'owner sees their room');

  const asBob = await (await fetch(`${base}/api/sessions`, {
    headers: { authorization: `Bearer ${bobAccount.token}` },
  })).json();
  assert.ok(!asBob.some((r) => r.code === created.session.code), 'strangers do not see it');

  assert.equal((await fetch(`${base}/api/sessions`)).status, 403, 'no anonymous listing');
  alice.close();
});

test('CORS headers apply to configured origins; preflight succeeds', async (t) => {
  const server = createCollagentServer({ dataDir: null, corsOrigins: ['https://app.example.com'] });
  const addr = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${addr.port}`;

  const allowed = await fetch(`${base}/healthz`, { headers: { origin: 'https://app.example.com' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.com');

  const denied = await fetch(`${base}/healthz`, { headers: { origin: 'https://evil.example.com' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);

  const preflight = await fetch(`${base}/api/sessions`, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' },
  });
  assert.equal(preflight.status, 204);
});

test('readiness reports the store backend; graceful shutdown closes clients and flushes', async (t) => {
  const dataDir = tmpDir(t);
  const server = createCollagentServer({ dataDir });
  const addr = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;

  const ready = await (await fetch(`${base}/readyz`)).json();
  assert.equal(ready.ok, true);
  assert.ok(['sqlite', 'jsonl', 'postgres'].includes(ready.backend));

  const client = new CollagentClient({ serverUrl: `ws://127.0.0.1:${addr.port}`, name: 'Alice' });
  await client.connect();
  await client.createSession({ agentType: 'mock' });
  client.closed = true; // don't fight shutdown with reconnect attempts

  await server.shutdown();
  await assert.rejects(() => fetch(`${base}/healthz`), 'server no longer accepts connections');
});

test('event payloads are captured whole, not truncated for display', () => {
  const bigInput = { file_path: '/tmp/x.txt', content: 'line\n'.repeat(800) }; // ~4KB
  const [toolUse] = translateHookEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: bigInput,
  });
  assert.ok(toolUse.input.length > 3000, `payload survives capture (${toolUse.input.length} chars)`);
  assert.ok(JSON.parse(toolUse.input).content.includes('line\nline'), 'whitespace round-trips through storage');

  const [toolResult] = translateHookEvent({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: 'out\n'.repeat(500),
  });
  assert.ok(toolResult.summary.length > 1500, 'results are no longer clipped to 200 chars');
});
