# Collagent — Architecture Report

**Status:** originally an audit of v0.2.0, written before any changes. The audit's conclusion
was that the adapter boundary already sat in the right place and that the work was to push
three pieces of knowledge *down* into it. **That work has since been done, and Codex has been
added.** Sections below are updated to match; §11 records exactly what changed and what did not.

**Purpose:** establish whether the existing room/session architecture can host additional
agent runtimes (Codex, Cursor) without being redesigned. **Answer: yes — it did, and the core
did not change.**

> Where the code is ambiguous, or a documented intention does not match the implementation,
> this report says so explicitly rather than papering over it. The Codex adapters are written
> against a protocol verified by running the real `codex` v0.147.0 binary, but **not yet
> exercised against a live Codex install on this machine** — see §11.

---

## 1. System overview

Collagent makes a single agent session multiplayer. One person runs the agent on their own
machine; other people connect to a shared *room* and see an ordered stream of what is
happening, and can send instructions into it.

The system is three cooperating processes, which may all be on one machine or spread across
several:

1. **The session server** (`src/server/server.js`) — owns rooms, participants, presence, the
   event log and persistence. It is a pure router and state store: it never talks to an agent
   and contains no agent-runtime knowledge beyond one default string.
2. **The agent host** (`AgentHost` in `src/client/client.js` + an adapter from
   `src/adapters/`) — runs on the machine that owns the agent. It holds a WebSocket to the
   server, translates inbound instructions into adapter calls, and pushes normalized agent
   events back up.
3. **Participants** (`CollagentClient` + `startTui`, or the web page) — connect over
   WebSocket, replay history, render a live feed, send instructions and control commands.

Everything that happens in a room is an **event**: `{seq, ts, kind, actor, data}`. Events are
appended to a per-room append-only log, mirrored to a JSONL file, and fanned out to every
connected participant. All clients render from the same ordered stream, so any two
participants see identical content. There is no other channel — the event log *is* the
shared state.

The key design decision is that the agent is not proxied or re-hosted. In the default mode
the host's real, interactive Claude Code runs in a pseudo-terminal on the host's machine with
its normal UI; Collagent observes it through Claude Code's documented hook system and injects
remote instructions by typing them into its prompt box. Collagent is a *layer around* the
agent, not a wrapper that owns it.

---

## 2. Architecture diagram

Actual component names, with the file each lives in:

```text
  ┌──────────────────────────────────────────────────────────────────────┐
  │ PARTICIPANT PROCESS (any machine)                                    │
  │                                                                      │
  │   bin/collagent.js  →  run()            src/cli/index.js             │
  │        │  cmdCreate / cmdJoin / cmdOpen / cmdRooms / cmdStatus       │
  │        ↓                                                             │
  │   startTui()                            src/client/tui.js            │
  │        │  readline loop + renderEvent()                              │
  │        ↓                                                             │
  │   CollagentClient                       src/client/client.js         │
  │        │  connect / join / rejoin / sendInstruction / control        │
  └────────┼─────────────────────────────────────────────────────────────┘
           │
           │   JSON over WebSocket   ws://host:7717/ws
           │
  ┌────────▼─────────────────────────────────────────────────────────────┐
  │ SESSION SERVER PROCESS (anywhere)       src/server/server.js         │
  │                                                                      │
  │   createCollagentServer()                                            │
  │     wss.on('connection') → handleMessage()                           │
  │     participantConns: Map<code, Set<ws>>   agentConns: Map<code, ws> │
  │        │                                                             │
  │        ↓                                                             │
  │   SessionManager                        src/core/session-manager.js  │
  │     create() / get() / restore() / end()                             │
  │        │                                                             │
  │        ↓                                                             │
  │   Session                               src/core/session.js          │
  │     participants · role · driverId · status · mode · agentToken      │
  │        │                                                             │
  │        ↓                                                             │
  │   EventLog                              src/core/event-log.js        │
  │     append() → memory + ~/.collagent/history/<CODE>.jsonl            │
  │     since(seq) → replay                                              │
  │                                                                      │
  │   also serves:  /healthz  /api/sessions  /api/sessions/:code  /      │
  │                 web page → src/server/web/index.html                 │
  └────────▲─────────────────────────────────────────────────────────────┘
           │
           │   JSON over WebSocket (same /ws endpoint, agent_attach role)
           │
  ┌────────┼─────────────────────────────────────────────────────────────┐
  │ AGENT HOST PROCESS (creator's machine)                               │
  │                                                                      │
  │   AgentHost                             src/client/client.js         │
  │     _route(msg) → adapter · _emit(event) → server                    │
  │        │                                                             │
  │        ↓                                                             │
  │   AgentAdapter  (interface)             src/adapters/adapter.js      │
  │     createSession · attach · sendInstruction · pause · resume        │
  │     handoff · disconnect                                             │
  │        │                                                             │
  │        ├── ClaudeNativeAdapter          src/adapters/claude-native.js│
  │        │      node-pty ─────────────────→ `claude` (interactive UI)  │
  │        │      hook receiver (loopback) ←── bin/collagent-hook.js     │
  │        │      status line ─────────────── bin/collagent-statusline.js│
  │        │                                                             │
  │        ├── ClaudeCodeAdapter            src/adapters/claude-code.js  │
  │        │      child_process ────────────→ `claude -p --stream-json`  │
  │        │                                                             │
  │        └── MockAdapter                  src/adapters/mock.js         │
  └──────────────────────────────────────────────────────────────────────┘
```

Note that `CollagentClient` and `AgentHost` are two *separate* WebSocket connections, even
when they are inside the same OS process (which is what `collagent create` does). The server
distinguishes them by `ws._ctx.role`, set to `'participant'` or `'agent'`.

---

## 3. Repository map

