/** Lifecycle hooks Collagent registers to observe an interactive Cursor session. */
export const HOOK_EVENTS = [
  'sessionStart',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'afterAgentResponse',
  'stop',
  'sessionEnd',
];

/**
 * Cursor hooks.json uses a flat entry schema, unlike Claude/Codex:
 *   { "version": 1, "hooks": { "eventName": [{ "command": "…", "timeout": n }] } }
 * Merges with the workspace's existing hooks so the host's own setup keeps working.
 */
export function buildHooksConfig(existing, command) {
  const hooks = { ...(existing?.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { command, timeout: 5 }];
  }
  return { version: existing?.version ?? 1, hooks };
}

/** Cursor hook payload → normalized events. Pure, exported for tests. */
export function translateCursorHookEvent(payload = {}) {
  switch (payload.hook_event_name) {
    case 'sessionStart':
      return [{
        kind: 'agent_status',
        status: 'ready',
        detail: {
          sessionId: payload.session_id ?? payload.conversation_id,
          cwd: payload.workspace_roots?.[0],
          model: payload.model,
        },
      }];

    case 'beforeSubmitPrompt':
      return [{ kind: 'local_prompt', text: payload.prompt ?? '' }];

    case 'preToolUse':
      return [{
        kind: 'tool_use',
        tool: payload.tool_name ?? 'tool',
        input: compact(payload.tool_input),
      }];

    case 'postToolUse':
      return [{
        kind: 'tool_result',
        tool: payload.tool_name,
        summary: compact(payload.tool_output, 200),
      }];

    case 'afterAgentResponse': {
      const text = payload.text ?? '';
      return text.trim() ? [{ kind: 'agent_message', text }] : [];
    }

    case 'stop':
      return [
        { kind: 'result', ok: payload.status ? payload.status === 'completed' : true },
        { kind: 'agent_status', status: 'idle' },
      ];

    case 'sessionEnd':
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
