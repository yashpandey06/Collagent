import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient, AgentHost } from '../src/client/client.js';
import { MockAdapter } from '../src/adapters/mock.js';

// Multi-agent rooms: an explicit opt-in on top of the unchanged single-agent
// default. Each AgentSession keeps its own adapter (private runtime context);
// the room is the shared coordination layer.

async function boot(t) {
  const server = createCollagentServer({ dataDir: null });
  const addr = await server.listen(0, '127.0.0.1');
  const serverUrl = `ws://127.0.0.1:${addr.port}`;
  t.after(() => server.close());

  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  const code = created.session.code;

  const adapter1 = new MockAdapter({ delay: 2 });
  const host1 = new AgentHost({ serverUrl, code, agentToken: created.agentToken, adapter: adapter1 });
  await host1.start();
  t.after(() => host1.stop());

  return { server, serverUrl, alice, code, created, adapter1, host1 };
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

async function addAgent(t, client, serverUrl, code, agentType = 'mock') {
  const added = await client.addAgent(agentType);
  const adapter = new MockAdapter({ delay: 2 });
  const host = new AgentHost({ serverUrl, code, agentToken: added.agentToken, adapter });
  await host.start();
  t.after(() => host.stop());
  return { added, adapter, host };
}

test('single-agent room stays simple: plain instructions route with no addressing', async (t) => {
  const { created, alice } = await boot(t);
  seen(alice);
  alice.sendInstruction('fix the bug');
  const result = await waitForEvent(alice, (e) => e.kind === 'result');
  assert.match(result.data.text, /fix the bug/);
  assert.equal(result.agentId, 'mock-1', 'events carry the agent id even in single-agent rooms');
  assert.equal((alice.session.agents ?? []).length, 1);
});

test('add agent: same runtime twice gets stable distinct ids; host permission enforced', async (t) => {
  const { created, server, serverUrl, alice, code } = await boot(t);
  seen(alice);

  const { added } = await addAgent(t, alice, serverUrl, code);
  assert.equal(added.agent.agentId, 'mock-2');
  assert.match(added.agent.id, /^as_/);
  await waitForEvent(alice, (e) => e.kind === 'agent_session_attached' && e.agentId === 'mock-2');

  const session = server.manager.get(code);
  assert.deepEqual([...session.agentSessions.keys()], ['mock-1', 'mock-2']);
  assert.equal(session.status, 'idle');

  // A collaborator (not host, not driver) may not add agents.
  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  await bob.join(code, { key: created.joinKey });
  await assert.rejects(() => bob.addAgent('mock'), /permission/);
  bob.close();
  alice.close();
});

test('addressed instructions: @agent routes, default agent works, ambiguity is explicit', async (t) => {
  const { created, serverUrl, alice, code, adapter1 } = await boot(t);
  seen(alice);
  const received1 = [];
  const originalSend1 = adapter1.sendInstruction.bind(adapter1);
  adapter1.sendInstruction = (i) => { received1.push(i.text); return originalSend1(i); };

  const { adapter } = await addAgent(t, alice, serverUrl, code);
  const received2 = [];
  const originalSend2 = adapter.sendInstruction.bind(adapter);
  adapter.sendInstruction = (i) => { received2.push(i.text); return originalSend2(i); };

  // Two agents, no target, no default: the server asks instead of guessing.
  const denied = new Promise((resolve) => alice.once('server-error', resolve));
  alice.sendInstruction('who gets this?');
  assert.match(await denied, /several agents/);

  // Addressed delivery goes to exactly one agent's private context.
  alice.sendInstruction('inspect the frontend', { to: 'mock-2' });
  await waitForEvent(alice, (e) => e.kind === 'result' && e.agentId === 'mock-2');
  assert.deepEqual(received2, ['inspect the frontend']);
  assert.deepEqual(received1, [], 'the other agent never sees an addressed instruction');

  // Addressing set the sender's default: plain text now follows it.
  alice.sendInstruction('and the tests');
  await waitForEvent(alice, (e) => e.kind === 'result' && e.data.text.includes('and the tests'));
  assert.deepEqual(received2, ['inspect the frontend', 'and the tests']);

  // /use switches the default explicitly.
  alice.control('use_agent', { target: 'mock-1' });
  await new Promise((r) => alice.once('ok', r));
  alice.sendInstruction('backend please');
  await waitForEvent(alice, (e) => e.kind === 'result' && e.agentId === 'mock-1');
  assert.deepEqual(received1, ['backend please']);
  alice.close();
});

test('turns are first-class: explicit ids bracket each execution and stamp its events', async (t) => {
  const { created, alice } = await boot(t);
  seen(alice);
  alice.sendInstruction('do the thing');
  const completed = await waitForEvent(alice, (e) => e.kind === 'turn_completed');
  const started = alice._seen.find((e) => e.kind === 'turn_started');

  assert.ok(started, 'turn_started emitted');
  assert.match(started.data.turnId, /^turn_/);
  assert.equal(completed.data.turnId, started.data.turnId);
  assert.equal(completed.data.ok, true);
  assert.equal(completed.data.toolCalls, 1, 'mock adapter makes one tool call per turn');
  assert.ok(completed.data.durationMs >= 0);
  assert.equal(completed.turnId, started.data.turnId, 'the event itself is stamped too');

  const toolUse = alice._seen.find((e) => e.kind === 'tool_use');
  assert.equal(toolUse.turnId, started.data.turnId, 'mid-turn events carry the turnId');
  assert.equal(toolUse.agentSessionId, started.agentSessionId);
  assert.equal(toolUse.roomId, alice.session.code);
  alice.close();
});

test('cross-agent conference: shared room events, private contexts, concurrent work', async (t) => {
  const { created, serverUrl, alice, code } = await boot(t);
  seen(alice);
  await addAgent(t, alice, serverUrl, code);

  // Both agents work concurrently on their own instructions.
  alice.sendInstruction('investigate backend', { to: 'mock-1' });
  alice.sendInstruction('inspect frontend', { to: 'mock-2' });
  await waitForEvent(alice, (e) => e.kind === 'result' && e.agentId === 'mock-1');
  await waitForEvent(alice, (e) => e.kind === 'result' && e.agentId === 'mock-2');

  // Every agent's prose is a shared room event, labeled with its author.
  const messages = alice._seen.filter((e) => e.kind === 'agent_message');
  assert.ok(messages.some((e) => e.agentId === 'mock-1' && /investigate backend/.test(e.data.text)));
  assert.ok(messages.some((e) => e.agentId === 'mock-2' && /inspect frontend/.test(e.data.text)));

  // Coordination without merging: each mock echoes only what it was told —
  // proof the runtimes share the room, not a conversation.
  assert.ok(!messages.some((e) => e.agentId === 'mock-1' && /frontend/.test(e.data.text)));
  assert.ok(!messages.some((e) => e.agentId === 'mock-2' && /backend/.test(e.data.text)));
  alice.close();
});

test('room survives one agent detaching while the other keeps working', async (t) => {
  const { created, server, serverUrl, alice, code } = await boot(t);
  seen(alice);
  const { host } = await addAgent(t, alice, serverUrl, code);

  await host.stop(); // mock-2's host process dies
  await waitForEvent(alice, (e) => e.kind === 'agent_session_detached' && e.agentId === 'mock-2');

  const session = server.manager.get(code);
  assert.equal(session.lifecycle, 'active');
  assert.equal(session.getAgentSession('mock-2').status, 'disconnected');

  // mock-1 is now the only *attached* agent — plain instructions route to it again.
  alice.sendInstruction('still here?');
  const result = await waitForEvent(alice, (e) => e.kind === 'result' && /still here/.test(e.data.text ?? ''));
  assert.equal(result.agentId, 'mock-1');
  alice.close();
});

test('handoff to an agent persists structured context and briefs the agent', async (t) => {
  const { created, serverUrl, alice, code, adapter1 } = await boot(t);
  seen(alice);
  const received1 = [];
  const originalSend = adapter1.sendInstruction.bind(adapter1);
  adapter1.sendInstruction = (i) => { received1.push(i.text); return originalSend(i); };
  await addAgent(t, alice, serverUrl, code);

  alice.sendInstruction('use payment_intent_id everywhere', { to: 'mock-2' });
  await waitForEvent(alice, (e) => e.kind === 'result' && e.agentId === 'mock-2');

  alice.control('handoff', { target: '@mock-1' });
  const handoff = await waitForEvent(alice, (e) => e.kind === 'handoff_completed');
  assert.deepEqual(handoff.data.to, { type: 'agent', id: 'mock-1', name: 'mock-1' });
  assert.ok(handoff.data.context.objective, 'context carries the room objective');
  assert.ok(handoff.data.context.recent.length >= 1, 'context carries recent direction');
  assert.ok(handoff.data.context.agents.length === 2, 'context carries the agent roster');

  await waitForEvent(alice, (e) => e.kind === 'result' && e.agentId === 'mock-1');
  assert.match(received1[0], /Handoff from Alice/);
  assert.match(received1[0], /payment_intent_id/);

  // After handoff the room's focus is mock-1: plain sends from anyone route there.
  const bob = new CollagentClient({ serverUrl, name: 'Bob' });
  await bob.connect();
  await bob.join(code, { key: created.joinKey });
  seen(bob);
  bob.sendInstruction('carry on');
  const result = await waitForEvent(bob, (e) => e.kind === 'result' && /carry on/.test(e.data.text ?? ''));
  assert.equal(result.agentId, 'mock-1');
  bob.close();
  alice.close();
});

test('usage lands on turn_completed and aggregates per agent over HTTP', async (t) => {
  const server = createCollagentServer({ dataDir: null });
  const addr = await server.listen(0, '127.0.0.1');
  const serverUrl = `ws://127.0.0.1:${addr.port}`;
  t.after(() => server.close());

  const alice = new CollagentClient({ serverUrl, name: 'Alice' });
  await alice.connect();
  const created = await alice.createSession({ agentType: 'mock' });
  const code = created.session.code;

  // An adapter that reports usage on its result events (the claude-headless shape).
  class UsageMock extends MockAdapter {
    async _run({ text, from }) {
      this.emit({ kind: 'agent_status', status: 'working' });
      this.emit({ kind: 'tool_use', tool: 'MockTool', input: '{}' });
      this.emit({
        kind: 'result',
        ok: true,
        text: `done: ${text}`,
        durationMs: 5,
        usage: { provider: 'anthropic', runtime: 'claude', model: 'mock-1', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: null, providerCost: 0.01, currency: 'USD' },
      });
      this.emit({ kind: 'agent_status', status: 'idle' });
      return { queued: false, from };
    }
  }
  const host = new AgentHost({ serverUrl, code, agentToken: created.agentToken, adapter: new UsageMock({ delay: 1 }) });
  await host.start();
  t.after(() => host.stop());
  seen(alice);

  alice.sendInstruction('one');
  await waitForEvent(alice, (e) => e.kind === 'turn_completed');
  alice.sendInstruction('two');
  await waitForEvent(alice, (e) => e.kind === 'turn_completed' && alice._seen.filter((x) => x.kind === 'turn_completed').length === 2);

  const res = await fetch(`http://127.0.0.1:${addr.port}/api/sessions/${code}/usage`);
  const usage = await res.json();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].agentId, 'mock-1');
  assert.equal(usage[0].turns, 2);
  assert.equal(usage[0].inputTokens, 200);
  assert.equal(usage[0].outputTokens, 40);
  assert.equal(usage[0].cacheReadTokens, 10);
  assert.equal(usage[0].cacheWriteTokens, null, 'unknown stays null, never invented');
  assert.ok(Math.abs(usage[0].providerCost - 0.02) < 1e-9);
  assert.equal(usage[0].toolCalls, 2);
  alice.close();
});
