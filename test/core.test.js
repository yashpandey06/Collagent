import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/core/session.js';
import { SessionManager } from '../src/core/session-manager.js';
import { can } from '../src/core/permissions.js';
import { EventLog } from '../src/core/event-log.js';

test('session codes are unique, uppercase, human-friendly', () => {
  const manager = new SessionManager({ dataDir: null });
  const codes = new Set();
  for (let i = 0; i < 50; i++) {
    const s = manager.create({ agentType: 'mock' });
    assert.match(s.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    codes.add(s.code);
  }
  assert.equal(codes.size, 50);
});

test('lookup is case-insensitive', () => {
  const manager = new SessionManager({ dataDir: null });
  const s = manager.create({ agentType: 'mock' });
  assert.equal(manager.get(s.code.toLowerCase()), s);
});

test('host becomes driver; driver falls back to host on removal', () => {
  const s = new Session({ code: 'AAAAA' });
  const alice = s.addParticipant({ name: 'Alice', role: 'host' });
  const bob = s.addParticipant({ name: 'Bob' });
  assert.equal(s.driverId, alice.id);

  s.driverId = bob.id; // handoff
  s.removeParticipant(bob.id);
  assert.equal(s.driverId, alice.id);
});

test('permissions: open mode lets anyone instruct, driver mode restricts', () => {
  const s = new Session({ code: 'AAAAB' });
  const alice = s.addParticipant({ name: 'Alice', role: 'host' });
  const bob = s.addParticipant({ name: 'Bob' });
  s.status = 'idle';

  assert.equal(can(s, alice, 'instruct'), true);
  assert.equal(can(s, bob, 'instruct'), true);

  s.mode = 'driver';
  assert.equal(can(s, bob, 'instruct'), false);
  s.driverId = bob.id;
  assert.equal(can(s, bob, 'instruct'), true);
});

test('permissions: paused sessions refuse instructions; host-only end/mode', () => {
  const s = new Session({ code: 'AAAAC' });
  const alice = s.addParticipant({ name: 'Alice', role: 'host' });
  const bob = s.addParticipant({ name: 'Bob' });
  s.status = 'paused';
  assert.equal(can(s, alice, 'instruct'), false);
  assert.equal(can(s, bob, 'end'), false);
  assert.equal(can(s, bob, 'set_mode'), false);
  assert.equal(can(s, alice, 'end'), true);

  // pause/resume/handoff: host or current driver
  assert.equal(can(s, bob, 'pause'), false);
  s.driverId = bob.id;
  assert.equal(can(s, bob, 'pause'), true);
});

test('event log: monotonically increasing seq and since() replay', () => {
  const log = new EventLog();
  log.append({ kind: 'a' });
  log.append({ kind: 'b' });
  const c = log.append({ kind: 'c' });
  assert.equal(c.seq, 3);
  assert.deepEqual(log.since(1).map((e) => e.kind), ['b', 'c']);
  assert.equal(log.since(0).length, 3);
});

test('duplicate display names get unique suffixes', () => {
  const s = new Session({ code: 'AAAAE' });
  const a = s.addParticipant({ name: 'yash', role: 'host' });
  const b = s.addParticipant({ name: 'yash' });
  const c = s.addParticipant({ name: 'yash' });
  assert.equal(a.name, 'yash');
  assert.equal(b.name, 'yash-2');
  assert.equal(c.name, 'yash-3');
  assert.equal(s.addParticipant({ name: '  ' }).name, 'guest');
});

test('session snapshot exposes no secrets', () => {
  const s = new Session({ code: 'AAAAD' });
  s.addParticipant({ name: 'Alice', role: 'host' });
  const json = JSON.stringify(s.toJSON());
  assert.ok(!json.includes(s.agentToken));
  assert.ok(!json.includes('resumeToken'));
});