```text
bin/
  collagent.js              Entry point (shebang). Calls run(process.argv.slice(2)).
                            7 lines; all logic is in src/cli.
  collagent-hook.js         CLAUDE-SPECIFIC. Registered as a Claude Code hook command.
                            Reads a hook payload on stdin, POSTs it to the adapter's
                            loopback receiver. Deliberately silent and always exit 0 —
                            observation must never break the agent.
  collagent-statusline.js   CLAUDE-SPECIFIC. Registered as Claude Code's statusLine
                            command. Fetches /api/sessions/:code and renders room code
                            + presence at the bottom of the native Claude UI.

src/
  version.js                Reads version from package.json. Used for the server/CLI
                            version handshake in ensureServer().

  cli/
    index.js                All commands: serve, create, open, rooms/ls, join, status,
                            leave. Also flag parsing, ~/.collagent/state.json handling,
                            local-server bootstrap (ensureServer/stopLocalServer), and
                            offline room listing straight from history files.
                            The largest file (480 lines) and the most Claude-shaped
                            part of the "generic" layer — see §6.

  core/                     Agent-agnostic domain model. No imports from adapters/.
    session.js              Session class: participants Map, roles, driverId, status,
                            mode, agentToken, EventLog. toJSON() is the public snapshot;
                            summary() adds history-derived facts.
    session-manager.js      Room registry keyed by uppercase code. create(), get()
                            (case-insensitive), end(), and restore() which rebuilds
                            every non-ended room from ~/.collagent/history/*.jsonl on
                            server boot. defaultDataDir() lives here.
    event-log.js            Append-only, seq-numbered log. append() writes memory +
                            JSONL. since(seq) is the replay primitive. seed() loads
                            persisted entries without rewriting them.
    permissions.js          can(session, participant, action) and denyReason(). Pure
                            function of role/mode/driver/status. Fully generic.
    ids.js                  sessionCode() (5 chars, ambiguity-free alphabet),
                            participantId(), token(), uuid().
    room-summary.js         buildRoomSummary(events) — folds an event array into
                            {agentType, createdAt, lastActivity, cwd, agentSessionId,
                            lastInstruction, participantsEver, ended}. Used by both the
                            live server and the offline CLI path, so both agree.

  server/
    server.js               createCollagentServer(). WebSocket routing, presence,
                            fan-out, permission checks, agent attach/route, HTTP status
                            API, static web page.
    web/index.html          Self-contained browser participant. Same WS protocol as the
                            CLI, same event kinds, own renderer. No build step.

  client/
    client.js              Two classes. CollagentClient — participant connection with
                            automatic reconnect + resume credentials + sinceSeq replay.
                            AgentHost — the adapter↔server bridge; owns the second
                            WebSocket and translates protocol messages to adapter calls.

  ui/                      Everything the human sees in a terminal.
    colors.js              paint (ANSI helpers) incl. the logo's accent orange.
    brand.js               The Collagent mark + wordmark, transcribed for a terminal.
    picker.js              pickRuntime() — the interactive coding-agent chooser.
                           Redraws in place, skips runtimes that aren't ready, and
                           restores stdin exactly as found (the adapter that runs
                           next may want raw mode for its own PTY).
    tui.js                 renderEvent() (the event→line mapping), renderPresence(),
                           renderRoomList(), ago(), shortPath(), and startTui() which
                           runs the readline loop and dispatches /commands.

  adapters/                Grouped by runtime.
    adapter.js             The AgentAdapter base class and the documented normalized
                           event contract. This is the abstraction boundary.
    registry.js            RUNTIMES (what a human picks) + ADAPTERS (what the code
                           instantiates, each with capabilities). createAdapter(),
                           describeAdapter(), adapterFor(). The extension point.
    claude/
      native.js            CLAUDE-SPECIFIC. PTY passthrough, hook receiver, --settings
                           overlay, composer injection, dedupe, translateHookEvent().
      headless.js          CLAUDE-SPECIFIC. stream-json; normalizeClaudeMessage().
    codex/
      native.js            CODEX-SPECIFIC. PTY passthrough + hooks, via a throwaway
                           CODEX_HOME that symlinks the real one and adds hooks.json.
      app-server.js        CODEX-SPECIFIC. JSON-RPC over stdio to `codex app-server`;
                           owns one thread and one turn at a time.
      protocol.js          Pure: framing helpers + translateAppServerEvent().
      hooks.js             Pure: HOOK_EVENTS + translateCodexHookEvent().
    mock.js                Runtime-neutral fake agent for tests and offline demo.

scripts/
  setup.sh                 Prereq check, npm install, chmod on bins, node-pty prebuilt
                           binary fix (exec bit + macOS quarantine), npm link.
  e2e-demo.js              Scripted end-to-end proof against real Claude Code.

test/
  core.test.js             Codes, permissions, driver fallback, event log, name dedupe,
                           snapshot secret-leak check.
  server.test.js           Full flow over real WebSockets with MockAdapter; pause/resume,
                           driver mode, handoff, reconnect replay, status endpoint.
  rooms.test.js            Persistence + restore, restored-room host takeover, room
                           listing sort, healthz version.
  claude-adapter.test.js   normalizeClaudeMessage() + adapter driving fake-claude.js.
  claude-native.test.js    translateHookEvent() + injection dedupe + queueing +
                           settings-overlay shape.
  fixtures/fake-claude.js  Stub speaking Claude Code's stream-json protocol.
```

---

## 4. Runtime flow

One complete instruction, traced through actual functions. This is the default
(`claude-native`) path.

**Alice creates a room**

1. `collagent create` → `run()` → `cmdCreate()` (`cli/index.js:113`).
2. `ensureServer(serverUrl)` (`cli/index.js:428`) probes `GET /healthz`. If nothing is
   listening — or a *different version* is — it spawns `collagent serve` detached and polls
   for up to 3 s. Rooms restore from disk on boot, so restarting loses nothing.
3. `new CollagentClient({serverUrl, name})` → `connect()` opens `ws://…/ws`.
4. `client.createSession({agentType})` sends `{type:'create_session', name, agentType}`.
5. Server `onCreateSession()` (`server.js:103`): `manager.create()` mints a code via
   `sessionCode()`, constructs a `Session` with `persistPath`, and appends `session_created`.
   Alice is added with `role:'host'`; because she is host and `driverId` is null, she also
   becomes driver (`session.js:40`). A `participant_joined` event is appended and broadcast.
