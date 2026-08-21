import { paint } from '../client/tui.js';
import { agentLabel, filterRooms, padCell, roomCounts, statusCell, visLen } from './format.js';

/**
 * The room browser screen. Pure render + key reducer so it can be tested
 * without a terminal; src/tui/app.js wires it to the Term engine.
 *
 * State: { rooms, cursor, query, searching, connected, message }
 * Actions returned by handleBrowserKey:
 *   {type:'join', code} | {type:'create'} | {type:'quit'} | {type:'refresh'} | null
 */
export function browserState() {
  return { rooms: [], cursor: 0, query: '', searching: false, connected: false, message: null };
}

export function visibleRooms(state) {
  return filterRooms(state.rooms, state.query);
}

export function renderBrowser(state, { cols, rows }) {
  const lines = [];
  const rule = paint.dim('─'.repeat(Math.max(20, cols - 2)));
  const rooms = visibleRooms(state);
  const cursor = Math.min(state.cursor, Math.max(0, rooms.length - 1));

  lines.push('');
  lines.push(` ${paint.bold('COLLAGENT')}  ${state.connected ? '' : paint.red('· server unreachable — retrying…')}`);
  lines.push(` ${rule}`);
  lines.push('');
  lines.push(` ${paint.dim('ROOMS')}${state.query ? paint.yellow(`   / ${state.query}`) : ''}${state.searching ? paint.yellow('▏') : ''}`);
  lines.push('');

  const header = `   ${padCell('CODE', 8)}${padCell('AGENT', 11)}${padCell('PEOPLE', 9)}${padCell('IN', 5)}STATUS`;
  lines.push(paint.dim(header));

  if (!state.connected && rooms.length === 0) {
    lines.push('');
    lines.push(paint.dim('   connecting to session server…'));
  } else if (rooms.length === 0) {
    lines.push('');
    lines.push(paint.dim(state.query ? `   no rooms matching “${state.query}”` : '   no rooms yet — press n to create one'));
  }

  const maxRows = Math.max(3, rows - 12);
  const start = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), rooms.length - maxRows));
  for (let i = start; i < Math.min(rooms.length, start + maxRows); i++) {
    const room = rooms[i];
    const { people, inCount } = roomCounts(room);
    const sel = i === cursor;
    const mark = sel ? paint.bold('›') : ' ';
    const code = sel ? paint.bold(room.code) : room.code;
    const row = ` ${mark} ${padCell(code, 8)}${padCell(agentLabel(room.agentType), 11)}${padCell(String(people), 9)}${padCell(String(inCount), 5)}${statusCell(room.status)}`;
    lines.push(sel ? row : paint.dim('') + row);
  }

  while (lines.length < rows - 3) lines.push('');
  if (state.message) lines[rows - 4] = ` ${paint.yellow(state.message)}`;
  lines.push(` ${rule}`);
  lines.push(
    ` ${paint.dim(state.searching
      ? 'type to filter   Enter apply   Esc clear'
      : '↑↓ Select   Enter Join   n New   / Search   r Refresh   q Quit')}`,
  );
  return lines;
}

export function handleBrowserKey(state, str, key) {
  state.message = null;

  if (state.searching) {
    if (key.name === 'escape') {
      state.searching = false;
      state.query = '';
    } else if (key.name === 'return' || key.name === 'enter') {
      state.searching = false;
    } else if (key.name === 'backspace') {
      state.query = state.query.slice(0, -1);
    } else if (str && str.length === 1 && !key.ctrl && str >= ' ') {
      state.query += str;
      state.cursor = 0;
    }
    return null;
  }

  const rooms = visibleRooms(state);
  switch (key.name) {
    case 'up':
    case 'k':
      state.cursor = Math.max(0, Math.min(state.cursor, rooms.length - 1) - 1);
      return null;
    case 'down':
    case 'j':
      state.cursor = Math.min(Math.max(0, rooms.length - 1), state.cursor + 1);
      return null;
    case 'return':
    case 'enter': {
      const room = rooms[Math.min(state.cursor, rooms.length - 1)];
      return room ? { type: 'join', code: room.code } : null;
    }
    case 'n':
      return { type: 'create' };
    case 'r':
      return { type: 'refresh' };
    case 'q':
      return { type: 'quit' };
    case 'c':
      if (key.ctrl) return { type: 'quit' };
      return null;
    default:
      if (str === '/') {
        state.searching = true;
        state.query = '';
      }
      return null;
  }
}
