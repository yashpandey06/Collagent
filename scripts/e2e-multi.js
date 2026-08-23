#!/usr/bin/env node
/**
 * End-to-end proof of the multi-agent architecture — scenarios A through E:
 *
 *   A. existing single-agent flow (unchanged default)
 *   B. handoff with structured context
 *   C. persistent room across host disconnect + catch-up on return
 *   D. multi-agent opt-in (Add agent)
 *   E. cross-agent conference: shared events, private contexts
 *
 * Runs in-process with mock adapters by default (deterministic, free).
 * `node scripts/e2e-multi.js --real` runs scenario E with REAL Claude Code +
 * Codex headless adapters instead (needs both CLIs and makes API calls).
 */
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient, AgentHost } from '../src/client/client.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { catchupSummary } from '../src/core/catchup.js';
import { paint } from '../src/ui/colors.js';

const real = process.argv.includes('--real');
const step = (msg) => console.log(paint.bold(paint.cyan(`\n▸ ${msg}`)));
const ok = (msg) => console.log(paint.green(`  ✓ ${msg}`));
const fail = (msg) => {
  console.error(paint.red(`  ✗ ${msg}`));
  process.exit(1);
};

function seen(client) {
  if (!client._seen) {
    client._seen = [];
    client.on('event', (e) => client._seen.push(e));
  }
  return client._seen;
}

function waitFor(client, predicate, timeoutMs, label) {
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
        reject(new Error(`timed out waiting for ${label} (saw: ${client._seen.map((e) => e.kind).join(', ')})`));
      }
    }, 25);
  });
}

const server = createCollagentServer({ dataDir: null });
const addr = await server.listen(0, '127.0.0.1');
const serverUrl = `ws://127.0.0.1:${addr.port}`;

// ---------------------------------------------------------------- scenario A
step('A · single-agent flow — create, join, instruct, result (the unchanged default)');
const alice = new CollagentClient({ serverUrl, name: 'Alice' });
await alice.connect();
const created = await alice.createSession({ agentType: 'mock' });
const code = created.session.code;
const host1 = new AgentHost({ serverUrl, code, agentToken: created.agentToken, adapter: new MockAdapter({ delay: 5 }) });
await host1.start();
ok(`room ${code} created · agent ${host1.agentId} attached`);

const bob = new CollagentClient({ serverUrl, name: 'Bob' });
await bob.connect();
await bob.join(code);
seen(alice); seen(bob);
bob.sendInstruction('Add OAuth callback validation.');
const aResult = await waitFor(bob, (e) => e.kind === 'result', 4000, 'result');
await waitFor(alice, (e) => e.kind === 'result', 4000, 'result on the other terminal');
if ((bob.session.agents ?? []).length !== 1) fail('room should have exactly one agent');
ok(`instruction executed by ${aResult.agentId}, turn ${aResult.turnId} — both participants saw it`);

// ---------------------------------------------------------------- scenario B
step('B · handoff — Alice hands off to Bob with structured context, no loss');
alice.control('handoff', { target: 'Bob' });
const handoff = await waitFor(bob, (e) => e.kind === 'handoff_completed', 4000, 'handoff');
if (handoff.data.to.name !== 'Bob') fail('handoff target wrong');
if (!handoff.data.context?.objective) fail('handoff lost the objective');
bob.sendInstruction('continue where Alice left off');
await waitFor(bob, (e) => e.kind === 'result' && /continue where Alice/.test(e.data.text ?? ''), 4000, 'post-handoff result');
ok(`driver moved to Bob · context carried objective “${handoff.data.context.objective}”`);

// ---------------------------------------------------------------- scenario C
step('C · persistent room — Alice disconnects, room remains, catch-up on return');
const aliceSeat = { participantId: alice.self.participantId, resumeToken: alice.self.resumeToken };
const lastSeen = alice.lastSeq;
alice.close();
await waitFor(bob, (e) => e.kind === 'participant_disconnected', 4000, 'alice drop');
bob.sendInstruction('work while alice is away');
await waitFor(bob, (e) => e.kind === 'result' && /alice is away/.test(e.data.text ?? ''), 4000, 'work in her absence');
if (!server.manager.get(code)) fail('room vanished');