6. Server replies `session_created` carrying the session snapshot, Alice's
   `{participantId, resumeToken}`, the room's **`agentToken`**, and the full event list.
7. `cmdCreate` → `saveState()` writes `~/.collagent/state.json`, then `hostRoom()`.

**Claude Code starts**

8. `hostRoom()` (`cli/index.js:223`) calls `createAdapter(adapterType, {...})` and constructs
   `new AgentHost({serverUrl, code, agentToken, adapter})`.
9. `host.start()` (`client.js:177`) opens a *second* WebSocket, sends
   `{type:'agent_attach', code, agentToken}`. Server `onAgentAttach()` validates the token,
   records `agentConns.set(code, ws)`, tags `ws._ctx.role = 'agent'`, replies
   `agent_attached`.
10. `host.start()` then does `adapter.attach(event => this._emit(event))` and
    `await adapter.createSession()`.
11. `ClaudeNativeAdapter.createSession()` (`claude-native.js:55`):
    - `_startHookReceiver()` binds an HTTP server on `127.0.0.1:0` with a random-token path.
    - `_writeHookSettings(hookUrl)` writes a temp settings JSON registering seven hooks
      (each running `bin/collagent-hook.js <url>`) plus the `statusLine` command.
    - `pty.spawn('claude', ['--settings', file, …])` with `CLAUDECODE`,
      `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_CHILD_SESSION` stripped from the env.
    - Wires `pty.onData → process.stdout`, raw-mode `stdin → pty.write`, and a resize
      handler. **Alice's terminal is now the real Claude Code UI.**
    - Emits `agent_status/ready`, which travels host → server → all participants.

**Bob joins**

12. `collagent join 7FK2P` → `cmdJoin()` → `client.join(code)` sends `{type:'join', code, name}`.
13. Server `onJoin()` (`server.js:120`): since the room already `hasHost()`, Bob's role is
    `collaborator`. If his name collides, `_uniqueName()` appends `-2`. A
    `participant_joined` event is broadcast; Bob receives `welcome` with `events:
    session.log.since(0)` — the **entire** history.
14. `enterRoomFeed()` (`cli/index.js:297`) filters out `agent_status` churn
    (`REPLAY_SKIP`), prints the remaining history through `renderEvent()`, prints
    "— you are caught up —", then hands control to `startTui()`.

**Bob sends an instruction**

15. Bob types text with no leading `/`; `startTui`'s `rl.on('line')` calls
    `client.sendInstruction(text)` → `{type:'instruction', text}`.
16. Server `onInstruction()` (`server.js:209`): `resolveParticipant(ws)`, then
    `can(session, participant, 'instruct')`. In `open` mode anyone may instruct unless the
    room is paused or ended.
17. Server appends an `instruction` event with Bob as actor and **broadcasts it first** — so
    every participant sees it even if the agent is gone. If no agent is attached it appends an
    `error` event and stops. Otherwise it sets `status='working'` and forwards
    `{type:'instruction', text, from:{id,name}, eventSeq}` to the agent socket.
18. `AgentHost._route()` → `adapter.sendInstruction({text, from})`.
19. `ClaudeNativeAdapter.sendInstruction()` (`claude-native.js:202`): if paused or
    `!sessionStarted`, the instruction is queued. Otherwise `_inject()` records the exact line
    for echo dedupe, writes `\x1b[200~[Bob] Add OAuth…\x1b[201~` (bracketed paste) into the
    PTY, and 150 ms later writes `\r`. **The text appears visibly in Alice's prompt box and is
    submitted.**

**Claude produces events; everyone sees them**

20. Claude Code fires `UserPromptSubmit`. `bin/collagent-hook.js` POSTs the payload to the
    loopback receiver. `_onHook()` translates it to `local_prompt` — then *drops it*, because
    `_wasInjected()` recognises the text as Collagent's own injection (`claude-native.js:185`).
21. As Claude works, `PreToolUse` / `PostToolUse` hooks fire per tool call. Each becomes
    `tool_use` / `tool_result` via `translateHookEvent()` and is emitted.
22. Each emitted event goes `adapter.emit` → `AgentHost._emit` →
    `{type:'agent_event', event}` → server `onAgentEvent()` (`server.js:191`).
23. `onAgentEvent` splits `{kind, ...data}`, updates `session.agentStatus` /
    `session.agentInfo` for `agent_status` events, calls `applyAgentStatus()` to map agent
    status onto room status, appends the event with an `agent` actor, then
    `broadcastEvent()` + `broadcastSession()`.
24. `broadcastEvent` writes `{type:'event', event}` to every socket in
    `participantConns.get(code)`. Alice's CLI, Bob's CLI and any web viewer all receive the
    identical payload.
25. Bob's `CollagentClient._onMessage` updates `lastSeq` and emits `'event'`;
    `startTui`'s handler calls `renderEvent()` and prints the line above his prompt.
26. On turn end, the `Stop` hook produces two events: `result {ok:true}` then
    `agent_status/idle`. Bob sees `✓ turn complete`.

**Important caveat on step 21–26:** in `claude-native` mode no `agent_message` event is ever
produced, because `translateHookEvent()` (`claude-native.js:280`) has no case that emits one.
Claude Code's hook system fires on lifecycle boundaries, not on assistant prose. Participants
therefore see instructions, tool activity and turn completion, but never the agent's replies.
The renderers on both clients (`tui.js:40`, `index.html:121`) already handle `agent_message`;
nothing feeds them in native mode. Only `ClaudeCodeAdapter` (`claude-code.js:224`) and
`MockAdapter` (`mock.js:40`) emit it. This is a real gap, verified against stored history
files, and it is relevant to §9 because it shows the event contract is documented but not
enforced.

---

## 5. Data model

All objects are plain JS — there is no schema library, no validation layer and no database.

### Session (`src/core/session.js:16`)

The central entity. Called a "room" in the CLI and "session" in the code; they are the same
thing.

