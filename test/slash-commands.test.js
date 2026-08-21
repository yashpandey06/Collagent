import test from 'node:test';
import assert from 'node:assert/strict';
import { formatInstructionLine, isSlashCommand } from '../src/adapters/instruction-format.js';
import { routeInput } from '../src/ui/tui.js';
import { ClaudeNativeAdapter } from '../src/adapters/claude/native.js';
import { CodexNativeAdapter } from '../src/adapters/codex/native.js';
import { CursorNativeAdapter } from '../src/adapters/cursor/native.js';
import { GeminiNativeAdapter } from '../src/adapters/gemini/native.js';
import { GooseNativeAdapter } from '../src/adapters/goose/native.js';
import { OpencodeNativeAdapter } from '../src/adapters/opencode/native.js';

test('isSlashCommand: commands yes, prose and paths no', () => {
  assert.equal(isSlashCommand('/model'), true);
  assert.equal(isSlashCommand('/model claude-opus-5'), true);
  assert.equal(isSlashCommand('  /permissions  '), true);
  assert.equal(isSlashCommand('/user:my-command arg'), true);
  assert.equal(isSlashCommand('add oauth'), false);
  assert.equal(isSlashCommand('/src/app.js is broken'), false, 'a path is prose');
  assert.equal(isSlashCommand('//model'), false);
  assert.equal(isSlashCommand(''), false);
  assert.equal(isSlashCommand(null), false);
});

test('formatInstructionLine: prose is speaker-tagged, commands pass bare', () => {
  assert.equal(formatInstructionLine({ text: 'add oauth', from: { name: 'Bob' } }), '[Bob] add oauth');
  assert.equal(formatInstructionLine({ text: 'add oauth', from: null }), 'add oauth');
  assert.equal(formatInstructionLine({ text: '/model', from: { name: 'Bob' } }), '/model');
  assert.equal(
    formatInstructionLine({ text: ' /permissions ', from: { name: 'Bob' } }),
    '/permissions',
    'commands are trimmed so the runtime sees "/" first',
  );
});

test('routeInput: room commands stay local, agent commands are forwarded', () => {
  assert.deepEqual(routeInput('/pause'), { type: 'room', cmd: 'pause', rest: [] });
  assert.deepEqual(routeInput('/handoff Bob'), { type: 'room', cmd: 'handoff', rest: ['Bob'] });
  assert.deepEqual(routeInput('/model'), { type: 'instruction', text: '/model' });
  assert.deepEqual(routeInput('/permissions'), { type: 'instruction', text: '/permissions' });
  // //x force-sends /x to the agent when collagent owns the name
  assert.deepEqual(routeInput('//status'), { type: 'instruction', text: '/status' });
  assert.deepEqual(routeInput('fix the tests'), { type: 'instruction', text: 'fix the tests' });
});

// Every native adapter must deliver a participant's slash command exactly as
// the host would type it — no [Name] prefix — and must not flip the room to
// "working" (commands drive the runtime's own UI and never fire a Stop hook).
const ptyAdapters = [
  ['claude', ClaudeNativeAdapter],
  ['codex', CodexNativeAdapter],
  ['cursor', CursorNativeAdapter],
  ['gemini', GeminiNativeAdapter],
  ['goose', GooseNativeAdapter],
];

for (const [name, Adapter] of ptyAdapters) {
  test(`${name} native: slash commands inject bare, prose keeps the speaker tag`, () => {
    const adapter = new Adapter();
    adapter.pty = { write() {} }; // status emits happen only when a pty is live
    const seen = [];
    adapter.attach((e) => seen.push(e));

    adapter._inject({ text: '/model', from: { name: 'Bob' } });
    assert.ok(adapter._recentInjections.some((e) => e.text === '/model'), 'command injected bare');
    assert.ok(!adapter._recentInjections.some((e) => e.text.includes('[Bob]')), 'no speaker prefix');
    assert.equal(seen.filter((e) => e.kind === 'agent_status' && e.status === 'working').length, 0);

    adapter._inject({ text: 'add oauth', from: { name: 'Bob' } });
    assert.ok(adapter._recentInjections.some((e) => e.text === '[Bob] add oauth'));
    assert.equal(seen.filter((e) => e.kind === 'agent_status' && e.status === 'working').length, 1);
  });
}

test('opencode native: slash commands submit bare, prose keeps the speaker tag', async () => {
  const adapter = new OpencodeNativeAdapter();
  const posted = [];
  adapter._post = async (path, body) => posted.push({ path, body });
  const seen = [];
  adapter.attach((e) => seen.push(e));

  await adapter._inject({ text: '/models', from: { name: 'Bob' } });
  assert.equal(posted[0].body.text, '/models');
  assert.equal(seen.filter((e) => e.kind === 'agent_status' && e.status === 'working').length, 0);

  await adapter._inject({ text: 'add oauth', from: { name: 'Bob' } });
  assert.equal(posted[2].body.text, '[Bob] add oauth');
  assert.equal(seen.filter((e) => e.kind === 'agent_status' && e.status === 'working').length, 1);
});
