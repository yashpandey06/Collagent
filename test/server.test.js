import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient, AgentHost } from '../src/client/client.js';
import { MockAdapter } from '../src/adapters/mock.js';

function collect(client) {
  if (!client._seen) {
    client._seen = [];
    client.on('event', (e) => client._seen.push(e));
  }
  return client._seen;
}

/** Boot a server on an ephemeral port and wire up Alice (host + mock agent). */
async function bootSession(t) {
  const server = createCollagentServer({ dataDir: null });
  const addr = await server.listen(0, '127.0.0.1');
  const serverUrl = `ws://127.0.0.1:${addr.port}`;

  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  collect(alice); // start recording before the agent attaches

  const adapter = new MockAdapter({ delay: 2 });
  const host = new AgentHost({
    serverUrl,
    code: created.session.code,
    agentToken: alice.agentToken,
    adapter,
  });
  await host.start();

  t.after(async () => {
    await server.close();
  });

  return { server, serverUrl, alice, host, adapter, code: created.session.code };
}

/**
 * Wait until the client has seen an event matching `predicate` — including
 * events that arrived before this call (tracked via a collected array).
 */
function waitForEvent(client, predicate, timeoutMs = 4000) {
  if (!client._seen) {
    client._seen = [];
    client.on('event', (e) => client._seen.push(e));
  }
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

test('milestone flow: create → join → instruct → agent executes → both see results', async (t) => {
  const { serverUrl, alice, code } = await bootSession(t);
  const aliceEvents = collect(alice);

  // Bob joins from "his machine"
  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  const welcome = await bob.join(code);
  const bobEvents = collect(bob);

  assert.equal(welcome.session.code, code);
  assert.deepEqual(
    welcome.session.participants.map((p) => p.name).sort(),
    ['Alice', 'Bob'],
  );
  // Bob got the history that predates his join
  assert.ok(welcome.events.some((e) => e.kind === 'session_created'));

  // Alice sees Bob join live
  await waitForEvent(alice, (e) => e.kind === 'participant_joined' && e.actor.name === 'Bob');

  // Bob sends an instruction to the shared agent
  bob.sendInstruction('Add OAuth callback validation.');

  const bobResult = await waitForEvent(bob, (e) => e.kind === 'result');
  const aliceResult = await waitForEvent(alice, (e) => e.kind === 'result');
  assert.equal(bobResult.seq, aliceResult.seq); // identical shared event

  // Both saw the same instruction + agent activity, in the same order
  for (const events of [aliceEvents, bobEvents]) {
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes('instruction'));
    assert.ok(kinds.includes('tool_use'));
    assert.ok(kinds.includes('agent_message'));
    assert.ok(kinds.includes('result'));
  }
  const instruction = aliceEvents.find((e) => e.kind === 'instruction');
  assert.equal(instruction.actor.name, 'Bob');
  assert.equal(instruction.data.text, 'Add OAuth callback validation.');

  bob.close();
  alice.close();
});

test('pause blocks instructions; resume flushes the queue', async (t) => {
  const { serverUrl, alice, code } = await bootSession(t);
  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  await bob.join(code);

  // agent ready arrives during boot; recorded by collect() in bootSession
  await waitForEvent(alice, (e) => e.kind === 'agent_status' && e.data.status === 'ready');

  alice.control('pause');
  await waitForEvent(bob, (e) => e.kind === 'session_paused');

  const denied = new Promise((resolve) => bob.once('server-error', resolve));
  bob.sendInstruction('should be rejected');
  assert.match(await denied, /paused/);

  alice.control('resume');
  await waitForEvent(bob, (e) => e.kind === 'session_resumed');

  bob.sendInstruction('works after resume');
  const result = await waitForEvent(bob, (e) => e.kind === 'result');
  assert.match(result.data.text, /works after resume/);

  bob.close();
  alice.close();
});

test('driver mode + handoff controls who can instruct', async (t) => {
  const { serverUrl, alice, code } = await bootSession(t);
  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  await bob.join(code);

  alice.control('set_mode', { mode: 'driver' });
  await waitForEvent(bob, (e) => e.kind === 'mode_changed');

  const denied = new Promise((resolve) => bob.once('server-error', resolve));
  bob.sendInstruction('bob without control');
  assert.match(await denied, /driver/);

  // Bob cannot pause either (not host, not driver)
  const deniedPause = new Promise((resolve) => bob.once('server-error', resolve));
  bob.control('pause');
  assert.match(await deniedPause, /permission/);

  alice.control('handoff', { target: 'Bob' });
  const handoff = await waitForEvent(bob, (e) => e.kind === 'control_transferred');
  assert.equal(handoff.data.to.name, 'Bob');

  bob.sendInstruction('bob with control');
  const result = await waitForEvent(bob, (e) => e.kind === 'result');
  assert.match(result.data.text, /bob with control/);

  bob.close();
  alice.close();
});

test('reconnect resumes identity and replays missed events', async (t) => {
  const { serverUrl, alice, code } = await bootSession(t);
  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  await bob.join(code);
  const bobId = bob.self.participantId;

  // Simulate a dropped connection (not a deliberate leave)
  const reconnected = new Promise((resolve) => bob.once('reconnected', resolve));
  bob.ws.close();

  // While Bob is offline, Alice keeps working
  alice.sendInstruction('work while bob is away');
  await waitForEvent(alice, (e) => e.kind === 'result');

  const msg = await reconnected;
  assert.equal(bob.self.participantId, bobId); // same identity
  const kinds = msg.events.map((e) => e.kind);
  assert.ok(kinds.includes('instruction'), `missed instruction replayed (got: ${kinds})`);
  assert.ok(kinds.includes('result'));

  // Session shows Bob connected again, not duplicated
  const bobs = bob.session.participants.filter((p) => p.name === 'Bob');
  assert.equal(bobs.length, 1);
  assert.equal(bobs[0].connected, true);

  bob.close();
  alice.close();
});

test('status endpoint exposes public session info', async (t) => {
  const { serverUrl, alice, code } = await bootSession(t);
  const port = new URL(serverUrl.replace('ws://', 'http://')).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${code}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.code, code);
  assert.ok(Array.isArray(body.participants));
  assert.ok(!JSON.stringify(body).includes('Token'));
  alice.close();
});

test('joining a nonexistent session fails cleanly', async (t) => {
  const server = createCollagentServer({ dataDir: null });
  const addr = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());

  const bob = new CollagentClient({ serverUrl: `ws://127.0.0.1:${addr.port}`, name: 'Bob' });
  await bob.connect();
  await assert.rejects(() => bob.join('ZZZZZ'), /no session/);
  bob.close();
});