| Field | Type | Notes |
|---|---|---|
| `code` | string | 5 chars from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. Uppercase, ambiguity-free. Also the persistence filename and the registry key. |
| `agentType` | string | Adapter id, e.g. `claude-native`. Defaults to `'unknown'` in the constructor but is overwritten by callers that default to `'claude-code'` (§6). |
| `createdAt` | number | `Date.now()` at construction — **not** restored from history for reopened rooms. |
| `status` | enum | `waiting_agent \| idle \| working \| paused \| ended` |
| `mode` | enum | `open \| driver` |
| `driverId` | string\|null | Participant currently "holding the keyboard". |
| `participants` | `Map<id, Participant>` | In-memory only. |
| `agentToken` | string | 32-hex. Authenticates the agent connection. Regenerated on restore — old tokens do not survive a restart. |
| `agentInfo` | object\|null | Free-form `detail` from the last `agent_status/ready`. |
| `log` | EventLog | The room's history. |

### Participant (`src/core/session.js:31`)

Created by `addParticipant()`. There is **no user model** — identity is per-room and
ephemeral. The same human joining twice is two unrelated participants.

| Field | Notes |
|---|---|
| `id` | `p_` + 12 hex. |
| `resumeToken` | 32-hex. Proves identity on reconnect. Never included in `toJSON()`. |
| `name` | Display name, uniquified within the room by `_uniqueName()` (`Bob`, `Bob-2`, …). |
| `role` | `host \| collaborator`. First joiner of a hostless restored room is promoted to host. |
| `connected` | Presence flag. Set false on socket close, true on rejoin. |
| `joinedAt` | Timestamp. |

Note `toJSON()` (`session.js:107`) exposes only `{id, name, role, connected}` — `resumeToken`
and `agentToken` never leave the server. `test/core.test.js:88` asserts this.

### Event (`src/core/event-log.js:26`)

```js
{ seq, ts, kind, actor, data }
```

`seq` is monotonic per room starting at 1; `ts` is server wall-clock. `actor` is one of three
shapes built in `server.js:359-361`:

```js
{ type: 'system', name: 'collagent' }          // sysActor
{ type: 'user',   id, name }                   // userActor
{ type: 'agent',  name: session.agentType }    // agentActor
```

**Event kinds actually in use.** There is no central enum; this list is assembled from
producers and consumers.

*Room lifecycle (server-produced, generic):* `session_created`, `participant_joined`,
`participant_left`, `participant_disconnected`, `participant_reconnected`, `session_paused`,
`session_resumed`, `control_transferred`, `mode_changed`, `session_ended`, `error`.

*Instruction (server-produced, generic):* `instruction`.

*Agent-produced, documented in `adapter.js:9-15`:* `agent_status`, `agent_message`,
`tool_use`, `tool_result`, `result`, `error`.

*Agent-produced, NOT in the documented contract:* `local_prompt` (host typed directly into
the native UI) and `notice` (Claude Code `Notification` hook). Both are emitted by
`claude-native.js` and consumed in generic code — `tui.js:35`, `index.html:119`,
`room-summary.js:27`. **The documented adapter contract is already out of date.** This
matters for §10.

### Message (protocol frames)

Distinct from events. Documented in the header comment at `server.js:16-22` and implemented
in `handleMessage()`:

```text
participant → server   create_session · join · rejoin · instruction · control · leave
agent host  → server   agent_attach · agent_event
server → participant   session_created · welcome · event · session · error
server → agent host    agent_attached · instruction · pause · resume · handoff · end
```

There is no message envelope, version field, or id/correlation field. `instruction` carries
`eventSeq` to the agent but nothing uses it for correlation today.

### History

Two representations of the same data:

- **In memory:** `EventLog.events` — a plain array, unbounded.
- **On disk:** `~/.collagent/history/<CODE>.jsonl`, one JSON event per line, append-only.

`buildRoomSummary(events)` (`core/room-summary.js`) folds either representation into the
descriptive object used by `/api/sessions` and by the offline CLI listing. Both paths call the
same function, so the live and offline listings cannot drift.

### Agent state

Deliberately thin and split in two places:

- **On the Session:** `agentStatus` (raw string from the adapter) and `agentInfo` (free-form
  `detail` blob). `applyAgentStatus()` (`server.js:297`) maps agent status → room status via
  `{ready:'idle', idle:'idle', working:'working', exited:'waiting_agent',
  disconnected:'waiting_agent'}`, with a pause gate that wins unless forced.
- **Inside the adapter:** everything real — the PTY handle, the hook receiver, the queue, the
  paused flag, `sessionStarted`, `_recentInjections`. None of this is visible to the core.

The only agent state that survives a restart is `lastAgentSessionId()` (`session.js:90`),
which scans the log backwards for `agent_status.detail.sessionId`. This is how
`collagent open` resumes the underlying Claude Code conversation.

### Local CLI state (`~/.collagent/`)

```text
~/.collagent/
  history/<CODE>.jsonl   per-room event log (append-only, no expiry)
  state.json             last room joined: {serverUrl, code, self, name} — used by
                         `collagent leave` and as a fallback code for `collagent status`
  server.json            {pid, port, version} — used by ensureServer/stopLocalServer
```

---

## 6. Claude Code coupling

### Fully Claude-specific — replace per runtime

| File / symbol | Why it exists |
|---|---|
| `src/adapters/claude-native.js` (entire file) | Everything about driving interactive Claude Code: `node-pty` spawn, `--settings` overlay generation, the loopback hook receiver, bracketed-paste composer injection, injection echo dedupe, `translateHookEvent()`. |
| `src/adapters/claude-code.js` (entire file) | The headless path: `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode X --session-id UUID`, stdin JSON-line writes, `normalizeClaudeMessage()` for `system/init`, `assistant`, `user`(tool_result), `result`. |
| `bin/collagent-hook.js` | Exists only because Claude Code's hook mechanism invokes a *command* and passes payload on stdin. A runtime with a socket or SDK callback would not need a forwarder binary. |
| `bin/collagent-statusline.js` | Exists only because Claude Code supports a `statusLine` command. This is how presence is shown without touching the agent's UI — there is nowhere else to put it when the PTY owns the screen. |
| `test/fixtures/fake-claude.js` | Stub of Claude Code's stream-json protocol. |

