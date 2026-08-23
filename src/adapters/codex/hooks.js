import { capture } from '../capture.js';
/** Lifecycle hooks Collagent registers to observe an interactive Codex session. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
];

// Codex mixes Pascal/camel/snake case across config, protocol and payloads —
// normalize so all spellings dispatch.
const normalize = (name) => String(name ?? '').replace(/[_-]/g, '').toLowerCase();

/** Codex hook payload → normalized events. Pure, exported for tests. */
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

    case 'stop': {
      // Stop carries the turn's final assistant message — the only prose hooks expose.
      const text = payload.last_assistant_message ?? payload.lastAssistantMessage;
      return [
        ...(typeof text === 'string' && text.trim() ? [{ kind: 'agent_message', text }] : []),
        { kind: 'result', ok: true },
        { kind: 'agent_status', status: 'idle' },
      ];
    }

    case 'sessionend':
      return [{ kind: 'agent_status', status: 'exited', detail: { reason: payload.reason } }];

    default:
      return [];
  }
}

// Stored payloads stay complete (up to the safety cap); renderers truncate.
const compact = (value) => capture(value);
