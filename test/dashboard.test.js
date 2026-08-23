import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient, AgentHost } from '../src/client/client.js';
import { MockAdapter } from '../src/adapters/mock.js';

// The dashboard consumes canonical state through a watcher role: it observes
// rooms and event streams without ever becoming a participant.

async function boot(t, options = {}) {
  const server = createCollagentServer({ dataDir: null, ...options });
  const addr = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  return { server, addr, serverUrl: `ws://127.0.0.1:${addr.port}`, base: `http://127.0.0.1:${addr.port}` };
}

/** Minimal raw watcher client collecting frames by type. */
function watcher(serverUrl) {
  const ws = new WebSocket(serverUrl + '/ws');
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  const opened = new Promise((resolve) => ws.once('open', resolve));
  const wait = (type, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const frame = frames.find((f) => f.type === type);
      if (frame) { clearInterval(timer); resolve(frame); }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`no ${type}; saw ${frames.map((f) => f.type).join(',')}`));
      }
    }, 10);
  });
  return { ws, frames, opened, wait, send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() };
}

test('watcher: rooms list snapshot + live updates + room stream without participating', async (t) => {
  const { server, serverUrl } = await boot(t);

  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  const code = created.session.code;
  const host = new AgentHost({ serverUrl, code, agentToken: created.agentToken, adapter: new MockAdapter({ delay: 1 }) });
  await host.start();
  t.after(() => host.stop());

  const dash = watcher(serverUrl);
  await dash.opened;
  dash.send({ type: 'watch' });
  const roomsFrame = await dash.wait('rooms');
  assert.ok(roomsFrame.rooms.some((r) => r.code === code), 'snapshot lists the live room');

  dash.send({ type: 'watch_room', code, sinceSeq: 0 });
  const snapshot = await dash.wait('room_snapshot');
  assert.equal(snapshot.session.code, code);
  assert.ok(snapshot.events.some((e) => e.kind === 'session_created'), 'full replay from cursor 0');

  // The watcher never appears in the room.
  assert.ok(!server.manager.get(code).findParticipantByName('dashboard'));
  assert.equal(snapshot.session.participants.length, 1, 'only Alice is a participant');

  // Live: an instruction and its consequences stream to the watcher.
  alice.sendInstruction('paint it coral');
  await dash.wait('event');
  const gotResult = await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const frame = dash.frames.find((f) => f.type === 'event' && f.event.kind === 'result');
      if (frame) { clearInterval(timer); resolve(frame); }
      else if (Date.now() - started > 3000) { clearInterval(timer); reject(new Error('no result event')); }
    }, 10);
  });
  assert.match(gotResult.event.data.text, /paint it coral/);
  assert.ok(dash.frames.some((f) => f.type === 'session'), 'session snapshots stream too');

  // Cursor replay on a fresh watcher (reconnect semantics).
  const cursor = gotResult.event.seq;
  const dash2 = watcher(serverUrl);
  await dash2.opened;
  dash2.send({ type: 'watch_room', code, sinceSeq: cursor });
  const snap2 = await dash2.wait('room_snapshot');
  assert.ok(snap2.events.every((e) => e.seq > cursor), 'missed-event replay honors the cursor');

  // Rooms-list deltas arrive (debounced) after activity.
  await dash.wait('room_update', 3000);

  dash.close();
  dash2.close();
  alice.close();
});

test('watcher auth: remote watchers need identity; room streams need room access', async (t) => {
  const { serverUrl, base } = await boot(t, { trustLoopback: false, requireAuth: true, requireJoinKey: 'auto' });

  const register = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Alice' }),
  });
  const account = await register.json();

  const alice = new CollagentClient({ serverUrl, name: 'Alice', auth: { token: account.token } });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });

  const anon = watcher(serverUrl);
  await anon.opened;
  anon.send({ type: 'watch' });
  const denied = await anon.wait('error');
  assert.match(denied.message, /authentication required/);

  anon.send({ type: 'watch_room', code: created.session.code });
  const deniedRoom = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const frames = anon.frames.filter((f) => f.type === 'error');
      if (frames.length >= 2) { clearInterval(timer); resolve(frames[1]); }
    }, 10);
  });
  assert.match(deniedRoom.message, /not authorized/);

  // The join key alone opens a single room's stream (invite-link semantics).
  anon.send({ type: 'watch_room', code: created.session.code, key: created.joinKey });
  const snapshot = await anon.wait('room_snapshot');
  assert.equal(snapshot.session.code, created.session.code);

  // A registered user watches their own rooms, scoped.
  const owner = watcher(serverUrl);
  await owner.opened;
  owner.send({ type: 'watch', auth: { token: account.token } });
  const roomsFrame = await owner.wait('rooms');
  assert.ok(roomsFrame.rooms.some((r) => r.code === created.session.code));

  anon.close();
  owner.close();
  alice.close();
});

