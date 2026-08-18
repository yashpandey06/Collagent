/** Lifecycle hooks Collagent registers to observe an interactive Codex session. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
];

/**
 * Codex writes hook event names as PascalCase in config but the protocol's own
 * `HookEventName` type is camelCase, and payload casing is not guaranteed to
 * match either. Normalize before dispatching so all three spellings work.
 */
const normalize = (name) => String(name ?? '').replace(/[_-]/g, '').toLowerCase();

/**
 * Translate a Codex hook payload into normalized Collagent events.
 * Pure function — exported for tests.
 *
 * Payload fields are snake_case (`hook_event_name`, `tool_name`, …). Field
 * names for tool output are not pinned down in Codex's docs, so the likely
 * spellings are all accepted rather than guessed at.
 */
export function translateCodexHookEvent(payload = {}) {
  switch (normalize(payload.hook_event_name ?? payload.hookEventName)) {
    case 'sessionstart':
      return [{
        kind: 'agent_status',
        status: 'ready',
        detail: {
          sessionId: payload.session_id ?? payload.sessionId,
          cwd: payload.cwd,
          model: payload.model,
        },
      }];

    case 'userpromptsubmit':
      return [{ kind: 'local_prompt', text: payload.prompt ?? '' }];

    case 'pretooluse':
      return [{
        kind: 'tool_use',
        tool: payload.tool_name ?? payload.toolName ?? 'tool',
        input: compact(payload.tool_input ?? payload.toolInput),
      }];

    case 'posttooluse':
      return [{
        kind: 'tool_result',
        tool: payload.tool_name ?? payload.toolName,
        summary: compact(payload.tool_response ?? payload.tool_output ?? payload.tool_result, 200),
      }];

    case 'stop':
      return [
        { kind: 'result', ok: true },
        { kind: 'agent_status', status: 'idle' },
      ];

    case 'sessionend':
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
