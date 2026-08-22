import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../src/core/session-manager.js';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient, AgentHost } from '../src/client/client.js';
import { MockAdapter } from '../src/adapters/mock.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('rooms, agent sessions and participants survive a manager restart', (t) => {
  const dataDir = tmpDir(t);
  const m1 = new SessionManager({ dataDir });
  const session = m1.create({ agentType: 'claude-native' });
  const agent = session.addAgentSession({ adapterType: 'claude-native' });
  agent.nativeSessionId = 'native-abc';
  const second = session.addAgentSession({ adapterType: 'codex' });
  const alice = session.addParticipant({ name: 'Alice', role: 'host', userId: 'u_1' });
  session.append('instruction', { type: 'user', id: alice.id, name: 'Alice' }, { text: 'hello' });
  m1.saveMeta(session);
  m1.close();

  const m2 = new SessionManager({ dataDir });
  assert.equal(m2.restore(), 1);
  const restored = m2.get(session.code);
  assert.ok(restored);
  assert.equal(restored.lifecycle, 'active');
  assert.deepEqual([...restored.agentSessions.keys()], ['claude-1', 'codex-1']);
  assert.equal(restored.getAgentSession('claude-1').nativeSessionId, 'native-abc');
  assert.equal(restored.getAgentSession('claude-1').id, agent.id, 'AgentSession identity is durable');
  assert.equal(restored.getAgentSession('claude-1').status, 'disconnected');
  assert.notEqual(restored.getAgentSession('codex-1').agentToken, second.agentToken,
    'attach tokens are re-minted on restore, never persisted');
  assert.equal(restored.joinKey, session.joinKey, 'the join key survives restarts');

  const restoredAlice = restored.getParticipant(alice.id);
  assert.equal(restoredAlice.name, 'Alice');
  assert.equal(restoredAlice.resumeToken, alice.resumeToken, 'resume credentials survive restarts');
  assert.equal(restoredAlice.connected, false);
  m2.close();
});

test('legacy JSONL rooms (no meta) migrate to an implicit AgentSession', (t) => {
  const dataDir = tmpDir(t);
  const dir = path.join(dataDir, 'history');
  fs.mkdirSync(dir, { recursive: true });
  // A pre-0.5.0 room: events only, agent identity buried in agent_status.
  const events = [
    { seq: 1, ts: 1, kind: 'session_created', actor: { type: 'system', name: 'collagent' }, data: { code: 'LGCY1', agentType: 'claude-native' } },
    { seq: 2, ts: 2, kind: 'participant_joined', actor: { type: 'user', id: 'p_1', name: 'Alice' }, data: { role: 'host' } },
    { seq: 3, ts: 3, kind: 'agent_status', actor: { type: 'agent', name: 'claude-native' }, data: { status: 'ready', detail: { sessionId: 'old-claude-session' } } },
    { seq: 4, ts: 4, kind: 'instruction', actor: { type: 'user', id: 'p_1', name: 'Alice' }, data: { text: 'add oauth' } },
  ];
  fs.writeFileSync(path.join(dir, 'LGCY1.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const manager = new SessionManager({ dataDir });
  assert.equal(manager.restore(), 1);
  const room = manager.get('LGCY1');
  assert.equal(room.agentType, 'claude-native');
  const agent = room.primaryAgent();
  assert.equal(agent.agentId, 'claude-1');
  assert.equal(agent.runtime, 'claude');
  assert.equal(agent.nativeSessionId, 'old-claude-session', 'resume id recovered from history');
  assert.equal(agent.status, 'disconnected');
  assert.equal(room.log.length, 4, 'history replays untouched');
  assert.ok(fs.existsSync(path.join(dir, 'LGCY1.jsonl')), 'old JSONL is never deleted');
  manager.close();
});

test('full server restart: room restores, host rejoins the same seat, agent resumes, replay works', async (t) => {
  const dataDir = tmpDir(t);
  const s1 = createCollagentServer({ dataDir });
  const addr1 = await s1.listen(0, '127.0.0.1');
  const url1 = `ws://127.0.0.1:${addr1.port}`;

  const alice = new CollagentClient({ serverUrl: url1, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  const code = created.session.code;

  const host = new AgentHost({ serverUrl: url1, code, agentToken: created.agentToken, adapter: new MockAdapter({ delay: 1 }) });
  await host.start();
  const gotResult = new Promise((resolve) => {
    alice.on('event', (e) => e.kind === 'result' && resolve(e));
  });
  alice.sendInstruction('before restart');
  const firstResult = await gotResult;

  await host.stop();
  alice.close();
  await s1.close();

  // New process, same data dir.
  const s2 = createCollagentServer({ dataDir });
  const addr2 = await s2.listen(0, '127.0.0.1');
  const url2 = `ws://127.0.0.1:${addr2.port}`;
  t.after(() => s2.close());

  const room = s2.manager.get(code);
  assert.ok(room, 'room restored on boot');
  assert.equal(room.primaryAgent().agentId, 'mock-1');

  // The host resumes their identity with stored credentials and replays only
  // what they missed.
  const back = new CollagentClient({ serverUrl: url2, name: 'Alice' });
  await back.connect();
  back._send({
    type: 'rejoin',
    code,
    participantId: created.self.participantId,
    resumeToken: created.self.resumeToken,
    sinceSeq: firstResult.seq,
  });
  const welcome = await back._await('reconnected');
  assert.equal(back.self.participantId, created.self.participantId, 'same seat across restarts');
  assert.ok(!welcome.events.some((e) => e.seq <= firstResult.seq), 'missed-sequence replay only');
  assert.ok(back.agentToken, 'host gets a fresh re-attach grant');

  // Re-attach an agent to the restored room and keep working.
  const host2 = new AgentHost({ serverUrl: url2, code, agentToken: back.agentToken, adapter: new MockAdapter({ delay: 1 }) });
  await host2.start();
  t.after(() => host2.stop());
  const done = new Promise((resolve) => back.on('event', (e) => e.kind === 'result' && resolve(e)));
  back.sendInstruction('after restart');
  const result = await done;
  assert.match(result.data.text, /after restart/);
  assert.equal(result.agentId, 'mock-1', 'the restored AgentSession identity continues');
  back.close();
});

test('the indexed event store serves paged reads when available', async (t) => {
  const dataDir = tmpDir(t);
  const manager = new SessionManager({ dataDir });
  const session = manager.create({ agentType: 'mock' });
  for (let i = 0; i < 10; i++) {
    session.append('instruction', { type: 'user', name: 'A' }, { text: `msg ${i}` });
  }
  const page = manager.store.readEvents(session.code, { since: 5, limit: 3 });
  if (manager.store.backend === 'sqlite') {
    assert.equal(page.length, 3);
    assert.deepEqual(page.map((e) => e.seq), [6, 7, 8]);
  } else {
    assert.equal(page, null, 'jsonl fallback signals callers to use the in-memory log');
  }
  manager.close();
});
