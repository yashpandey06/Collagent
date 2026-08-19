/** Lifecycle hooks Collagent registers to observe an interactive Gemini session. */
export const HOOK_EVENTS = [
  'SessionStart',
  'BeforeAgent',
  'BeforeTool',
  'AfterTool',
  'AfterAgent',
  'Notification',
  'SessionEnd',
];

/**
 * Gemini reads hooks from settings.json (project .gemini/settings.json wins
 * over user settings). Entry shape is Claude-like but with a name field and
 * millisecond timeouts.
 */
export function buildHooksSettings(existing, command) {
  const hooks = { ...(existing?.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    hooks[event] = [
      ...(hooks[event] ?? []),
      { hooks: [{ name: 'collagent', type: 'command', command, timeout: 5000 }] },
    ];
  }
  return { ...existing, hooks };
}

/** Gemini hook payload → normalized events. Pure, exported for tests. */
export function translateGeminiHookEvent(payload = {}) {
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return [{
        kind: 'agent_status',
        status: 'ready',
        detail: { sessionId: payload.session_id, cwd: payload.cwd, source: payload.source },
      }];

    case 'BeforeAgent':
      return [{ kind: 'local_prompt', text: payload.prompt ?? '' }];

    case 'BeforeTool':
      return [{
        kind: 'tool_use',
        tool: payload.tool_name ?? 'tool',
        input: compact(payload.tool_input),
      }];

    case 'AfterTool': {
      const response = payload.tool_response ?? {};
      return [{
        kind: 'tool_result',
        tool: payload.tool_name,
        summary: compact(response.returnDisplay ?? response.llmContent ?? response, 200),
        isError: Boolean(response.error),
      }];
    }

    // AfterAgent carries the turn's reply — the only prose Gemini hooks expose.
    case 'AfterAgent': {
      const text = typeof payload.prompt_response === 'string'
        ? payload.prompt_response
        : compact(payload.prompt_response ?? '');
      return [
        ...(text.trim() ? [{ kind: 'agent_message', text }] : []),
        { kind: 'result', ok: true },
        { kind: 'agent_status', status: 'idle' },
      ];
    }

    case 'Notification':
      return [{ kind: 'notice', message: payload.message ?? payload.notification_type ?? 'Gemini needs attention' }];

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