### Claude-specific logic sitting *inside* otherwise-generic files

This is the important category — these are the leaks that will need attention.

| Location | Coupling |
|---|---|
| `cli/index.js:157` `pickAdapter()` | `opts.adapter ?? (opts.headless \|\| !process.stdout.isTTY ? 'claude-code' : 'claude-native')`. Adapter selection is hardcoded to the two Claude adapters. There is no way to express "default runtime" generically. |
| `cli/index.js:239-240` | Resume wiring branches on adapter *name*: `claude-native` gets `extraArgs:['--resume', id]`; `claude-code` gets `{sessionId:id, resume:true}`. Two different Claude CLI conventions encoded in the generic CLI. |
| `cli/index.js:250` | `if (adapterType === 'claude-native')` decides the entire **UI mode** — PTY takes over the terminal and no TUI starts, vs. banner + `startTui()`. This is really a capability question ("does this adapter own the terminal?") expressed as a name check. |
| `cli/index.js:34-37` | `--headless`, `--model`, `--permission-mode` are Claude concepts in the shared flag surface. `--permission-mode` is documented as headless-only. |
| `cli/index.js:19,22-24,43` | Usage text hardcodes "Claude Code". |
| `client/tui.js:41` | `⏺ claude` — the `agent_message` prefix is a hardcoded literal. |
| `client/tui.js:54-62` | The `agent_status` label map hardcodes "claude code is starting…", "claude code ready", "claude code is working…", "claude code exited". Contrast `renderPresence()` at `tui.js:92`, which correctly uses `session.agentType ?? 'agent'` — the generic pattern already exists in the same file. |
| `server/web/index.html:135-136` | "claude is working…", "claude ready". |
| `core/room-summary.js:27-29` | Handles `local_prompt` and labels it `'host terminal'` — a `claude-native`-only event kind understood by core. |
| `server/server.js:103` | `agentType = 'claude-code'` default for `create_session`. |
| `client/client.js:112` | `createSession({agentType = 'claude-code'})` default. |
| `core/session-manager.js:39` | `agentType: created?.data?.agentType ?? 'claude-code'` when restoring a room whose `session_created` event lacks the field. |

Those three defaults mean a room whose `agentType` is unknown is *assumed to be Claude*.
That is harmless today and actively wrong once a second runtime exists.

### Already generic — should not need changes

| Component | Assessment |
|---|---|
| `core/event-log.js` | Fully generic. No agent concepts. |
| `core/permissions.js` | Fully generic. Pure function of role/mode/driver/status. |
| `core/ids.js` | Fully generic. |
| `core/session.js` | Generic apart from the constructor's `agentType` default of `'unknown'` (which is the *correct* neutral default). `lastAgentSessionId()` is named generically and works for any adapter that puts `sessionId` in `agent_status.detail` — though that convention is undocumented. |
| `core/session-manager.js` | Generic apart from the restore default noted above. |
| `server/server.js` | Generic apart from one default string. Routing, presence, fan-out, permission enforcement, agent attach and the HTTP API contain no runtime knowledge. `onAgentEvent()` passes any `kind` through untouched. |
| `client/client.js` | Both classes generic. `AgentHost._route()` maps six protocol messages onto the six `AgentAdapter` methods and nothing else. This is the cleanest boundary in the codebase. |
| `adapters/adapter.js` | The interface itself is runtime-neutral. |
| `adapters/index.js` | Registry mechanism is generic; only its contents are Claude. |
| `adapters/mock.js` | Genuinely runtime-neutral, and it works — which is real evidence the boundary holds. |
| Transport, event envelope, persistence format | All runtime-neutral. |

---

## 7. Real-time architecture

**Transport.** JSON text frames over WebSocket, path `/ws`, served by `ws`'s
`WebSocketServer` attached to the same Node HTTP server that serves the status API and the web
page (`server.js:31-32`). One port, default 7717. `normalizeWsUrl()` (`client.js:232`) accepts
`http://`, `https://`, bare host, or `ws://`, and appends `/ws` if the path is empty — so
`--server 192.168.1.5:7717` works.

**Connection roles.** Both participants and agent hosts use the same endpoint. Role is
established by the first message (`join`/`create_session` vs `agent_attach`) and stored on
`ws._ctx` (`server.js:35`). Agents authenticate with the room's `agentToken`; participants do
not authenticate at all — knowing the code is sufficient.

**Subscriptions.** There is no subscribe/topic mechanism. Membership *is* the subscription:
`registerParticipant()` adds the socket to `participantConns.get(code)`, a `Set<ws>`.
`agentConns` is `Map<code, ws>` — **one agent per room, enforced by the map shape.**

**Broadcasting.** `broadcastEvent()` and `broadcastSession()` (`server.js:341-353`) serialize
once and write to every open socket in the room's set. No batching, no backpressure handling,
no per-participant filtering. Every participant receives every event; filtering is a client-side
render concern (`REPLAY_SKIP` in `cli/index.js:295` is the only example).

Two independent streams reach clients:
- `{type:'event', event}` — one appended event, ordered by `seq`.
- `{type:'session', session}` — a full snapshot after any state change.

**Event ordering.** Guaranteed by `EventLog.append()` incrementing `this.seq` synchronously
before the write. Since the server is single-threaded and broadcast happens immediately after
append, all clients receive events in log order.

**Reconnect.** Client-side, in `CollagentClient._onClose()` (`client.js:80`):

1. If `closed` was set intentionally, emit `'closed'` and stop.
2. A `_reconnecting` guard prevents nested loops from failed attempts' own close events.
3. Emit `'disconnected'`. If there are no resume credentials, give up.
4. Retry up to 10 times with exponential backoff, `250ms · 2^(n-1)` capped at 5 s.
5. On a successful open, send `{type:'rejoin', code, participantId, resumeToken, sinceSeq: this.lastSeq}`.

