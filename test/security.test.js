import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient, AgentHost } from '../src/client/client.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { sanitizeText } from '../src/core/sanitize.js';
import { formatInstructionLine } from '../src/adapters/instruction-format.js';

const ESC = String.fromCharCode(27);

// trustLoopback: false makes the server treat every connection as remote,
// so the tests exercise the rules that protect a network-exposed server.
async function bootRemote(t, options = {}) {
  const server = createCollagentServer({ dataDir: null, trustLoopback: false, requireAuth: false, ...options });
  const addr = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  return { server, addr, serverUrl: `ws://127.0.0.1:${addr.port}`, base: `http://127.0.0.1:${addr.port}` };
}

test('joining from a remote connection requires the room key', async (t) => {
  const { serverUrl } = await bootRemote(t);
  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  assert.ok(created.joinKey, 'the creator receives the join key to hand out');

  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  await assert.rejects(() => bob.join(created.session.code), /join key/);
  const welcome = await bob.join(created.session.code, { key: created.joinKey });
  assert.equal(welcome.session.code, created.session.code);
  bob.close();
  alice.close();
});

test('room listing and delete over HTTP need the admin token when remote', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-sec-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { server, base, serverUrl } = await bootRemote(t, { dataDir });

  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });

  const denied = await fetch(`${base}/api/sessions`);
  assert.equal(denied.status, 403, 'no room enumeration without credentials');

  const listed = await fetch(`${base}/api/sessions`, {
    headers: { authorization: `Bearer ${server.adminToken}` },
  });
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).some((r) => r.code === created.session.code));

  const delDenied = await fetch(`${base}/api/sessions/${created.session.code}`, { method: 'DELETE' });
  assert.equal(delDenied.status, 403, 'unauthorized delete is refused');
  assert.ok(server.manager.get(created.session.code), 'room untouched');

  // Per-room reads accept the join key (participants sharing a link).
  const roomDenied = await fetch(`${base}/api/sessions/${created.session.code}`);
  assert.equal(roomDenied.status, 403);
  const roomOk = await fetch(`${base}/api/sessions/${created.session.code}?key=${created.joinKey}`);
  assert.equal(roomOk.status, 200);
  const body = await roomOk.json();
  assert.ok(!JSON.stringify(body).match(/agentToken|joinKey|resumeToken/), 'reads leak no credentials');
  alice.close();
});

test('join attempts are rate-limited per remote address', async (t) => {
  const { serverUrl } = await bootRemote(t, { joinRateLimit: 3 });
  const results = [];
  for (let i = 0; i < 5; i++) {
    const c = new CollagentClient({ serverUrl, name: `x${i}` });
    await c.connect();
    try {
      await c.createSession({ agentType: 'mock' });
      results.push('ok');
    } catch (err) {
      results.push(err.message);
    }
    c.close();
  }
  assert.ok(results.slice(3).some((r) => /rate limited/.test(r)), `later attempts throttled (got: ${results})`);
});

test('terminal escape sequences are stripped from instructions and names at the server edge', async (t) => {
  const server = createCollagentServer({ dataDir: null });
  const addr = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const serverUrl = `ws://127.0.0.1:${addr.port}`;

  const evil = new CollagentClient({ serverUrl, name: `Bob${ESC}[31m` });
  await evil.connect();
  const created = await evil.createSession({ agentType: 'mock' });
  assert.equal(created.self.name, 'Bob[31m', 'ESC removed from the display name');

  const received = [];
  const adapter = new MockAdapter({ delay: 1 });
  const original = adapter.sendInstruction.bind(adapter);
  adapter.sendInstruction = (i) => { received.push(i.text); return original(i); };
  const host = new AgentHost({ serverUrl, code: created.session.code, agentToken: created.agentToken, adapter });
  await host.start();
  t.after(() => host.stop());

  const events = [];
  evil.on('event', (e) => events.push(e));
  evil.sendInstruction(`hi${ESC}[201~${ESC}]0;pwn\rrm -rf /`);
  await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (received.length) { clearInterval(timer); resolve(); }
    }, 10);
    setTimeout(() => { clearInterval(timer); reject(new Error('instruction never arrived')); }, 3000);
  });

  assert.ok(!received[0].includes(ESC), 'no ESC reaches the adapter');
  assert.ok(!received[0].includes('\r'), 'no carriage return reaches the PTY path');
  const stored = events.find((e) => e.kind === 'instruction');
  assert.ok(!JSON.stringify(stored.data.text).includes('\\u001b'), 'no ESC persists in the event log');
  evil.close();
});

test('adapter-side injection formatting is a second line of defense', () => {
  const line = formatInstructionLine({
    text: `do it${ESC}[201~${ESC}[0m`,
    from: { name: `Eve${ESC}[31m` },
  });
  assert.ok(!line.includes(ESC), 'bracketed-paste breakout neutralized even if the server is bypassed');
  assert.equal(sanitizeText(`a${ESC}b\tc\nd`), 'ab\tc\nd', 'tab and newline survive; ESC does not');
});

test('invalid resume credentials and invalid agent tokens are rejected', async (t) => {
  const server = createCollagentServer({ dataDir: null });
  const addr = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const serverUrl = `ws://127.0.0.1:${addr.port}`;

  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });

  const thief = new CollagentClient({ serverUrl, name: 'Thief' });
  await thief.connect();
  const rejected = new Promise((resolve) => thief.once('server-error', resolve));
  thief._send({
    type: 'rejoin',
    code: created.session.code,
    participantId: created.self.participantId,
    resumeToken: 'wrong-token',
    sinceSeq: 0,
  });
  assert.match(await rejected, /invalid resume credentials/);

  const badHost = new AgentHost({
    serverUrl,
    code: created.session.code,
    agentToken: 'not-the-token',
    adapter: new MockAdapter(),
  });
  await assert.rejects(() => badHost.start(), /invalid agent token/);
  thief.close();
  alice.close();
});
