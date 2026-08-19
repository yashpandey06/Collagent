/** Derive a room's descriptive summary (listings, status views) from its event history. */
export function buildRoomSummary(events = []) {
  let agentType;
  let createdAt;
  let cwd;
  let agentSessionId = null;
  let title = null;
  let firstInstruction = null;
  let lastInstruction = null;
  let ended = false;
  const everNames = new Map();

  for (const e of events) {
    switch (e.kind) {
      case 'session_created':
        createdAt = e.ts;
        agentType = e.data?.agentType;
        break;
      case 'participant_joined':
        if (e.actor?.name) everNames.set(e.actor.name, e.data?.role ?? 'collaborator');
        break;
      case 'instruction':
        lastInstruction = { name: e.actor?.name ?? 'someone', text: e.data?.text ?? '', ts: e.ts };
        firstInstruction ??= lastInstruction;
        break;
      case 'local_prompt':
        lastInstruction = { name: 'host terminal', text: e.data?.text ?? '', ts: e.ts };
        firstInstruction ??= lastInstruction;
        break;
      case 'session_title':
        if (e.data?.title) title = e.data.title;
        break;
      case 'agent_status': {
        const detail = e.data?.detail;
        if (detail?.cwd) cwd = detail.cwd;
        if (detail?.sessionId) agentSessionId = detail.sessionId;
        break;
      }
      case 'session_ended':
        ended = true;
        break;
      default:
        break;
    }
  }

  return {
    agentType,
    createdAt: createdAt ?? events[0]?.ts ?? null,
    lastActivity: events.at(-1)?.ts ?? null,
    eventCount: events.length,
    cwd: cwd ?? null,
    agentSessionId,
    // Agent-provided title when the runtime names the session; otherwise the
    // first instruction stands in so long room lists stay scannable.
    title: title ?? truncate(firstInstruction?.text, 60),
    lastInstruction,
    participantsEver: [...everNames.keys()],
    ended,
  };
}

function truncate(s, n) {
  if (!s) return null;
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