Server-side, `onRejoin()` (`server.js:147`) validates `resumeToken` against the stored
participant, flips `connected = true`, appends `participant_reconnected`, and replies with
`welcome` containing `events: session.log.since(sinceSeq)` — **exactly the missed events**, plus
`resumed: true` so the client emits `'reconnected'` instead of `'welcome'`.

**Disconnect.** `handleClose()` (`server.js:316`) branches on role. A participant is marked
`connected = false` (the participant object is *retained*, so the name stays reserved and
resume works) and `participant_disconnected` is broadcast. An agent is removed from
`agentConns`, `agentStatus` is set to `disconnected`, and the room falls to `waiting_agent`.
Note the asymmetry: an explicit `leave` calls `removeParticipant()` and deletes the record; a
dropped socket does not.

**Presence.** Derived, not stored separately: `session.toJSON().participants[].connected`,
pushed to clients via `broadcastSession()`. The native-UI status line polls
`/api/sessions/:code` on a 2 s `refreshInterval` instead, because joins and leaves produce no
conversation activity and Claude Code's status line is otherwise event-driven
(`claude-native.js:167-174`).

---

## 8. Persistence

**What is persisted.** Only the event log. One JSONL file per room at
`~/.collagent/history/<CODE>.jsonl` (`COLLAGENT_DATA_DIR` overrides the root). Every event —
lifecycle, instructions, agent activity — is written. Nothing else is: participant identities,
resume tokens and `agentToken` are memory-only and are regenerated or lost on restart.

**When it is written.** Synchronously, inside `EventLog.append()` (`event-log.js:25-37`), via
`fs.appendFileSync`, in the same tick as the in-memory push and before broadcast. Wrapped in
`try/catch` with an explicit "never let disk issues break the session" comment. Writes are
therefore durable-before-broadcast but block the event loop.

**How history is reconstructed.** Two paths, both real:

1. **Server boot** — `SessionManager.restore()` (`session-manager.js:13`) reads every
   `*.jsonl` in the history dir, parses line by line, **skips any file containing a
   `session_ended` event**, constructs a `Session`, calls `log.seed(entries)` (which sets
   `seq` to the max seen without rewriting the file), forces `status = 'waiting_agent'`, and
   replays the last `mode_changed` to restore mode. Participants are *not* restored — a
   restored room has no host until someone joins.
2. **Offline CLI** — `listRooms()` (`cli/index.js:194`) checks `/healthz` first; if the server
   is down it reads the same files directly and runs `buildRoomSummary()` on each. This is why
   `collagent rooms` works with no server running.

**Replay to a joiner.** `onJoin` sends `session.log.since(0)` — the complete history, in one
frame. `onRejoin` sends `since(sinceSeq)` — only the gap.

**Retention.** None. There is no TTL, size cap, rotation or pruning anywhere in the codebase.
Files grow unbounded and persist indefinitely. A room leaves circulation only by an explicit
`/end` (which writes `session_ended`, after which `restore()` skips the file permanently — the
file remains on disk but can never be loaded again) or by manual deletion.

**Not persisted, worth naming:** `createdAt` is reset to "now" when a room is restored, so a
reopened room reports the wrong age; `agentToken` is regenerated, invalidating any previously
issued token; participant list starts empty, which is what enables the host-takeover behaviour
in `onJoin` (`server.js:127`).

---

## 9. Current limitations for a Codex or Cursor adapter

Identified, not solved.

**1. Adapter selection is name-based and hardcoded.** `pickAdapter()` (`cli/index.js:157`) can
only ever produce `claude-code` or `claude-native`. A third runtime is reachable only via an
explicit `--adapter` flag. There is no notion of a configured or per-room default runtime.

**2. UI mode is inferred from the adapter name, not from a capability.**
`cli/index.js:250` branches on `adapterType === 'claude-native'` to decide whether the adapter
takes over the terminal (PTY passthrough, no TUI) or whether Collagent renders its own feed.
Every future adapter must be classified into one of these two shapes, and today that
classification lives in a string comparison in the CLI. A Cursor adapter — driving a GUI
editor, owning neither the terminal nor a stdout stream — arguably fits *neither* branch.

**3. Adapters have no capability descriptor.** `AgentAdapter.info` is free-form metadata used
for display. Nothing declares: needs a PTY / supports resume / supports true pause / supports
interrupt / reports token cost. The core cannot ask an adapter what it can do, so callers
resort to name checks (limitations 1, 2 and 4 are all consequences of this).

**4. Session resume is an implicit, undocumented convention.** `lastAgentSessionId()`
(`session.js:90`) scans for `agent_status.detail.sessionId`, and `hostRoom()`
(`cli/index.js:239-240`) then translates that id into runtime-specific spawn options with an
`if` per adapter type. A new adapter must (a) know to emit `detail.sessionId` and (b) have its
resume flag shape added to that `if` chain in the CLI. Neither requirement is stated in
`adapter.js`.

**5. The documented event contract is incomplete and unenforced.** `adapter.js:9-15` lists six
kinds; `claude-native` also emits `local_prompt` and `notice`, which generic code
(`tui.js:35`, `room-summary.js:27`, `index.html:119`) already special-cases. Meanwhile
`claude-native` never emits `agent_message` at all, despite it being in the contract, and the
server accepts any `kind` without validation (`server.js:193`). A Codex adapter author has no
authoritative list of what to emit and no feedback if they emit the wrong thing. The
`agent_message` gap is concrete proof this is not theoretical.

**6. `pause` and `handoff` are not real agent operations.** `ClaudeCodeAdapter.handoff()`
(`claude-code.js:172`) stores the value with a "No-op for now" comment;
`ClaudeNativeAdapter.handoff()` (`claude-native.js:241`) does the same. `pause` in
`claude-native` only gates *injection* — the host can still type into the PTY, so the agent is
not actually paused. Whether these are meant to be optional-with-graceful-degradation or
genuinely required is unclear from the code, which is a problem for anyone implementing the
interface. **Flagging this as uncertainty rather than defect.**

