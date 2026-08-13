import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../src/core/session-manager.js';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient, AgentHost } from '../src/client/client.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { VERSION } from '../src/version.js';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-rooms-'));
}

test('rooms persist to disk and restore across manager restarts', () => {
  const dataDir = tmpDataDir();
  const m1 = new SessionManager({ dataDir });
  const s1 = m1.create({ agentType: 'claude-native' });
  s1.append('participant_joined', { type: 'user', id: 'p1', name: 'Alice' }, { role: 'host' });
  s1.append('instruction', { type: 'user', id: 'p1', name: 'Alice' }, { text: 'fix the tests' });
  s1.append('agent_status', { type: 'agent', name: 'claude-native' }, {
    status: 'ready', detail: { sessionId: 'claude-uuid-1' },
  });
  s1.append('mode_changed', { type: 'user', id: 'p1', name: 'Alice' }, { mode: 'driver' });

  const m2 = new SessionManager({ dataDir });
  assert.equal(m2.restore(), 1);
  const restored = m2.get(s1.code);
  assert.ok(restored, 'room restored by code');
  assert.equal(restored.agentType, 'claude-native');
  assert.equal(restored.status, 'waiting_agent');
  assert.equal(restored.mode, 'driver');
  assert.equal(restored.participants.size, 0, 'roster resets; people rejoin');
  assert.equal(restored.lastAgentSessionId(), 'claude-uuid-1');
  assert.ok(restored.log.length >= 5, 'full history retained');

  const m3 = new SessionManager({ dataDir });
  m3.restore();
  const again = m3.get(s1.code);
  again.append('session_ended', { type: 'user', id: 'p1', name: 'Alice' }, {});
  const m4 = new SessionManager({ dataDir });
  assert.equal(m4.restore(), 0, 'ended rooms are not restored');
});

test('first joiner of a restored room becomes host and can re-attach an agent', async (t) => {
  const dataDir = tmpDataDir();

  const server1 = createCollagentServer({ dataDir });
  const addr1 = await server1.listen(0, '127.0.0.1');
  const alice = new CollagentClient({ serverUrl: `ws://127.0.0.1:${addr1.port}`, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  const code = created.session.code;
  alice.sendInstruction('remember this instruction');
  await new Promise((r) => setTimeout(r, 100));
  alice.close();
  await server1.close();

  const server2 = createCollagentServer({ dataDir });
  const addr2 = await server2.listen(0, '127.0.0.1');
  const serverUrl = `ws://127.0.0.1:${addr2.port}`;
  t.after(() => server2.close());

  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  const welcome = await bob.join(code);

  assert.ok(welcome.agentToken, 'reopening host receives agent credentials');
  assert.equal(bob.session.participants.find((p) => p.name === 'Bob').role, 'host');
  const kinds = welcome.events.map((e) => e.kind);
  assert.ok(kinds.includes('instruction'), 'full history replays across restart');

  const host = new AgentHost({ serverUrl, code, agentToken: welcome.agentToken, adapter: new MockAdapter({ delay: 2 }) });
  await host.start();

  const events = [];
  bob.on('event', (e) => events.push(e));
  bob.sendInstruction('works after reopen');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no result after reopen')), 4000);
    bob.on('event', (e) => {
      if (e.kind === 'result') { clearTimeout(timer); resolve(); }
    });
  });

  const carol = new CollagentClient({ serverUrl, name: 'Carol' });
  await carol.connect();
  const carolWelcome = await carol.join(code);
  assert.equal(carolWelcome.agentToken, undefined, 'collaborators get no agent credentials');
  assert.equal(carol.session.participants.find((p) => p.name === 'Carol').role, 'collaborator');

  bob.close();
  carol.close();
  await host.stop();
});

test('room listing endpoint returns summaries sorted by recency', async (t) => {
  const server = createCollagentServer({ dataDir: tmpDataDir() });
  const addr = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const serverUrl = `ws://127.0.0.1:${addr.port}`;

  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const first = await alice.createSession({ agentType: 'mock' });
  alice.sendInstruction('older room instruction');

  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  const second = await bob.createSession({ agentType: 'mock' });
  bob.sendInstruction('newest room instruction');
  await new Promise((r) => setTimeout(r, 100));

  const rooms = await (await fetch(`http://127.0.0.1:${addr.port}/api/sessions`)).json();
  assert.equal(rooms.length, 2);
  assert.equal(rooms[0].code, second.session.code, 'most recent first');
  assert.equal(rooms[0].lastInstruction.text, 'newest room instruction');
  assert.equal(rooms[0].lastInstruction.name, 'Bob');
  assert.deepEqual(rooms[0].participantsEver, ['Bob']);
  assert.ok(rooms[0].createdAt && rooms[0].lastActivity >= rooms[0].createdAt);
  assert.ok(!JSON.stringify(rooms).includes('agentSessionId'), 'no runtime ids in public listing');
  assert.ok(rooms.every((r) => typeof r.eventCount === 'number'));
  assert.ok(rooms.some((r) => r.code === first.session.code));

  alice.close();
  bob.close();
});

test('healthz reports the server version', async (t) => {
  const server = createCollagentServer({ dataDir: null });
  const addr = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const health = await (await fetch(`http://127.0.0.1:${addr.port}/healthz`)).json();
  assert.equal(health.version, VERSION);
});
