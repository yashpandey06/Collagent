import { CollagentClient } from '../client/client.js';
import { loadRoomState, saveRoomState } from '../cli/room-store.js';
import { browserState, handleBrowserKey, renderBrowser, visibleRooms } from './browser.js';
import { appendLiveEvent, buildJoinPreview, handleRoomKey, renderRoom, roomState } from './room-view.js';
import { Term } from './term.js';

/**
 * The interactive Collagent app: room browser ⇄ room view.
 * Resolves with an action the CLI must handle outside the TUI
 * (create / attach need the terminal for Claude Code's own UI):
 *   {type:'quit'} | {type:'create'} | {type:'attach', code}
 */
export function runApp({ serverUrl, name, startRoom = null }) {
  return new Promise((resolve) => {
    const term = new Term();
    const browser = browserState();
    let screen = startRoom ? 'connecting' : 'browser';
    let room = null; // room view state
    let roomClient = null;
    let watcher = null;
    let watcherRetry = null;
    let drawQueued = false;

    const draw = () => {
      if (drawQueued) return;
      drawQueued = true;
      setImmediate(() => {
        drawQueued = false;
        if (screen === 'browser') term.draw(renderBrowser(browser, term.size));
        else if (screen === 'room' && room) term.draw(renderRoom(room, term.size));
        else term.draw(['', `  connecting to room ${startRoom ?? ''}…`]);
      });
    };

    const finish = (action) => {
      saveRoomProgress();
      roomClient?.close();
      watcher?.close();
      clearTimeout(watcherRetry);
      term.stop();
      resolve(action);
    };

    // ---- lobby (live room list) ----------------------------------------

    const connectWatcher = async () => {
      try {
        watcher = new CollagentClient({ serverUrl, name });
        watcher.on('rooms', (rooms) => {
          const selected = visibleRooms(browser)[browser.cursor]?.code;
          browser.rooms = rooms;
          browser.connected = true;
          const idx = visibleRooms(browser).findIndex((r) => r.code === selected);
          if (idx >= 0) browser.cursor = idx;
          draw();
        });
        watcher.on('closed', () => {
          browser.connected = false;
          draw();
          watcherRetry = setTimeout(connectWatcher, 2000);
        });
        await watcher.connect();
        watcher.watchRooms();
      } catch {
        browser.connected = false;
        draw();
        watcherRetry = setTimeout(connectWatcher, 2000);
      }
    };

    // ---- room lifecycle --------------------------------------------------

    const saveRoomProgress = () => {
      if (!room || !roomClient?.self) return;
      saveRoomState(room.code, {
        participantId: roomClient.self.participantId,
        resumeToken: roomClient.self.resumeToken,
        name: roomClient.name,
        lastSeenSeq: roomClient.lastSeq,
      });
    };

    const enterRoom = async (code) => {
      screen = 'connecting';
      draw();
      try {
        roomClient = new CollagentClient({ serverUrl, name });
        await roomClient.connect();
        const stored = loadRoomState(code);
        const { welcome, resumed } = await roomClient.joinOrResume(code, stored);

        room = roomState({
          code: roomClient.session.code,
          session: roomClient.session,
          selfName: roomClient.name,
          welcomeEvents: welcome.events ?? [],
          resumed,
          lastSeenSeq: stored?.lastSeenSeq ?? 0,
        });
        room.canAttach = Boolean(roomClient.agentToken);
        buildJoinPreview(room, Math.max(40, term.size.cols - 6));
        saveRoomProgress();

        roomClient.on('event', (e) => {
          if (screen !== 'room') return;
          appendLiveEvent(room, e, Math.max(40, term.size.cols - 6));
          saveRoomProgress();
          draw();
        });
        roomClient.on('session', (s) => {
          if (room) room.session = s;
          draw();
        });
        roomClient.on('server-error', (message) => {
          if (room) room.message = message;
          draw();
        });
        roomClient.on('disconnected', () => {
          if (room) room.connected = false;
          draw();
        });
        roomClient.on('reconnected', () => {
          if (room) {
            room.connected = true;
            room.session = roomClient.session;
          }
          draw();
        });

        screen = 'room';
        draw();
      } catch (err) {
        screen = 'browser';
        browser.message = `could not join ${code}: ${err.message}`;
        roomClient?.close();
        roomClient = null;
        room = null;
        draw();
      }
    };

    const leaveRoomToBrowser = () => {
      saveRoomProgress();
      roomClient?.close();
      roomClient = null;
      room = null;
      screen = 'browser';
      draw();
    };

    // ---- keys ------------------------------------------------------------

    term.keyHandler = (str, key) => {
      if (key.ctrl && key.name === 'c') return finish({ type: 'quit' });

      if (screen === 'browser') {
        const action = handleBrowserKey(browser, str, key);
        draw();
        if (!action) return;
        if (action.type === 'quit') return finish({ type: 'quit' });
        if (action.type === 'create') return finish({ type: 'create' });
        if (action.type === 'refresh') return watcher?.watchRooms();
        if (action.type === 'join') return void enterRoom(action.code);
      } else if (screen === 'room' && room) {
        const action = handleRoomKey(room, str, key);
        draw();
        if (!action) return;
        switch (action.type) {
          case 'send': return roomClient.sendInstruction(action.text);
          case 'pause': return roomClient.control('pause');
          case 'resume': return roomClient.control('resume');
          case 'back': return leaveRoomToBrowser();
          case 'quit': return finish({ type: 'quit' });
          case 'attach': return finish({ type: 'attach', code: room.code });
          default: return undefined;
        }
      }
    };

    term.resizeHandler = draw;
    term.start();
    draw();
    connectWatcher();
    if (startRoom) enterRoom(startRoom);
  });
}
