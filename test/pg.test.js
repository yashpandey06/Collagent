import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient, AgentHost } from '../src/client/client.js';
import { MockAdapter } from '../src/adapters/mock.js';

// Integration against a real PostgreSQL. Points at a dedicated test database
// (COLLAGENT_TEST_PG overrides); skips cleanly when none is reachable.
const PG_URL = process.env.COLLAGENT_TEST_PG
  ?? 'postgres://localhost:5432/collagent_test';

let pgAvailable = false;
let pgModule = null;
try {
  pgModule = await import('pg');
  const probe = new pgModule.default.Client({ connectionString: PG_URL });
  await probe.connect();
  // isolate each run: the store re-migrates from scratch
  await probe.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await probe.end();
  pgAvailable = true;
} catch { /* no postgres here — tests below skip */ }

function seen(client) {
  if (!client._seen) {
    client._seen = [];
    client.on('event', (e) => client._seen.push(e));
  }
  return client._seen;
}

function waitForEvent(client, predicate, timeoutMs = 4000) {
  seen(client);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = client._seen.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out; saw: ${client._seen.map((e) => e.kind).join(',')}`));
      }
    }, 10);
  });
}

test('postgres: full room lifecycle with the database as source of truth', { skip: !pgAvailable && 'no postgres at ' + PG_URL }, async (t) => {
  const s1 = createCollagentServer({ dataDir: null, databaseUrl: PG_URL });
  const addr1 = await s1.listen(0, '127.0.0.1');
  const url1 = `ws://127.0.0.1:${addr1.port}`;

  // migrations ran; readiness confirms the backend
  const ready = await (await fetch(`http://127.0.0.1:${addr1.port}/readyz`)).json();
  assert.deepEqual(ready, { ok: true, backend: 'postgres' });

  const alice = new CollagentClient({ serverUrl: url1, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  const code = created.session.code;

  const host = new AgentHost({ serverUrl: url1, code, agentToken: created.agentToken, adapter: new MockAdapter({ delay: 1 }) });
  await host.start();
  seen(alice);
  alice.sendInstruction('write it all down');
  const turn = await waitForEvent(alice, (e) => e.kind === 'turn_completed');

  // Give the ordered write queue a beat, then verify rows landed.
  await new Promise((r) => setTimeout(r, 150));
  const db = new pgModule.default.Client({ connectionString: PG_URL });
  await db.connect();
  t.after(() => db.end());

  const events = await db.query('SELECT kind, agent_id, turn_id FROM events WHERE code = $1 ORDER BY seq', [code]);
  assert.ok(events.rows.length >= 6, `events persisted (${events.rows.length})`);
  assert.ok(events.rows.some((r) => r.kind === 'instruction'));
  assert.ok(events.rows.some((r) => r.kind === 'tool_use' && r.agent_id === 'mock-1' && r.turn_id === turn.data.turnId),
    'events are queryable by agent and turn');

  const turns = await db.query('SELECT ok, tool_calls FROM turns WHERE room_code = $1', [code]);
  assert.equal(turns.rows.length, 1);
  assert.equal(turns.rows[0].ok, true);

  const agents = await db.query('SELECT agent_id, runtime FROM agent_sessions WHERE room_code = $1', [code]);
  assert.deepEqual(agents.rows, [{ agent_id: 'mock-1', runtime: 'mock' }]);

  await host.stop();
  alice.close();
  await s1.close();

  // A brand-new server process on the same database: the room is there, the
  // host resumes their seat, and replay works from the event cursor.
  const s2 = createCollagentServer({ dataDir: null, databaseUrl: PG_URL });
  const addr2 = await s2.listen(0, '127.0.0.1');
  t.after(() => s2.close());

  const room = s2.manager.get(code);
  assert.ok(room, 'room restored from postgres, no local files involved');
  assert.equal(room.primaryAgent().agentId, 'mock-1');
  assert.equal(room.joinKey, created.joinKey, 'join key survives via the database');

  const back = new CollagentClient({ serverUrl: `ws://127.0.0.1:${addr2.port}`, name: 'Alice' });
  await back.connect();
  back._send({
    type: 'rejoin',
    code,
    participantId: created.self.participantId,
    resumeToken: created.self.resumeToken,
    sinceSeq: turn.seq,
  });
  const welcome = await back._await('reconnected');
  assert.equal(back.self.participantId, created.self.participantId);
  assert.ok(!welcome.events.some((e) => e.seq <= turn.seq), 'cursor-based replay from the database');
  back.close();
});

test('postgres: users, workspaces and the /events filter API', { skip: !pgAvailable && 'no postgres at ' + PG_URL }, async (t) => {
  const server = createCollagentServer({
    databaseUrl: PG_URL,
    dataDir: null,
    trustLoopback: false,
    requireAuth: true,
    requireJoinKey: false,
  });
  const addr = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${addr.port}`;

  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Alice' }),
  });
  const account = await res.json();

  const alice = new CollagentClient({ serverUrl: `ws://127.0.0.1:${addr.port}`, name: 'Alice', auth: { token: account.token } });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  assert.equal(created.session.workspaceId, account.workspaceId);

  const host = new AgentHost({ serverUrl: `ws://127.0.0.1:${addr.port}`, code: created.session.code, agentToken: created.agentToken, adapter: new MockAdapter({ delay: 1 }) });
  await host.start();
  seen(alice);
  alice.sendInstruction('first');
  await waitForEvent(alice, (e) => e.kind === 'turn_completed');
  await new Promise((r) => setTimeout(r, 150));

  // scoped listing via user token
  const rooms = await (await fetch(`${base}/api/sessions`, {
    headers: { authorization: `Bearer ${account.token}` },
  })).json();
  assert.ok(rooms.some((r) => r.code === created.session.code));

  // filtered event reads (participant + kind), authorized by the join key
  const key = created.joinKey;
  const mine = await (await fetch(
    `${base}/api/sessions/${created.session.code}/events?participantId=${created.self.participantId}&key=${key}`,
  )).json();
  assert.ok(mine.length >= 1);
  assert.ok(mine.every((e) => e.actor?.id === created.self.participantId));

  const tools = await (await fetch(
    `${base}/api/sessions/${created.session.code}/events?kind=tool_use&key=${key}`,
  )).json();
  assert.ok(tools.length >= 1);
  assert.ok(tools.every((e) => e.kind === 'tool_use'));

  await host.stop();
  alice.close();
});