**7. One agent per room, structurally.** `agentConns` is `Map<code, ws>`
(`server.js:29`) and `session.agentType` is a single string. A room cannot host two runtimes,
and a runtime cannot be swapped without ending the room. If "Claude and Codex in the same
room" is a future goal, this is the blocking shape.

**8. Instruction delivery has no acknowledgement or failure path.** The server forwards
`{type:'instruction', …}` to the agent socket and returns. `sendInstruction()` returns
`{queued:boolean}` but `AgentHost._route()` (`client.js:203`) discards the return value
entirely. If a runtime rejects, rate-limits, or queues an instruction, participants cannot be
told. `eventSeq` is passed but never used for correlation.

**9. Instructions are plain text with a `[Name]` prefix convention.** Both Claude adapters
build `[Bob] text` (`claude-code.js:151`, `claude-native.js:212`). Speaker attribution is
string formatting, not structured data. A runtime with a real multi-user or metadata channel
cannot express it, and a runtime that chokes on the prefix has no way to opt out.

**10. Claude vocabulary is baked into shared UI strings.** `tui.js:41,54-62` and
`index.html:135-136` print "claude" regardless of `agentType`. A Codex room would render
"claude code is working…". Low severity, but it is in the generic layer, and `renderPresence()`
(`tui.js:92`) already shows the correct pattern.

**11. Native-mode observability depends on the runtime having a hook system.**
`claude-native` works because Claude Code exposes documented lifecycle hooks, a `--settings`
overlay and a `statusLine` command. Codex and Cursor may expose none of these. The
"multiplayer around an untouched native UI" property is not portable — it is a consequence of
Claude Code's specific extensibility surface, and any runtime lacking an equivalent falls back
to a headless-style adapter with a different UX. **This is the deepest limitation, and it is a
product constraint rather than a code defect.**

**12. Adapter options are an untyped bag.** `hostRoom()` (`cli/index.js:233`) passes
`{cwd, model, permissionMode, statusUrl, sessionCode, extraArgs, sessionId, resume, onExit}`
to every adapter. `statusUrl`/`sessionCode` are meaningful only to `claude-native`;
`permissionMode` only to `claude-code`. There is no per-adapter option schema or validation.

**13. Persistence has no retention policy and `/end` is silently irreversible.** Unbounded
growth (§8), and `restore()` skipping `session_ended` files means an ended room is
permanently unloadable while still occupying disk. Independent of the adapter work, but it
will scale with the number of runtimes.

---

## 10. Proposed future adapter boundary

### The boundary already exists and is in the right place

`src/adapters/adapter.js` defines `AgentAdapter`, and `AgentHost._route()`
(`client.js:201-218`) is the only place the system calls into a runtime. That function is
20 lines and maps six protocol messages onto six interface methods. Everything below it is
runtime-specific; everything above it — server, session, event log, permissions, persistence,
transport — is not.

The evidence that this boundary is real, drawn from the code rather than intent:

- `src/core/` has **zero** imports from `src/adapters/`.
- `src/server/server.js` has zero imports from `src/adapters/`. It handles agent events with
  `const {kind, ...data} = event` and appends whatever it receives.
- `MockAdapter` (61 lines, no runtime at all) drives the full multiplayer flow, and
  `test/server.test.js` exercises create → join → instruct → results → pause/resume →
  handoff → reconnect entirely through it.
- Two *structurally different* Claude adapters already coexist — one PTY-based and
  observational, one child-process-based and stream-driven — behind the same interface.

So the target architecture in the brief:

```text
                 COLLAGENT CORE
        rooms / users / presence / history
                         |
          +--------------+--------------+
          |              |              |
       Claude          Codex          Cursor
       Adapter         Adapter         Adapter
```

…is not a redesign. It is what the code already does, with `mock` standing in as the proof of
a third adapter.

### Answer to the question posed

**Can the room/session architecture stay unchanged while swapping `ClaudeCodeAdapter` /
`CodexAdapter` / `CursorAdapter`?**

**`src/core/` and `src/server/`: yes, essentially unchanged.** The only edits are three
`'claude-code'` default strings (`server.js:103`, `client.js:112`, `session-manager.js:39`)
and the `local_prompt` special-case in `room-summary.js:27`. No structural change to Session,
EventLog, permissions, persistence, transport or fan-out.

**`src/cli/` and `src/client/tui.js`: no, these need work.** Not because the architecture is
wrong, but because adapter-specific knowledge leaked upward into them: `pickAdapter()`, the
resume-flag `if` chain, the `adapterType === 'claude-native'` UI-mode branch, and the
hardcoded "claude" render strings. All four are consequences of limitation 3 — adapters cannot
describe themselves, so callers inspect their names.

### Where the abstraction should sit

Based only on what exists, the recommendation is **not** to introduce a new layer. The layer is
there. The work is to move three pieces of knowledge *down* into it:

1. **A capability/metadata descriptor on `AgentAdapter`** (alongside the existing `info`
   getter, which is the natural home). It would answer what the CLI currently infers from
   names: does this adapter own the terminal, does it support resume, what is its resume
   option shape, what is its display label. This single addition dissolves limitations 1, 2, 4
   and 10.

2. **A complete, authoritative event-kind list in `adapter.js`** — adding `local_prompt` and
   `notice`, which are already in production use, and stating which kinds are required versus
   optional. Optionally enforced at `onAgentEvent` (`server.js:191`), the one funnel every
   agent event passes through. This addresses limitation 5.

3. **A stated convention for runtime session identity** — that an adapter wishing to support
   resume emits `sessionId` in `agent_status.detail`, which `lastAgentSessionId()`
   (`session.js:90`) already reads generically. This is currently tribal knowledge; writing it
   down addresses limitation 4.

The registry in `src/adapters/index.js` needs no structural change at all — a `CodexAdapter`
becomes one import and one map entry, exactly as its comment (`index.js:5-12`) anticipates.

### Explicitly out of scope for that boundary

