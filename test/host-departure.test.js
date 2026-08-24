import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient, AgentHost } from '../src/client/client.js';
import { MockAdapter } from '../src/adapters/mock.js';

// A room is persistent work, not a temporary agent process: agents detach and
// reconnect, people leave and return, and the room outlives all of them until
// someone explicitly ends it.

async function boot(t) {
  const server = createCollagentServer({ dataDir: null });
  const addr = await server.listen(0, '127.0.0.1');
  const serverUrl = `ws://127.0.0.1:${addr.port}`;
  t.after(() => server.close());

  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  const code = created.session.code;

  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  await bob.join(code, { key: created.joinKey });

  return { server, serverUrl, alice, bob, code, created };
}

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

test('the room persists when its host leaves — remaining participants stay in', async (t) => {
  const { created, server, alice, bob, code } = await boot(t);
  seen(bob);

  alice.leave();
  await waitForEvent(bob, (e) => e.kind === 'participant_left' && e.actor.name === 'Alice');

  // Bob is still connected to a live room; the session was not closed on him.
  assert.equal(bob.ws.readyState, bob.ws.OPEN);
  const session = server.manager.get(code);
  assert.ok(session, 'room survives its host leaving');
  assert.equal(session.lifecycle, 'active');
  bob.close();
  alice.close();
});

test('agent host dying detaches the agent session but keeps the room', async (t) => {
  const { server, serverUrl, alice, bob, code, created } = await boot(t);
  seen(bob);

  const host = new AgentHost({
    serverUrl,
    code,
    agentToken: created.agentToken,
    adapter: new MockAdapter({ delay: 2 }),
  });
  await host.start();
  await waitForEvent(bob, (e) => e.kind === 'agent_session_attached');

  await host.stop();
  const detached = await waitForEvent(bob, (e) => e.kind === 'agent_session_detached');
  assert.equal(detached.agentId, 'mock-1');

  const session = server.manager.get(code);
  assert.equal(session.lifecycle, 'active');
  assert.equal(session.status, 'waiting_agent');
  assert.equal(session.getAgentSession('mock-1').status, 'disconnected');
  assert.equal(bob.ws.readyState, bob.ws.OPEN, 'participants ride out an agent detach');
  bob.close();
  alice.close();
});

test('instructions sent while no agent is attached queue and flush on attach', async (t) => {
  const { serverUrl, alice, bob, code, created } = await boot(t);
  seen(bob);

  bob.sendInstruction('do this later');
  const queued = await waitForEvent(bob, (e) => e.kind === 'notice' && /queued/.test(e.data.message));
  assert.ok(queued);

  const host = new AgentHost({
    serverUrl,
    code,
    agentToken: created.agentToken,
    adapter: new MockAdapter({ delay: 2 }),
  });
  await host.start();

  const result = await waitForEvent(bob, (e) => e.kind === 'result');
  assert.match(result.data.text, /do this later/);
  await host.stop();
  bob.close();
  alice.close();
});

test('a hostless room is adoptable: the next joiner becomes host and can re-attach', async (t) => {
  const { created, server, serverUrl, alice, bob, code } = await boot(t);

  alice.leave();
  alice.close();
  await waitForEvent(bob, (e) => e.kind === 'participant_left');

  const carol = new CollagentClient({ serverUrl, name: 'Carol' });
  await carol.connect();
  const welcome = await carol.join(code, { key: created.joinKey });
  assert.equal(welcome.session.participants.find((p) => p.name === 'Carol')?.role, 'host');
  assert.ok(welcome.agentToken, 'the adopting host receives a re-attach grant');
  seen(carol); // start recording before the attach broadcasts

  const host = new AgentHost({
    serverUrl,
    code,
    agentToken: welcome.agentToken,
    adapter: new MockAdapter({ delay: 2 }),
  });
  await host.start();
  await waitForEvent(carol, (e) => e.kind === 'agent_session_attached');
  assert.equal(server.manager.get(code).status, 'idle');

  await host.stop();
  carol.close();
  bob.close();
});