test('overview and analytics endpoints fold real state', async (t) => {
  const { serverUrl, base } = await boot(t);

  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  const host = new AgentHost({ serverUrl, code: created.session.code, agentToken: created.agentToken, adapter: new MockAdapter({ delay: 1 }) });
  await host.start();
  t.after(() => host.stop());

  const done = new Promise((resolve) => alice.on('event', (e) => e.kind === 'turn_completed' && resolve()));
  alice.sendInstruction('measure me');
  await done;

  const overview = await (await fetch(`${base}/api/overview`)).json();
  assert.equal(overview.rooms.live, 1);
  assert.equal(overview.agents.attached, 1);
  assert.equal(overview.agents.byRuntime.mock, 1);
  assert.equal(overview.people.online, 1);
  assert.equal(overview.usage.turns, 1);
  assert.ok(overview.recent.some((e) => e.kind === 'instruction' && e.roomCode === created.session.code));

  const analytics = await (await fetch(`${base}/api/analytics?sinceHours=1`)).json();
  assert.equal(analytics.totals.runs, 1);
  assert.equal(analytics.totals.instructions, 1);
  assert.equal(analytics.byRuntime.mock.runs, 1);
  assert.equal(analytics.totals.providerCost, null, 'mock reports no cost — none is invented');
  assert.ok(analytics.activity.length >= 1, 'hourly activity buckets exist');
  assert.equal(analytics.byRoom[created.session.code].runs, 1);

  const filtered = await (await fetch(`${base}/api/analytics?sinceHours=1&runtime=claude`)).json();
  assert.equal(filtered.totals.runs, 0, 'runtime filter excludes the mock runs');
  alice.close();
});

test('dashboard, room viewer and markdown docs are served', async (t) => {
  const { base } = await boot(t);
  const dash = await (await fetch(`${base}/`)).text();
  assert.match(dash, /OVERVIEW/);
  assert.match(dash, /watch_room/, 'dashboard speaks the watcher protocol');
  assert.match(dash, /agentIcon/, 'one AgentIcon abstraction');
  assert.match(dash, /data-theme/, 'theme tokens with light mode');
  const invite = await (await fetch(`${base}/?code=A7K2`)).text();
  assert.match(invite, /Join session/, 'invite links keep the lightweight room viewer');
  const room = await (await fetch(`${base}/room`)).text();
  assert.match(room, /Join session/);

  assert.match(dash, /__COLLAGENT_DOCS_URL__/.test(dash) ? /$^/ : /Docs ↗/, 'docs placeholder was templated');
  assert.ok(!dash.includes('__COLLAGENT_DOCS_URL__'), 'docs URL placeholder replaced');

  // The docs are a separate static site; the server hosts the built output.
  const docs = await (await fetch(`${base}/docs/`)).text();
  assert.match(docs, /Collagent Docs/);
  assert.match(docs, /collagent create/);
  const nested = await fetch(`${base}/docs/using/joining.html`);
  assert.equal(nested.status, 200);
  const traversal = await fetch(`${base}/docs/..%2Fpackage.json`);
  assert.equal(traversal.status, 404, 'no path traversal out of the docs dist');
  const missing = await fetch(`${base}/docs/nope.html`);
  assert.equal(missing.status, 404);
});

test('the dashboard docs link honors COLLAGENT_DOCS_URL', async (t) => {
  process.env.COLLAGENT_DOCS_URL = 'https://docs.example.test/';
  t.after(() => { delete process.env.COLLAGENT_DOCS_URL; });
  const { base } = await boot(t);
  const dash = await (await fetch(`${base}/`)).text();
  assert.match(dash, /href="https:\/\/docs\.example\.test\/" target="_blank"/);
});