Limitations 7 (one agent per room), 8 (no instruction acknowledgement) and 11 (native-mode
observability depends on the runtime having a hook system) are **not** solved by tidying the
adapter interface. 7 and 8 are protocol/shape changes in the core. 11 is a product decision
about whether "untouched native UI" is a promise Collagent can make for runtimes other than
Claude Code, and it should be answered before either new adapter is designed.

---

## 11. What changed when Codex was added

The audit predicted the core would not need structural change. It did not.

**Untouched:** `core/session.js`, `core/event-log.js`, `core/permissions.js`, `core/ids.js`,
`core/room-summary.js`, and all of `server/server.js`'s routing, presence, fan-out, permission
and agent-attach logic. Transport, event envelope and persistence format are byte-identical.
The only core edits were three `'claude-code'` default strings becoming `'unknown'`
(`server.js:103`, `client.js:112`, `session-manager.js:39`).

**Closed from §9:**

| # | Limitation | How |
|---|---|---|
| 1 | Adapter selection hardcoded | `resolveAdapter()` reads the registry; `--agent`, `--adapter`, or the interactive chooser |
| 2 | UI mode inferred from adapter name | `descriptor.ownsTerminal` |
| 3 | No capability descriptor | `registry.js` descriptors carry `ownsTerminal` + `resumeOptions()` |
| 4 | Resume an undocumented convention | `descriptor.resumeOptions(id)`; the `if` chain in the CLI is gone. `collagent open` now also reuses the room's stored `agentType` instead of re-asking |
| 10 | Claude vocabulary in shared UI | `renderEvent`/`startTui` take `agentLabel`; the web page derives it from `session.agentType` |

**Still open, unchanged:** 5 (event contract unenforced — though both Codex adapters emit the
full set, and `local_prompt`/`notice` are now documented in the registry's comments rather than
`adapter.js`), 6 (`pause`/`handoff` are not real agent operations — the Codex adapters match the
Claude ones and no-op `handoff`), 7 (one agent per room), 8 (no instruction acknowledgement),
9 (`[Name]` prefix convention), 12 (untyped option bag), 13 (no retention policy).

**Limitation 11 resolved better than expected.** The audit called "multiplayer around an
untouched native UI depends on the runtime having a hook system" the deepest limitation and
assumed it might not port. Codex turned out to have a genuine lifecycle hook system
(`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`), so
`codex-native` works the same way `claude-native` does. Two differences that are real:

- Codex has **no command-backed status line**, so presence cannot be drawn inside Codex's UI.
- Codex reads hook config from `$CODEX_HOME` rather than a `--settings` flag, so the overlay is
  a temp directory of **symlinks** to the real home plus our own `hooks.json` (merged with the
  host's, if any). Codex also gates hooks behind a trust prompt; if ours never runs, the 20 s
  startup fallback releases queued instructions rather than hanging forever.

**The `agent_message` gap does not apply to `codex` (app-server).** Because that adapter reads
`item/completed` directly rather than observing lifecycle boundaries, it emits real
`agent_message` events — Codex app-server rooms record what the agent actually said, which
`claude-native` rooms still do not.

### Verification status — read this before trusting the Codex adapters

| Claim | Status |
|---|---|
| Codex app-server protocol shapes (`initialize`/`initialized` handshake, `thread/start`, `turn/start`, `item/*`, no `jsonrpc` field, `emittedAtMs`) | Verified by running the real `codex` v0.147.0 binary during research |
| Codex hook event names, config location, payload field casing | From Codex's own generated schema and docs |
| `CodexAppServerAdapter` end to end | Tested against `test/fixtures/fake-codex-app-server.js`, which reproduces the wire quirks — **not** against a live Codex |
| `translateAppServerEvent` / `translateCodexHookEvent` | Unit tested, pure functions |
| `CodexNativeAdapter` PTY + `CODEX_HOME` symlink overlay | **Not executed** — `codex` is not installed on this machine |

Field access in both translators is deliberately defensive (`item.text ?? item.message`,
`tool_response ?? tool_output ?? tool_result`, case-insensitive hook names) because exact
casing for a few payload fields is not pinned down in Codex's public docs. The first run
against a real Codex install is the thing to watch.

---

## Uncertainties and open questions

Stated plainly rather than guessed at:

1. **Is `handoff()` meant to affect the agent?** Both Claude adapters no-op it. Unclear whether
   that is a deliberate design (handoff is a Collagent permission concept only) or unfinished
   work. `claude-code.js:173-175` describes an intended behaviour — "delivered as a lightweight
   note on the next instruction" — that is not implemented.
2. **Is `pause` supposed to stop the agent, or only remote input?** In `claude-native` it gates
   injection only; the host can keep typing. The room status says `paused` either way.
3. **Are `local_prompt` and `notice` intended to be part of the adapter contract**, or
   `claude-native` implementation details that leaked into core renderers? They are handled in
   generic code but absent from `adapter.js`.
4. **Is the missing `agent_message` in native mode a known trade-off or a defect?** The
   contract documents the kind, both renderers implement it, and no native code path produces
   it. Verified against stored history: every `claude-native` room on disk contains zero
   `agent_message` events, while the one `claude-code` room contains them.
5. **Is `createdAt` resetting on restore intentional?** `session.js:20` sets it in the
   constructor and `restore()` does not override it from the log, though
   `buildRoomSummary()` recovers the true value for listings. The snapshot and the summary
   therefore disagree.
6. **Is web-participant instruction sending intended to be unauthenticated?** The web page
   joins with only a room code and can immediately send instructions that execute on the host's
   machine. The README acknowledges MVP-level security generally, but this specific path is not
   called out.
7. **The 20 s `_startupFallback`** (`claude-native.js:117`) flushes queued instructions even if
   `SessionStart` never fired. If hooks are disabled, injection proceeds blind into whatever is
   on screen. Unclear whether the risk was weighed against the alternative of hanging forever.
8. **`result.ok` is hardcoded `true`** in native mode (`claude-native.js:296`), so
   `✗ turn failed` can never render there. Whether Claude Code's `Stop` hook can distinguish
   failure was not determined.
