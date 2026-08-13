/**
 * Permission rules for shared sessions.
 *
 * Roles:  host (creator) | collaborator (joined via invite)
 * Modes:  open   — any participant can send instructions (default)
 *         driver — only the current driver can send instructions
 * Driver: the participant currently "holding the keyboard". Starts as the
 *         host; transferred via handoff.
 */
export const ACTIONS = ['instruct', 'pause', 'resume', 'handoff', 'set_mode', 'end'];

export function can(session, participant, action) {
  if (!participant) return false;
  const isHost = participant.role === 'host';
  const isDriver = session.driverId === participant.id;

  switch (action) {
    case 'instruct':
      if (session.status === 'paused' || session.status === 'ended') return false;
      return session.mode === 'open' ? true : isDriver || isHost;
    case 'pause':
    case 'resume':
    case 'handoff':
      return isHost || isDriver;
    case 'set_mode':
    case 'end':
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
