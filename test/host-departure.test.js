import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient } from '../src/client/client.js';

// A room whose last connected host is gone is dead air on every runtime —
// the host's machine runs the agent. The server must close the live room for
// remaining participants (explicit leave: immediately; silent drop: after a
// grace window) while keeping it stored so `collagent open` can revive it.

async function boot(t, { hostGraceMs } = {}) {
  const server = createCollagentServer({ dataDir: null, hostGraceMs });
  const addr = await server.listen(0, '127.0.0.1');
  const serverUrl = `ws://127.0.0.1:${addr.port}`;
  t.after(() => server.close());

  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  const code = created.session.code;

  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  await bob.join(code);

  return { server, serverUrl, alice, bob, code };
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

test('host leaving closes the live room for remaining participants', async (t) => {
  const { server, serverUrl, alice, bob, code } = await boot(t);
  seen(bob);

  alice.leave();

  const closed = await waitForEvent(bob, (e) => e.kind === 'room_closed');
  bob.close(); // what every UI does on room_closed — no reconnect into a dead room
  assert.match(closed.data.reason, /host Alice left/);
  assert.equal(closed.data.code, code);

  // The room is closed, not ended: still in the registry, stored for reopen.
  const session = server.manager.get(code);
  assert.ok(session, 'room survives its host leaving');
  assert.equal(session.status, 'waiting_agent');

  // A fresh joiner revives it as host (the reopen path).
  const carol = new CollagentClient({ serverUrl, name: 'Carol' });
  await carol.connect();
  const welcome = await carol.join(code);
  assert.equal(welcome.session.participants.find((p) => p.name === 'Carol')?.role, 'host');
  carol.close();
  alice.close();
});

test('a silently dropped host closes the room after the grace window', async (t) => {
  const { alice, bob } = await boot(t, { hostGraceMs: 60 });
  seen(bob);

  alice.close(); // socket drops with no leave message — a dead host terminal

  const closed = await waitForEvent(bob, (e) => e.kind === 'room_closed');
  bob.close();
  assert.match(closed.data.reason, /host Alice disconnected/);
});

test('a host reconnecting within the grace window keeps the room open', async (t) => {
  const { alice, bob } = await boot(t, { hostGraceMs: 500 });
  seen(bob);

  // Raw socket close, client alive: CollagentClient auto-rejoins (~250ms),
  // safely inside the 500ms grace window.
  const reconnected = new Promise((resolve) => alice.once('reconnected', resolve));
  alice.ws.close();
  await reconnected;

  // Sleep past the grace deadline: an uncancelled timer would have fired.
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(!bob._seen.some((e) => e.kind === 'room_closed'), 'no close after host came back');
  assert.equal(bob.ws.readyState, bob.ws.OPEN);
  bob.close();
  alice.close();
});
