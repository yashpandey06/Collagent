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
  s.paused = true;
  assert.equal(s.status, 'paused', 'room-level pause drives the derived status');
  assert.equal(can(s, alice, 'instruct'), false);
  assert.equal(can(s, bob, 'end'), false);
  assert.equal(can(s, bob, 'set_mode'), false);
  assert.equal(can(s, alice, 'end'), true);

  // pause/resume/handoff/add_agent: host or current driver
  assert.equal(can(s, bob, 'pause'), false);
  assert.equal(can(s, bob, 'add_agent'), false);
  s.driverId = bob.id;
  assert.equal(can(s, bob, 'pause'), true);
  assert.equal(can(s, bob, 'add_agent'), true);
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
  const agent = s.addAgentSession({ adapterType: 'claude-native' });
  const json = JSON.stringify(s.toJSON());
  assert.ok(!json.includes(agent.agentToken));
  assert.ok(!json.includes(s.joinKey));
  assert.ok(!json.includes('resumeToken'));
  assert.ok(!json.includes('agentToken'));
});

test('agent sessions: stable room-local ids, same runtime twice, lookups', () => {
  const s = new Session({ code: 'AAAAF' });
  const a = s.addAgentSession({ adapterType: 'claude-native' });
  const b = s.addAgentSession({ adapterType: 'codex-native' });
  const c = s.addAgentSession({ adapterType: 'claude-code' });
  assert.equal(a.agentId, 'claude-1');
  assert.equal(b.agentId, 'codex-1');
  assert.equal(c.agentId, 'claude-2', 'same runtime gets the next number');
  assert.equal(a.runtime, 'claude');
  assert.equal(c.runtime, 'claude');

  assert.equal(s.findAgentSession('@codex-1'), b);
  assert.equal(s.findAgentSession('codex'), b, 'runtime name resolves when unique');
  assert.equal(s.findAgentSession('claude'), null, 'ambiguous runtime does not resolve');
  assert.equal(s.agentSessionByToken(b.agentToken), b);
  assert.equal(s.primaryAgent(), a);
  assert.equal(s.agentToken, a.agentToken, 'legacy accessor is the primary agent token');
});

test('room status derives from lifecycle + agent sessions, never stored', () => {
  const s = new Session({ code: 'AAAAG' });
  const a = s.addAgentSession({ adapterType: 'mock' });
  assert.equal(s.status, 'waiting_agent');

  a.markAttached();
  a.applyAgentStatus('ready');
  assert.equal(s.status, 'idle');

  a.applyAgentStatus('working');
  assert.equal(s.status, 'working');

  const b = s.addAgentSession({ adapterType: 'mock' });
  b.markAttached();
  b.applyAgentStatus('ready');
  assert.equal(s.status, 'working', 'one working agent shows the room busy');

  a.applyAgentStatus('idle');
  assert.equal(s.status, 'idle');

  s.paused = true;
  assert.equal(s.status, 'paused', 'pause is room state, not agent state');
  s.paused = false;

  a.markDetached();
  b.markDetached();
  assert.equal(s.status, 'waiting_agent');
  assert.equal(s.lifecycle, 'active', 'agents detaching never ends the room');

  s.lifecycle = 'ended';
  assert.equal(s.status, 'ended');
});
