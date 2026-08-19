import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS, buildHooksSettings, translateGeminiHookEvent } from '../src/adapters/gemini/hooks.js';
import { GeminiNativeAdapter } from '../src/adapters/gemini/native.js';
import { AcpAdapter } from '../src/adapters/acp/client.js';
import { describeAdapter, findRuntime, adapterFor } from '../src/adapters/registry.js';

test('gemini hooks: lifecycle payloads translate to normalized events', () => {
  const [ready] = translateGeminiHookEvent({
    hook_event_name: 'SessionStart', session_id: 'g-1', cwd: '/work', source: 'startup',
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.detail.sessionId, 'g-1');

  const [prompt] = translateGeminiHookEvent({ hook_event_name: 'BeforeAgent', prompt: 'fix it' });
  assert.equal(prompt.kind, 'local_prompt');

  const [use] = translateGeminiHookEvent({
    hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { absolute_path: '/a.js' },
  });
  assert.equal(use.kind, 'tool_use');
  assert.match(use.input, /a\.js/);

  const [result] = translateGeminiHookEvent({
    hook_event_name: 'AfterTool', tool_name: 'write_file',
    tool_response: { returnDisplay: 'Wrote 3 lines', error: undefined },
  });
  assert.equal(result.kind, 'tool_result');
  assert.match(result.summary, /Wrote 3 lines/);
  assert.equal(result.isError, false);

  // AfterAgent carries the reply and closes the turn
  const after = translateGeminiHookEvent({ hook_event_name: 'AfterAgent', prompt_response: 'Done — tests pass.' });
  assert.deepEqual(after.map((e) => e.kind), ['agent_message', 'result', 'agent_status']);
  assert.equal(after[1].ok, true);
  assert.deepEqual(
    translateGeminiHookEvent({ hook_event_name: 'AfterAgent' }).map((e) => e.kind),
    ['result', 'agent_status'],
  );

  const [notice] = translateGeminiHookEvent({ hook_event_name: 'Notification', notification_type: 'ToolPermission' });
  assert.equal(notice.kind, 'notice');
  assert.equal(translateGeminiHookEvent({ hook_event_name: 'SessionEnd' })[0].status, 'exited');
  assert.deepEqual(translateGeminiHookEvent({ hook_event_name: 'PreCompress' }), []);
});

test('gemini hooks: settings merge keeps existing project settings and hooks', () => {
  const existing = { theme: 'dark', hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ name: 'mine', type: 'command', command: 'x.sh' }] }] } };
  const merged = buildHooksSettings(existing, 'node hook.js http://x');
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.hooks.BeforeTool[0].hooks[0].command, 'x.sh');
  for (const event of HOOK_EVENTS) {
    const entry = merged.hooks[event].at(-1).hooks[0];
    assert.equal(entry.command, 'node hook.js http://x');
    assert.equal(entry.name, 'collagent');
  }
});

test('gemini native: settings.json written into the workspace and restored', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-gemini-'));
  const file = path.join(cwd, '.gemini', 'settings.json');

  const a1 = new GeminiNativeAdapter({ cwd });
  a1._installHooks('http://127.0.0.1:1/hook/x', cwd);
  assert.ok(fs.existsSync(file));
  await a1.disconnect();
  assert.ok(!fs.existsSync(path.join(cwd, '.gemini')), 'created dir removed');

  fs.mkdirSync(path.join(cwd, '.gemini'));
  const original = JSON.stringify({ general: { vimMode: true } });
  fs.writeFileSync(file, original);
  const a2 = new GeminiNativeAdapter({ cwd });
  a2._installHooks('http://127.0.0.1:1/hook/x', cwd);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).general.vimMode, true, 'existing settings preserved');
  await a2.disconnect();
  assert.equal(fs.readFileSync(file, 'utf8'), original);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('gemini native: injected instructions are not echoed as local prompts', () => {
  const adapter = new GeminiNativeAdapter();
  const seen = [];
  adapter.attach((e) => seen.push(e));
  adapter._inject({ text: 'add oauth', from: { name: 'Bob' } });
  adapter._onHook({ hook_event_name: 'BeforeAgent', prompt: '[Bob] add oauth' });
  assert.equal(seen.filter((e) => e.kind === 'local_prompt').length, 0);
});

test('registry: gemini runtime resolves to native + ACP adapters', () => {
  assert.equal(findRuntime('gemini').status, 'available');
  assert.equal(adapterFor('gemini'), 'gemini-native');
  assert.equal(adapterFor('gemini', { headless: true }), 'gemini');
  assert.deepEqual(describeAdapter('gemini-native').resumeOptions('u-1'), { extraArgs: ['--resume', 'u-1'] });
  const headless = describeAdapter('gemini').create({});
  assert.ok(headless instanceof AcpAdapter);
  assert.equal(headless.options.command, 'gemini');
  assert.deepEqual(headless.options.args, ['--acp']);
});
