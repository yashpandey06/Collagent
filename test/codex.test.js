import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateAppServerEvent, isServerRequest, isResponse } from '../src/adapters/codex/protocol.js';
import { translateCodexHookEvent, HOOK_EVENTS } from '../src/adapters/codex/hooks.js';
import { CodexAppServerAdapter } from '../src/adapters/codex/app-server.js';
import { describeAdapter, adapterFor, findRuntime } from '../src/adapters/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = path.join(__dirname, 'fixtures', 'fake-codex-app-server.js');

// ---- app-server protocol translation ---------------------------------------

test('app-server: turn lifecycle → working / result / idle', () => {
  assert.deepEqual(
    translateAppServerEvent({ method: 'turn/started', params: {} }).map((e) => e.status),
    ['working'],
  );

  const done = translateAppServerEvent({
    method: 'turn/completed',
    params: { turn: { status: 'completed' } },
  });
  assert.deepEqual(done.map((e) => e.kind), ['result', 'agent_status']);
  assert.equal(done[0].ok, true);
  assert.equal(done[1].status, 'idle');

  // An interrupted turn is a real turn outcome, not a success.
  const stopped = translateAppServerEvent({
    method: 'turn/completed',
    params: { turn: { status: 'interrupted' } },
  });
  assert.equal(stopped[0].ok, false);
});

test('app-server: command execution → tool_use then tool_result', () => {
  const [use] = translateAppServerEvent({
    method: 'item/started',
    params: { item: { type: 'commandExecution', command: 'npm test' } },
  });
  assert.equal(use.kind, 'tool_use');
  assert.equal(use.tool, 'shell');
  assert.match(use.input, /npm test/);

  const [ok] = translateAppServerEvent({
    method: 'item/completed',
    params: { item: { type: 'commandExecution', aggregatedOutput: 'all tests passed\n\n', exitCode: 0 } },
  });
  assert.equal(ok.kind, 'tool_result');
  assert.match(ok.summary, /all tests passed/);
  assert.equal(ok.isError, false);

  const [failed] = translateAppServerEvent({
    method: 'item/completed',
    params: { item: { type: 'commandExecution', aggregatedOutput: 'boom', exitCode: 1 } },
  });
  assert.equal(failed.isError, true);
});

test('app-server: agent prose becomes agent_message; reasoning never leaves the runtime', () => {
  const [msg] = translateAppServerEvent({
    method: 'item/completed',
    params: { item: { type: 'agentMessage', text: 'Added the validation.' } },
  });
  assert.equal(msg.kind, 'agent_message');
  assert.equal(msg.text, 'Added the validation.');

  // Private thinking must not be mirrored into a shared room.
  assert.deepEqual(
    translateAppServerEvent({
      method: 'item/completed',
      params: { item: { type: 'reasoning', text: 'chain of thought' } },
    }),
    [],
  );
  // Empty prose is not worth an event either.
  assert.deepEqual(
    translateAppServerEvent({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', text: '   ' } },
    }),
    [],
  );
});

test('app-server: per-token deltas are ignored in favour of completed items', () => {
  assert.deepEqual(
    translateAppServerEvent({
      method: 'item/agentMessage/delta',
      params: { itemId: 'i1', delta: 'Wor' },
    }),
    [],
  );
  assert.deepEqual(translateAppServerEvent({ method: 'item/reasoning/summaryTextDelta' }), []);
  assert.deepEqual(translateAppServerEvent({}), []);
});

test('app-server: file changes and failed turns are surfaced', () => {
  const [edit] = translateAppServerEvent({
    method: 'item/started',
    params: { item: { type: 'fileChange', changes: [{ path: 'src/a.js' }, { path: 'src/b.js' }] } },
  });
  assert.equal(edit.tool, 'edit');
  assert.match(edit.input, /src\/a\.js, src\/b\.js/);

  const failed = translateAppServerEvent({
    method: 'turn/failed',
    params: { error: { message: 'model unavailable' } },
  });
  assert.deepEqual(failed.map((e) => e.kind), ['error', 'result', 'agent_status']);
  assert.equal(failed[1].ok, false);
});

test('app-server: frames are classified without a jsonrpc field', () => {
  // Codex omits `jsonrpc` entirely, so classification rests on id/method alone.
  assert.equal(isResponse({ id: 1, result: {} }), true);
  assert.equal(isServerRequest({ id: 2, method: 'item/fileChange/requestApproval' }), true);
  assert.equal(isServerRequest({ method: 'turn/started', params: {} }), false);
  assert.equal(isResponse({ method: 'turn/started' }), false);
});

// ---- hook translation (interactive Codex CLI) ------------------------------

test('hooks: Codex payloads translate whatever case the event name arrives in', () => {
  for (const name of ['UserPromptSubmit', 'userPromptSubmit', 'user_prompt_submit']) {
    const [e] = translateCodexHookEvent({ hook_event_name: name, prompt: 'fix the tests' });
    assert.equal(e.kind, 'local_prompt', `${name} should translate`);
    assert.equal(e.text, 'fix the tests');
  }
});

test('hooks: session start carries the thread id so `open` can resume it', () => {
  const [e] = translateCodexHookEvent({
    hook_event_name: 'SessionStart',
    session_id: 'thread-abc',
    cwd: '/work',
  });
  assert.equal(e.status, 'ready');
  assert.equal(e.detail.sessionId, 'thread-abc');
  assert.equal(e.detail.cwd, '/work');
});

