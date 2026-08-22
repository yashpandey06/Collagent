/**
 * "Since you were away": fold a span of missed events into a handful of
 * digest lines instead of replaying the raw feed. The one canonical
 * implementation — CLI, web, and the /catchup API all use it.
 */
export function catchupSummary(events, { selfName } = {}) {
  const lines = [];
  const joined = [];
  const left = [];
  const redirects = [];
  const agentsSeen = new Map(); // agentId -> { turns, edits, commands, tools }
  const handoffs = [];
  let ended = false;

  const bucket = (agentId) => {
    const key = agentId ?? 'agent';
    if (!agentsSeen.has(key)) agentsSeen.set(key, { turns: 0, edits: 0, commands: 0, tools: 0 });
    return agentsSeen.get(key);
  };

  for (const e of events) {
    const name = e.actor?.name;
    switch (e.kind) {
      case 'participant_joined':
        if (name !== selfName) joined.push(name);
        break;
      case 'participant_left':
        if (name !== selfName) left.push(name);
        break;
      case 'instruction':
      case 'local_prompt':
        if (name !== selfName) {
          redirects.push({ name: e.kind === 'local_prompt' ? 'host' : name, text: e.data?.text ?? '' });
        }
        break;
      case 'tool_use': {
        const tool = String(e.data?.tool ?? '');
        const b = bucket(e.agentId);
        if (/write|edit|notebookedit/i.test(tool)) b.edits++;
        else if (/bash|shell|command/i.test(tool)) b.commands++;
        else b.tools++;
        break;
      }
      case 'result':
        bucket(e.agentId).turns++;
        break;
      case 'agent_session_attached':
        lines.push(`✓ ${e.agentId ?? 'an agent'} joined the room`);
        break;
      case 'agent_session_detached':
        lines.push(`✓ ${e.agentId ?? 'an agent'} detached`);
        break;
      case 'handoff_completed':
        handoffs.push(`${e.actor?.name ?? 'someone'} → ${e.data?.to?.name ?? '?'}`);
        break;
      case 'session_ended':
        ended = true;
        break;
      default:
        break;
    }
  }

  if (joined.length) lines.push(`✓ ${[...new Set(joined)].join(', ')} joined`);
  if (left.length) lines.push(`✓ ${[...new Set(left)].join(', ')} left`);
  for (const r of redirects.slice(-2)) {
    lines.push(`✓ ${r.name}: “${r.text.length > 46 ? r.text.slice(0, 46) + '…' : r.text}”`);
  }
  for (const [agentId, b] of agentsSeen) {
    const parts = [];
    if (b.turns) parts.push(`completed ${b.turns} turn${b.turns === 1 ? '' : 's'}`);
    if (b.edits) parts.push(`changed ${b.edits} file${b.edits === 1 ? '' : 's'}`);
    if (b.commands) parts.push(`ran ${b.commands} command${b.commands === 1 ? '' : 's'}`);
    if (!parts.length && b.tools) parts.push(`${b.tools} tool action${b.tools === 1 ? '' : 's'}`);
    if (parts.length) lines.push(`✓ ${agentId} ${parts.join(', ')}`);
  }
  for (const h of handoffs.slice(-2)) lines.push(`✓ handoff: ${h}`);
  if (ended) lines.push('■ the session was ended');
  return lines.slice(0, 8);
}

/** Live tail line for the digest: which agents are working right now. */
export function currentActivity(session) {
  const working = (session?.agents ?? [])
    .filter((a) => a.attached && a.status === 'working')
    .map((a) => a.agentId);
  if (!working.length) return null;
  return `● ${working.join(', ')} ${working.length === 1 ? 'is' : 'are'} currently working`;
}
