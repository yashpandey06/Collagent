import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chatsDirFor, extractBlobEvents, CursorChatTail } from '../src/adapters/cursor/store.js';
import { CursorNativeAdapter } from '../src/adapters/cursor/native.js';
import { CursorAgentAdapter, normalizeCursorEvent } from '../src/adapters/cursor/headless.js';
import { describeAdapter, findRuntime, adapterFor } from '../src/adapters/registry.js';

const FAKE_CURSOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cursor-agent.js');

let sqlite = null;
try {
  sqlite = await import('node:sqlite');
} catch { /* tail tests skip below */ }

test('cursor store: chat records translate to normalized events', () => {
  // prose + tool call: message and tool_use, turn keeps running
  const working = extractBlobEvents({
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '' },
      { type: 'text', text: "I'll run ls and count the entries." },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'Shell', args: { command: 'ls' } },
    ],
  });
  assert.deepEqual(working.map((e) => e.kind), ['agent_message', 'tool_use']);
  assert.equal(working[1].tool, 'Shell');
  assert.match(working[1].input, /ls/);

  // tool result, with non-zero exit surfacing as an error
  const [ok] = extractBlobEvents({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'Shell', result: 'Exit code: 0\n\nfine' }],
  });
  assert.equal(ok.kind, 'tool_result');
  assert.equal(ok.isError, false);
  const [bad] = extractBlobEvents({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'Shell', result: 'Exit code: 1\n\nboom' }],
  });
  assert.equal(bad.isError, true);

  // prose with no tool calls ends the turn
  const done = extractBlobEvents({
    role: 'assistant',
    content: [{ type: 'reasoning', text: '' }, { type: 'text', text: '`ls` printed 0 entries.' }],
  });
  assert.deepEqual(done.map((e) => e.kind), ['agent_message', 'result', 'agent_status']);
  assert.equal(done[2].status, 'idle');

  // reasoning-only records stay private
  assert.deepEqual(extractBlobEvents({ role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }] }), []);

  // real prompts arrive wrapped in <user_query>; injected context does not
  const typed = extractBlobEvents({
    role: 'user',
    content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\nfix the tests\n</user_query>' }],
  });
  assert.deepEqual(typed.map((e) => e.kind), ['agent_status', 'local_prompt']);
  assert.equal(typed[1].text, 'fix the tests');
  assert.deepEqual(extractBlobEvents({ role: 'user', content: '<user_info>env stuff</user_info>' }), []);
  assert.deepEqual(extractBlobEvents({ role: 'system', content: 'You are…' }), []);
});

test('cursor store: chats dir is keyed by md5 of the workspace path', () => {
  const hash = createHash('md5').update('/Users/alice/dev/api').digest('hex');
  assert.equal(chatsDirFor('/Users/alice/dev/api', '/home/x'), path.join('/home/x', '.cursor', 'chats', hash));
});

test('cursor store: tail follows a live chat and resume skips history', { skip: !sqlite }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-cursor-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-cursor-cwd-'));
  const chatId = 'chat-abc';
  const chatDir = path.join(chatsDirFor(cwd, home), chatId);
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, 'meta.json'), JSON.stringify({ name: 'Friendly Hello' }));

  const db = new sqlite.DatabaseSync(path.join(chatDir, 'store.db'));
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const put = (id, obj) => db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
    .run(id, Buffer.from(JSON.stringify(obj)));
  put('b1', { role: 'system', content: 'You are…' });
  put('b2', {
    role: 'user',
    content: [{ type: 'text', text: '<user_query>[Bob] hy</user_query>' }],
  });

  const seen = [];
  const tail = new CursorChatTail({ cwd, home, onEvent: (e) => seen.push(e), intervalMs: 40 });
  tail.sinceMs = 0; // fixture dirs predate "now"
  await tail.start();
  await waitFor(() => seen.some((e) => e.kind === 'local_prompt'));

  assert.equal(seen.find((e) => e.status === 'ready')?.detail.sessionId, chatId);
  assert.equal(seen.find((e) => e.kind === 'session_title')?.title, 'Friendly Hello');
  assert.equal(seen.find((e) => e.kind === 'local_prompt')?.text, '[Bob] hy');

  // a reply lands in the store → the room sees it, and the turn completes
  put('b3', { role: 'assistant', content: [{ type: 'text', text: 'Hey — what can I help with?' }] });
  await waitFor(() => seen.some((e) => e.kind === 'agent_message'));
  assert.equal(seen.find((e) => e.kind === 'agent_message')?.text, 'Hey — what can I help with?');
  assert.ok(seen.some((e) => e.kind === 'result' && e.ok));
  tail.stop();

  // resuming attaches to the stored chat but replays nothing
  const later = [];
  const resumed = new CursorChatTail({
    cwd, home, sessionId: chatId, resume: true, onEvent: (e) => later.push(e), intervalMs: 40,
  });
  await resumed.start();
  await waitFor(() => later.some((e) => e.status === 'ready'));
  assert.ok(!later.some((e) => e.kind === 'agent_message'), 'history stays in the room log, not re-broadcast');

  put('b4', { role: 'assistant', content: [{ type: 'text', text: 'Picking up where we left off.' }] });
  await waitFor(() => later.some((e) => e.kind === 'agent_message'));
  resumed.stop();
  db.close();

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('cursor native: injected instructions are not echoed as local prompts', () => {
  const adapter = new CursorNativeAdapter();
  const seen = [];
  adapter.attach((e) => seen.push(e));
  adapter._inject({ text: 'add oauth', from: { name: 'Bob' } });
  adapter._onStoreEvent({ kind: 'local_prompt', text: '[Bob] add oauth' });
  assert.equal(seen.filter((e) => e.kind === 'local_prompt').length, 0);
  adapter._onStoreEvent({ kind: 'local_prompt', text: 'host typed this' });
  assert.equal(seen.filter((e) => e.kind === 'local_prompt').length, 1);
});

