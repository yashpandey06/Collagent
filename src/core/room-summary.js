/**
 * Derive a room's descriptive summary (listings, status views) from its event
 * history. `seed` is a previously computed summary: capped in-memory logs fold
 * their trimmed prefix into a seed so facts survive the trim.
 */
export function buildRoomSummary(events = [], seed = null) {
  let agentType = seed?.agentType;
  let createdAt = seed?.createdAt ?? undefined;
  let cwd = seed?.cwd ?? undefined;
  let agentSessionId = seed?.agentSessionId ?? null;
  let title = seed?.title ?? null;
  let firstInstruction = seed?.firstInstruction ?? null;
  let lastInstruction = seed?.lastInstruction ?? null;
  let ended = seed?.ended ?? false;
  const everNames = new Map((seed?.participantsEver ?? []).map((n) => [n, 'seen']));
  const agentIds = new Set(seed?.agentIds ?? []);

  for (const e of events) {
    if (e.agentId) agentIds.add(e.agentId);
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
      case 'agent_session_created':
        if (e.agentId) agentIds.add(e.agentId);
        break;
      case 'session_ended':
        ended = true;
        break;
      default:
        break;
    }
  }

  return {
    agentType,
    agentIds: [...agentIds],
    createdAt: createdAt ?? events[0]?.ts ?? null,
    lastActivity: events.at(-1)?.ts ?? seed?.lastActivity ?? null,
    eventCount: (seed?.eventCount ?? 0) + events.length,
    cwd: cwd ?? null,
    agentSessionId,
    // Agent-provided title when the runtime names the session; otherwise the
    // first instruction stands in so long room lists stay scannable.
    title: title ?? truncate(firstInstruction?.text, 60),
    firstInstruction,
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
