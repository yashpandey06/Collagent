/**
 * Derive a room's descriptive summary from its event history. Used by the
 * live server (`/api/sessions`) and by the CLI reading history files directly
 * when no server is running.
 */
export function buildRoomSummary(events = []) {
  let agentType;
  let createdAt;
  let cwd;
  let agentSessionId = null;
  let lastInstruction = null;
  let ended = false;
  const everNames = new Map(); // name -> role

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
        break;
      case 'local_prompt':
        lastInstruction = { name: 'host terminal', text: e.data?.text ?? '', ts: e.ts };
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
    lastInstruction,
    participantsEver: [...everNames.keys()],
    ended,
  };
}