const aliceBack = new CollagentClient({ serverUrl, name: 'Alice' });
await aliceBack.connect();
aliceBack._send({ type: 'rejoin', code, ...aliceSeat, sinceSeq: lastSeen });
const welcomeBack = await aliceBack._await('reconnected');
const digest = catchupSummary(welcomeBack.events, { selfName: 'Alice' });
if (!digest.some((l) => /work while alice is away/.test(l)) && !digest.some((l) => /turn/.test(l))) {
  fail(`catch-up missed the action: ${JSON.stringify(digest)}`);
}
console.log(paint.dim('    SINCE YOU WERE AWAY'));
for (const line of digest) console.log(paint.dim(`      ${line}`));
ok('same seat resumed · missed events replayed · digest derived');

// ---------------------------------------------------------------- scenario D
step('D · multi-agent opt-in — Add agent turns the room multi-agent');
const before = (aliceBack.session.agents ?? []).length;
if (before !== 1) fail('room must still be single-agent before the opt-in');
const added = await aliceBack.addAgent('mock');
const host2 = new AgentHost({ serverUrl, code, agentToken: added.agentToken, adapter: new MockAdapter({ delay: 5 }) });
await host2.start();
await waitFor(bob, (e) => e.kind === 'agent_session_attached' && e.agentId === added.agent.agentId, 4000, 'second agent');
ok(`${added.agent.agentId} joined — room now shows ${bob.session.agents.length} agents (${bob.session.agents.map((a) => a.agentId).join(' + ')})`);

// ---------------------------------------------------------------- scenario E
step(`E · cross-agent conference — shared coordination, private contexts${real ? ' (REAL claude + codex)' : ''}`);
let agentA = 'mock-1';
let agentB = added.agent.agentId;
let hostA = null;
let hostB = null;

if (real) {
  const { ClaudeCodeAdapter } = await import('../src/adapters/claude/headless.js');
  const { CodexAppServerAdapter } = await import('../src/adapters/codex/app-server.js');
  const addedClaude = await aliceBack.addAgent('claude-code');
  hostA = new AgentHost({ serverUrl, code, agentToken: addedClaude.agentToken, adapter: new ClaudeCodeAdapter({ cwd: process.cwd() }) });
  await hostA.start();
  const addedCodex = await aliceBack.addAgent('codex');
  hostB = new AgentHost({ serverUrl, code, agentToken: addedCodex.agentToken, adapter: new CodexAppServerAdapter({ cwd: process.cwd() }) });
  await hostB.start();
  agentA = addedClaude.agent.agentId;
  agentB = addedCodex.agent.agentId;
  ok(`real agents attached: ${agentA} + ${agentB}`);
}

const timeoutE = real ? 120_000 : 4000;
aliceBack.sendInstruction(
  real ? 'Reply with exactly this sentence and nothing else: The backend expects payment_intent_id.'
       : 'backend expects payment_intent_id',
  { to: agentA },
);
const claudeSaid = await waitFor(aliceBack, (e) => e.kind === 'agent_message' && e.agentId === agentA && /payment_intent_id/.test(e.data.text ?? ''), timeoutE, `${agentA} finding`);
ok(`${agentA} finding became a shared room event: “${String(claudeSaid.data.text).slice(0, 60).replace(/\n/g, ' ')}…”`);

bob.sendInstruction(
  real ? 'Reply with exactly this sentence and nothing else: The frontend now sends payment_intent_id.'
       : 'frontend now sends payment_intent_id',
  { to: agentB },
);
const codexSaid = await waitFor(bob, (e) => e.kind === 'agent_message' && e.agentId === agentB && /payment_intent_id/.test(e.data.text ?? ''), timeoutE, `${agentB} answer`);
ok(`${agentB} worked in its own context and reported back: “${String(codexSaid.data.text).slice(0, 60).replace(/\n/g, ' ')}…”`);

const crossTalk = seen(bob).filter((e) => e.kind === 'instruction' && e.agentId === agentA && /frontend now sends/.test(e.data.text ?? ''));
if (crossTalk.length) fail('an addressed instruction leaked to the wrong agent');
ok('independent execution + shared coordination — no merged conversation');

step('all scenarios verified');
await hostA?.stop();
await hostB?.stop();
await host1.stop();
await host2.stop();
aliceBack.close();
bob.close();
await server.close();
console.log(paint.green(paint.bold('\n✓ e2e multi-agent proof complete\n')));
process.exit(0);
