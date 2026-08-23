#!/usr/bin/env node
/**
 * End-to-end proof of the first milestone, against REAL Claude Code:
 *
 *   Alice creates session → Claude Code starts → Bob joins →
 *   both see live activity → Bob sends instruction → Claude Code executes →
 *   both see the result.
 *
 * Runs everything in-process (server + two participant clients + agent host)
 * so it can be verified in one command:  npm run demo
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createCollagentServer } from '../src/server/server.js';
import { CollagentClient, AgentHost } from '../src/client/client.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude/headless.js';
import { renderEvent } from '../src/ui/tui.js';
import { paint } from '../src/ui/colors.js';

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
    }, 50);
  });
}

// ---------------------------------------------------------------------------

try {
  execSync('claude --version', { stdio: 'ignore' });
} catch {
  fail('claude CLI not found — install Claude Code first (https://claude.com/claude-code)');
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-demo-'));
console.log(paint.bold('Collagent end-to-end demo (real Claude Code)'));
console.log(paint.dim(`agent workspace: ${workspace}`));

step('starting session server');
const server = createCollagentServer({ dataDir: null });
const addr = await server.listen(0, '127.0.0.1');
const serverUrl = `ws://127.0.0.1:${addr.port}`;
ok(`server on ${serverUrl}`);

step('Alice creates a shared session');
const alice = new CollagentClient({ serverUrl, name: 'Alice' });
await alice.connect();
const created = await alice.createSession({ agentType: 'claude-code' });
const code = created.session.code;
seen(alice);
ok(`session ${code} created — invite: collagent join ${code}`);

step('Claude Code starts (via ClaudeCodeAdapter)');
const adapter = new ClaudeCodeAdapter({ cwd: workspace, permissionMode: 'acceptEdits' });
const host = new AgentHost({ serverUrl, code, agentToken: alice.agentToken, adapter });
await host.start();

step('Bob joins from a second connection');
const bob = new CollagentClient({ serverUrl, name: 'Bob' });
await bob.connect();
const welcome = await bob.join(code);
// Bob's view = replayed history (everything before he joined) + live events.
seen(bob).push(...welcome.events);
ok(`Bob joined; sees participants: ${welcome.session.participants.map((p) => p.name).join(', ')}`);
ok(`history replayed to Bob: ${welcome.events.length} events (${welcome.events.map((e) => e.kind).join(', ')})`);

// Bob's live feed, rendered exactly like the TUI would
bob.on('event', (e) => {
  const line = renderEvent(e, { selfId: bob.self.participantId });
  if (line) console.log(paint.dim('  [bob sees] ') + line);
});

await waitFor(bob, (e) => e.kind === 'agent_status' && e.data.status === 'ready', 60_000, 'claude ready');
ok('both participants see Claude Code online');

step('Bob sends an instruction to the shared agent');
const instruction =
  'Create a file named hello.txt containing exactly this one line: hello from collagent';
bob.sendInstruction(instruction);

const result = await waitFor(bob, (e) => e.kind === 'result', 180_000, 'turn result');
if (!result.data.ok) fail(`turn failed: ${JSON.stringify(result.data)}`);
ok(`Claude Code finished the turn in ${(result.data.durationMs / 1000).toFixed(1)}s`);

step('verifying both sides saw the same live activity');
const aliceResult = await waitFor(alice, (e) => e.kind === 'result', 10_000, 'result on Alice side');
if (aliceResult.seq !== result.seq) fail('Alice and Bob saw different result events');
for (const kind of ['instruction', 'agent_status', 'result']) {
  const a = alice._seen.filter((e) => e.kind === kind).length;
  const b = bob._seen.filter((e) => e.kind === kind).length;
  if (a === 0 || b === 0) fail(`event kind ${kind} missing (alice=${a} bob=${b})`);
}
const instrEvent = alice._seen.find((e) => e.kind === 'instruction');
if (instrEvent.actor.name !== 'Bob') fail('instruction not attributed to Bob');
ok('identical shared event stream on both sides (instruction attributed to Bob)');

step('verifying Claude Code actually executed');
const outFile = path.join(workspace, 'hello.txt');
if (!fs.existsSync(outFile)) fail(`expected ${outFile} to exist`);
const content = fs.readFileSync(outFile, 'utf8').trim();
if (content !== 'hello from collagent') fail(`unexpected file content: ${JSON.stringify(content)}`);
ok(`hello.txt created by Claude Code with correct content`);

step('exercising pause / resume / handoff');
alice.control('pause');
await waitFor(bob, (e) => e.kind === 'session_paused', 5_000, 'pause');
const deny = new Promise((resolve) => bob.once('server-error', resolve));
bob.sendInstruction('this must be rejected while paused');
const denyMsg = await deny;
ok(`paused session rejected Bob's instruction ("${denyMsg}")`);
alice.control('resume');
await waitFor(bob, (e) => e.kind === 'session_resumed', 5_000, 'resume');
alice.control('handoff', { target: 'Bob' });
const handoff = await waitFor(bob, (e) => e.kind === 'handoff_completed', 5_000, 'handoff');
ok(`control handed to ${handoff.data.to.name}`);

step('shutting down');
alice.control('end');
await new Promise((r) => setTimeout(r, 500));
await host.stop().catch(() => {});
alice.close();
bob.close();
await server.close();

console.log(paint.bold(paint.green('\n★ Milestone verified end to end:')));
console.log(
  '  create session → invite Bob → Bob joins → both see live activity →\n' +
  '  Bob sends instruction → Claude Code executes → both receive the result\n',
);
console.log(paint.dim(`workspace kept for inspection: ${workspace}`));
process.exit(0);
