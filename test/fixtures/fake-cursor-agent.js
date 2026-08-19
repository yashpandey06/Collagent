#!/usr/bin/env node
// Speaks the Cursor CLI's exact print-mode stream-json protocol:
// system/init with session_id, assistant content blocks, tool_call events
// keyed by call type ({ readToolCall: { args, result } }), and a result line.
const args = process.argv.slice(2);

const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const prompt = flagValue('-p') ?? '';
const resumed = flagValue('--resume');
const sessionId = resumed ?? 'fc-' + Math.random().toString(16).slice(2, 10);

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

line({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), session_id: sessionId, model: 'fake-cursor-1', permissionMode: 'default' });
line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, session_id: sessionId });
line({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'README.md' } } }, session_id: sessionId });
line({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'README.md' }, result: { success: { totalLines: 12 } } } }, session_id: sessionId });
line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Echo${resumed ? ' (resumed)' : ''}: ${prompt}` }] }, session_id: sessionId });
line({ type: 'result', subtype: 'success', duration_ms: 42, is_error: false, result: `done: ${prompt}`, session_id: sessionId });
process.exit(0);
