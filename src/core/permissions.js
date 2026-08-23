/**
 * Roles: host | collaborator. Modes: open (anyone instructs) | driver (only
 * the driver). The driver starts as the host and moves via handoff.
 */
export const ACTIONS = [
  'instruct', 'pause', 'resume', 'handoff', 'set_mode', 'end',
  'add_agent', 'detach_agent', 'archive', 'use_agent',
];

export function can(session, participant, action) {
  if (!participant) return false;
  const isHost = participant.role === 'host';
  const isDriver = session.driverId === participant.id;

  switch (action) {
    case 'instruct':
      if (session.status === 'paused' || session.status === 'ended') return false;
      return session.mode === 'open' ? true : isDriver || isHost;
    case 'use_agent':
      return session.status !== 'ended';
    case 'pause':
    case 'resume':
    case 'handoff':
    case 'add_agent':
    case 'detach_agent':
      return isHost || isDriver;
    case 'set_mode':
    case 'end':
    case 'archive':
      return isHost;
    default:
      return false;
  }
}

export function denyReason(session, participant, action) {
  if (action === 'instruct') {
    if (session.status === 'paused') return 'session is paused — resume it first (/resume)';
    if (session.status === 'ended') return 'session has ended';
    if (session.mode === 'driver') return 'driver mode is on — ask for handoff (/handoff)';
  }
  return `you do not have permission to ${action} (role: ${participant?.role ?? 'unknown'})`;
}
