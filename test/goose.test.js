import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS, buildHooksConfig, translateGooseHookEvent } from '../src/adapters/goose/hooks.js';
import { GooseNativeAdapter } from '../src/adapters/goose/native.js';
import { AcpAdapter } from '../src/adapters/acp/client.js';
import { describeAdapter, findRuntime, adapterFor } from '../src/adapters/registry.js';

test('goose hooks: payloads translate (goose uses "event", not "hook_event_name")', () => {
  const [ready] = translateGooseHookEvent({
    event: 'SessionStart', session_id: '20260819_3', working_dir: '/work',
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.detail.sessionId, '20260819_3');

  const [prompt] = translateGooseHookEvent({ event: 'UserPromptSubmit', prompt: 'run tests' });
  assert.equal(prompt.kind, 'local_prompt');

  const [use] = translateGooseHookEvent({
    event: 'PreToolUse', tool_name: 'developer__shell', tool_input: { command: 'rg TODO' },
  });
  assert.equal(use.kind, 'tool_use');
  assert.match(use.input, /rg TODO/);

  const [result] = translateGooseHookEvent({ event: 'PostToolUse', tool_name: 'developer__shell', tool_output: 'no TODOs' });
  assert.equal(result.kind, 'tool_result');

  const stop = translateGooseHookEvent({ event: 'Stop', last_assistant_message: 'All clean.' });
  assert.deepEqual(stop.map((e) => e.kind), ['agent_message', 'result', 'agent_status']);
  assert.equal(stop[0].text, 'All clean.');

  assert.equal(translateGooseHookEvent({ event: 'SessionEnd', reason: 'exit' })[0].status, 'exited');
  assert.deepEqual(translateGooseHookEvent({ event: 'SubagentStart' }), []);
});

test('goose hooks: config uses regex matchers on tool events only', () => {
  const config = buildHooksConfig('node hook.js http://x');
  for (const event of HOOK_EVENTS) {
    const entry = config.hooks[event][0];
    assert.equal(entry.hooks[0].command, 'node hook.js http://x');
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      assert.equal(entry.matcher, '.*', 'goose matchers are regexes; bare * is silently skipped');
    } else {
      assert.equal(entry.matcher, undefined);
    }
  }
});

test('goose native: plugin dir is created in the workspace and fully removed', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-goose-'));
  const hooksFile = path.join(cwd, '.agents', 'plugins', 'collagent', 'hooks', 'hooks.json');

  const a1 = new GooseNativeAdapter({ cwd });
  a1._installHooks('http://127.0.0.1:1/hook/x', cwd);
  assert.ok(fs.existsSync(hooksFile));
  await a1.disconnect();
  assert.ok(!fs.existsSync(path.join(cwd, '.agents')), 'empty parents tidied');

  // another plugin present: only ours is removed
  fs.mkdirSync(path.join(cwd, '.agents', 'plugins', 'theirs'), { recursive: true });
  const a2 = new GooseNativeAdapter({ cwd });
  a2._installHooks('http://127.0.0.1:1/hook/x', cwd);
  await a2.disconnect();
  assert.ok(fs.existsSync(path.join(cwd, '.agents', 'plugins', 'theirs')), 'other plugins untouched');
  assert.ok(!fs.existsSync(path.join(cwd, '.agents', 'plugins', 'collagent')));

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('registry: goose runtime resolves to native + ACP adapters', () => {
  assert.equal(findRuntime('goose').status, 'available');
  assert.equal(adapterFor('goose'), 'goose-native');
  assert.equal(adapterFor('goose', { headless: true }), 'goose');
  assert.deepEqual(
    describeAdapter('goose-native').resumeOptions('20260819_3'),
    { extraArgs: ['--session-id', '20260819_3', '--resume'] },
  );
  const headless = describeAdapter('goose').create({});
  assert.ok(headless instanceof AcpAdapter);
  assert.equal(headless.options.command, 'goose');
});
