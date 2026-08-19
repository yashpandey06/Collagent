/** Lifecycle hooks Collagent registers to observe an interactive Goose session. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
];

// Tool events need a matcher and Goose treats it as a REGEX — a bare '*' is
// silently skipped, so match-all is '.*'.
const NEEDS_MATCHER = new Set(['PreToolUse', 'PostToolUse']);

/**
 * Goose reads hooks from plugin dirs (<project>/.agents/plugins/<name>/hooks/
 * hooks.json). Collagent owns its whole plugin dir, so no merging — the host's
 * own plugins live in their own directories and keep working.
 */
export function buildHooksConfig(command) {
  const hooks = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{
      ...(NEEDS_MATCHER.has(event) ? { matcher: '.*' } : {}),
      hooks: [{ type: 'command', command, timeout: 5 }],
    }];
  }
  return { hooks };
}

/** Goose hook payload → normalized events. Pure, exported for tests. */
export function translateGooseHookEvent(payload = {}) {
  switch (payload.event ?? payload.hook_event_name) {
    case 'SessionStart':
      return [{
        kind: 'agent_status',
        status: 'ready',
        detail: { sessionId: payload.session_id, cwd: payload.working_dir ?? payload.cwd },
      }];

    case 'UserPromptSubmit':
      return [{ kind: 'local_prompt', text: payload.prompt ?? payload.user_prompt ?? payload.text ?? '' }];

    case 'PreToolUse':
      return [{
        kind: 'tool_use',
        tool: payload.tool_name ?? 'tool',
        input: compact(payload.tool_input),
      }];

    case 'PostToolUse':
      return [{
        kind: 'tool_result',
        tool: payload.tool_name,
        summary: compact(payload.tool_output ?? payload.tool_response ?? payload.output, 200),
      }];

    case 'Stop': {
      // Stop carries the turn's final assistant message — the only prose hooks expose.
      const text = payload.last_assistant_message;
      return [
        ...(typeof text === 'string' && text.trim() ? [{ kind: 'agent_message', text }] : []),
        { kind: 'result', ok: true },
        { kind: 'agent_status', status: 'idle' },
      ];
    }

    case 'SessionEnd':
      return [{ kind: 'agent_status', status: 'exited', detail: { reason: payload.reason } }];

    default:
      return [];
  }
}

function compact(value, max = 400) {
  let s;
  if (typeof value === 'string') s = value;
  else {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  }
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