test('cursor stream-json: events normalize like the real wire format', () => {
  const [ready] = normalizeCursorEvent({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', cwd: '/w' });
  assert.equal(ready.detail.sessionId, 's1');

  const [msg] = normalizeCursorEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  assert.equal(msg.kind, 'agent_message');

  const [use] = normalizeCursorEvent({
    type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'ls' } } },
  });
  assert.equal(use.tool, 'shell');
  assert.match(use.input, /ls/);

  const [res] = normalizeCursorEvent({
    type: 'tool_call', subtype: 'completed', tool_call: { readToolCall: { args: {}, result: { success: { totalLines: 3 } } } },
  });
  assert.equal(res.kind, 'tool_result');
  assert.equal(res.isError, false);

  const done = normalizeCursorEvent({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 9 });
  assert.deepEqual(done.map((e) => e.kind), ['result', 'agent_status']);
  assert.equal(done[0].ok, true);

  assert.deepEqual(normalizeCursorEvent({ type: 'user', message: {} }), []);
});

test('registry: cursor runtime is available with both adapter shapes', () => {
  const runtime = findRuntime('cursor');
  assert.equal(runtime.status, 'available');
  assert.equal(adapterFor('cursor'), 'cursor-native');
  assert.equal(adapterFor('cursor', { headless: true }), 'cursor');
  assert.equal(describeAdapter('cursor-native').ownsTerminal, true);
  assert.deepEqual(
    describeAdapter('cursor-native').resumeOptions('c1'),
    { extraArgs: ['--resume', 'c1'], sessionId: 'c1', resume: true },
  );
  assert.deepEqual(describeAdapter('cursor').resumeOptions('c1'), { sessionId: 'c1', resume: true });
});

test('cursor headless: full turns against the fake CLI, resuming one session', async () => {
  const adapter = new CursorAgentAdapter({ cursorPath: FAKE_CURSOR, cwd: os.tmpdir() });
  const events = [];
  adapter.attach((e) => events.push(e));
  await adapter.createSession();

  const turn = () => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no result')), 5000);
    const off = adapter.attach((e) => {
      if (e.kind === 'result') { clearTimeout(t); off(); resolve(); }
    });
  });

  const done1 = turn();
  await adapter.sendInstruction({ text: 'first task', from: { name: 'Bob' } });
  await done1;

  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('tool_use') && kinds.includes('tool_result'));
  const echo = events.find((e) => e.kind === 'agent_message');
  assert.match(echo.text, /\[Bob\] first task/);
  assert.ok(adapter.sessionId, 'session id captured from init');
  const firstSession = adapter.sessionId;

  const done2 = turn();
  await adapter.sendInstruction({ text: 'second task', from: { name: 'Alice' } });
  await done2;
  assert.equal(adapter.sessionId, firstSession, 'same conversation resumed');
  assert.match(events.filter((e) => e.kind === 'agent_message').at(-1).text, /resumed/);

  await adapter.disconnect();
});

test('cursor headless: paused instructions queue and flush on resume', async () => {
  const adapter = new CursorAgentAdapter({ cursorPath: FAKE_CURSOR, cwd: os.tmpdir() });
  await adapter.createSession();
  await adapter.pause();
  const { queued } = await adapter.sendInstruction({ text: 'later', from: { name: 'Bob' } });
  assert.equal(queued, true);

  const done = new Promise((resolve) => {
    adapter.attach((e) => e.kind === 'result' && resolve());
  });
  await adapter.resume();
  await done;
  await adapter.disconnect();
});

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('timed out')); }
    }, 20);
  });
}