test('hooks: tool use, stop and session end', () => {
  const [use] = translateCodexHookEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'shell',
    tool_input: { command: 'ls' },
  });
  assert.equal(use.kind, 'tool_use');
  assert.match(use.input, /ls/);

  const [result] = translateCodexHookEvent({
    hook_event_name: 'PostToolUse',
    tool_name: 'shell',
    tool_response: { stdout: 'done  \n' },
  });
  assert.equal(result.kind, 'tool_result');
  assert.match(result.summary, /done/);

  assert.deepEqual(
    translateCodexHookEvent({ hook_event_name: 'Stop' }).map((e) => e.kind),
    ['result', 'agent_status'],
  );
  const [end] = translateCodexHookEvent({ hook_event_name: 'SessionEnd', reason: 'exit' });
  assert.equal(end.status, 'exited');
  assert.deepEqual(translateCodexHookEvent({ hook_event_name: 'PreCompact' }), []);
  assert.deepEqual(translateCodexHookEvent({}), []);
});

// ---- adapter end to end against the fake app server ------------------------

test('adapter drives a codex app server end to end (fake codex)', async () => {
  fs.chmodSync(FAKE_CODEX, 0o755);
  const adapter = new CodexAppServerAdapter({ codexPath: FAKE_CODEX, cwd: __dirname });
  const events = [];
  adapter.attach((e) => events.push(e));

  const waitFor = (pred, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const found = events.find(pred);
        if (found) {
          clearInterval(timer);
          resolve(found);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timed out; saw: ${events.map((e) => e.kind).join(',')}`));
        }
      }, 10);
    });

  await adapter.createSession();
  const ready = await waitFor((e) => e.kind === 'agent_status' && e.status === 'ready');
  // The thread id must reach the room, or reopening it starts a fresh thread.
  assert.ok(ready.detail.sessionId, 'thread id is reported for resume');
  assert.equal(ready.detail.model, 'fake-codex-model');
  assert.equal(adapter.threadId, ready.detail.sessionId);

  await adapter.sendInstruction({ text: 'add oauth validation', from: { name: 'Bob' } });
  await waitFor((e) => e.kind === 'tool_use' && e.tool === 'shell');
  await waitFor((e) => e.kind === 'tool_result' && e.isError === false);
  const message = await waitFor((e) => e.kind === 'agent_message');
  assert.match(message.text, /\[Bob\] add oauth validation/);
  const result = await waitFor((e) => e.kind === 'result');
  assert.equal(result.ok, true);

  // Two deltas plus one completed item must still be exactly one feed message.
  assert.equal(events.filter((e) => e.kind === 'agent_message').length, 1);
  // Reasoning was streamed by the fixture and must have been dropped.
  assert.ok(!events.some((e) => JSON.stringify(e).includes('secret chain of thought')));

  await adapter.pause();
  const { queued } = await adapter.sendInstruction({ text: 'held', from: { name: 'Alice' } });
  assert.equal(queued, true);
  const before = events.filter((e) => e.kind === 'result').length;

  await adapter.resume();
  await waitFor((e) => e.kind === 'result' && events.filter((x) => x.kind === 'result').length > before);
  assert.ok(events.some((e) => e.kind === 'agent_message' && e.text.includes('[Alice] held')));

  await adapter.disconnect();
});

// ---- registry descriptors --------------------------------------------------

test('registry: capabilities replace name-based branching', () => {
  // The CLI decides whether to start its own TUI from this flag, not from a
  // string comparison against an adapter name.
  assert.equal(describeAdapter('claude-native').ownsTerminal, true);
  assert.equal(describeAdapter('codex-native').ownsTerminal, true);
  assert.equal(describeAdapter('codex').ownsTerminal, false);
  assert.equal(describeAdapter('claude-code').ownsTerminal, false);

  // Each runtime keeps its own resume convention in one place.
  assert.deepEqual(describeAdapter('claude-native').resumeOptions('abc'), { extraArgs: ['--resume', 'abc'] });
  assert.deepEqual(describeAdapter('claude-code').resumeOptions('abc'), { sessionId: 'abc', resume: true });
  assert.deepEqual(describeAdapter('codex').resumeOptions('abc'), { threadId: 'abc', resume: true });

  assert.throws(() => describeAdapter('nope'), /unknown agent adapter/);
});

test('registry: runtimes resolve to interactive or headless adapters', () => {
  assert.equal(adapterFor('claude'), 'claude-native');
  assert.equal(adapterFor('claude', { headless: true }), 'claude-code');
  assert.equal(adapterFor('codex'), 'codex-native');
  assert.equal(adapterFor('codex', { headless: true }), 'codex');

  // Cursor is listed for discoverability but cannot be selected yet.
  assert.equal(findRuntime('cursor').status, 'coming-soon');
  assert.equal(adapterFor('cursor'), null);
  assert.equal(findRuntime('nope'), null);
});

test('hooks: every registered Codex hook event has a translation', () => {
  for (const event of HOOK_EVENTS) {
    assert.ok(
      translateCodexHookEvent({ hook_event_name: event }).length > 0,
      `${event} is registered but produces no events`,
    );
  }
});
