# Collagent

**Multiplayer infrastructure for AI agents.**

Collagent lets multiple people connect to and collaborate around the **same live agent session**. This MVP supports **Claude Code**; the architecture is built so other runtimes (Lovable, Cursor, Replit, custom agents) can be added later through adapters, without touching the core.

```text
Human A ──┐
Human B ──┼── Collagent Session ── Agent Runtime (Claude Code)
Human C ──┘
```

Collagent does **not** replace the agent or become another coding workspace. Claude Code remains responsible for coding, terminal access, files, permissions and execution. Collagent provides the shared session layer: participant identity and presence, event streaming, instruction routing, permissions/handoff, pause/resume, and history.

## Quick start

```bash
./scripts/setup.sh        # installs deps + links the `collagent` command
```

**Alice** (owns the machine where Claude Code runs):

```bash
$ cd my-project
$ collagent create

✓ Shared session created
  Session: 7FK2P
  Invite:  collagent join 7FK2P
  Launching your normal Claude Code…
```

…and then Alice is in her **completely normal, untouched Claude Code UI** — welcome box, plan mode, permission prompts, file pickers, everything. The session code and live presence stay visible in Claude Code's own **status line** at the bottom of the UI:

```text
⧉ collagent 7FK2P · ●Alice* ●Bob · idle · invite: collagent join 7FK2P
```

(`collagent status` in another terminal shows the same.) Collagent does not replace or re-skin the UI. The multiplayer layer works around it:

- session activity streams to participants via Claude Code **hooks** (a documented feature),
- remote instructions are **typed visibly into Claude Code's own prompt box** as `[Bob] …` and submitted — nothing reaches the model behind Alice's back,
- Alice keeps answering trust/permission dialogs herself, natively. Remote instructions that arrive before the session is ready are queued and delivered once Claude Code is live.

**Bob** (same machine, or any machine that can reach Alice's server):

```bash
$ collagent join 7FK2P --name Bob
# or from another machine:
$ collagent join 7FK2P --name Bob --server ws://<alice-ip>:7717

✓ Joined shared session 7FK2P

● Alice [host, driver]  ● Bob (you)  ● claude code [working]

› Add OAuth callback validation.
```

Both terminals now show the same live feed: who joined, every instruction, Claude Code's messages, each tool call and result, and turn completions. Either participant can send instructions; the agent sees who is speaking (`[Bob] Add OAuth callback validation.`).

A minimal web page for joining/viewing (no dashboard) is served at `http://<server>:7717/?code=7FK2P`.

### Commands

```text
collagent create            create a shared room and launch Claude Code
collagent join <code>       join a room (replays the room's full history)
collagent open <code>       reopen a stored room as host and re-attach Claude Code
collagent rooms             list all rooms — who's in them, last activity, where
collagent status <code>     show one room's state + participants
collagent leave             leave the last room you joined
collagent serve             run a standalone session server
```

`collagent rooms` (also bare `collagent`) shows every live and stored room, newest first — online participants (or who was there), the last instruction and who sent it, the agent's working directory, relative timestamps, and event counts:

```text
 ● 7FK2P  idle     ●Alice* ●Bob        ~/dev/api
     └ Bob › add oauth validation to the login flow   2m ago · 47 events

 ○ stored ZADU8    was: Alice, Bob
     └ Alice › does history survive a server restart?  15m ago · 17 events
```

It works even when the server is down (reads stored history from disk), and outdated local servers are restarted automatically — rooms survive restarts.

### Rooms are stored

Every room's event history is persisted to `~/.collagent/history/<code>.jsonl` and **rooms survive server restarts** — the server restores them from disk on boot. Joining a room replays its entire history (instructions, agent messages, tool activity, joins/leaves), so newcomers are fully caught up. Closing Claude Code leaves the room stored; `collagent open <code>` reopens it as host and re-attaches Claude Code — in native mode it passes `--resume <claude-session-id>` so the actual Claude Code conversation continues where it left off. A room only disappears when the host ends it explicitly with `/end`.

`create` auto-starts a local session server if none is running. For cross-machine use, run `collagent serve` somewhere reachable and pass `--server ws://host:7717` to both `create` and `join`.

### In-session commands

```text
/participants        who is here (presence, host/driver markers)
/status              session state
/pause               pause the shared agent        (host or driver)
/resume              resume — queued instructions flush
/handoff <name>      hand control to another participant
/mode open|driver    open: anyone instructs; driver: only the driver
/end                 end the session for everyone  (host)
/quit                leave
```

Anything that isn't a `/command` is sent to the shared Claude Code agent.

## Architecture

```text
Claude Code ──┐
Lovable ──────┤  (future)
Cursor ───────┤  (future)
Custom agent ─┘
      │
AgentAdapter  ── normalized events ──►  Collagent Core  ◄── WS ──  CLI / web participants
```

Three layers, deliberately separated:

### 1. Collagent Core (`src/core/`, `src/server/`)

Agent-agnostic. Knows nothing about Claude Code.

| Piece | File | Responsibility |
|---|---|---|
| Session | `core/session.js` | participants, roles, status, mode, driver |
| Session manager | `core/session-manager.js` | invite codes, registry |
| Event log | `core/event-log.js` | append-only, seq-numbered history (+ JSONL audit file in `~/.collagent/history/`) |
| Permissions | `core/permissions.js` | who may instruct / pause / handoff / end |
| Session server | `server/server.js` | WebSocket routing, presence, fan-out, reconnect resync, HTTP status API, web page |

Everything that happens is an **event** (`{seq, ts, kind, actor, data}`). The server appends events to the session log and fans them out to every participant, so all clients render an identical ordered stream. Reconnecting clients send their last seen `seq` and get exactly the missed events replayed.

### 2. Agent Adapter Interface (`src/adapters/adapter.js`)

The contract that makes an agent runtime multiplayer:

```text
AgentAdapter
  createSession()      start the underlying agent session
  attach(onEvent)      subscribe to normalized agent events (receiveEvents)
  sendInstruction()    deliver an instruction ({text, from})
  pause() / resume()   gate + queue instructions
  handoff(info)        control changed hands
  disconnect()         tear down
```

Adapters emit **normalized events** — `agent_status`, `agent_message`, `tool_use`, `tool_result`, `result`, `error` — so the core never sees runtime-specific shapes. New runtimes register in `src/adapters/index.js`.

### 3a. ClaudeNativeAdapter (`src/adapters/claude-native.js`) — the default

Multiplayer **around** the real interactive Claude Code UI, never instead of it. Three supported mechanisms:

1. **PTY passthrough** — `collagent create` launches your normal `claude` inside a pseudo-terminal and pipes keys/screen through byte-for-byte. Plan mode, permission prompts, pickers: all native, all answered by the host.
2. **Hooks + status line** (documented Claude Code features) — a `--settings` overlay registers `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop` and `SessionEnd` hooks. Each fires a tiny forwarder (`bin/collagent-hook.js`) that POSTs the payload to a loopback receiver; the adapter translates it into normalized events for remote participants. No output scraping. The same overlay sets a `statusLine` command (`bin/collagent-statusline.js`) so the session code, invite command and live participant presence render at the bottom of the native UI. (If you already use a custom status line, Collagent's takes over for shared sessions only.)
3. **Composer injection** — a remote instruction is typed into Claude Code's own prompt box (bracketed paste + Enter) as `[Bob] …`, visibly. Instructions arriving before `SessionStart` (or while paused) are queued. The `UserPromptSubmit` echo of an injected instruction is deduplicated so remote users don't see it twice.

What the host types locally is shared too: `UserPromptSubmit` hooks surface it to participants as `⌨ host terminal › …`.

### 3b. ClaudeCodeAdapter (`src/adapters/claude-code.js`) — headless mode

For scripting, tests and the demo (`collagent create --headless`). Drives Claude Code through its **supported headless interface** (no undocumented APIs):

```bash
claude -p --input-format stream-json --output-format stream-json \
       --verbose --permission-mode acceptEdits --session-id <uuid>
```

- One long-running `claude` process per session; instructions are written to stdin as JSON lines, activity streams back as JSON lines.
- Claude Code's stream (`system/init`, `assistant`, tool results, `result`) is translated into normalized events.
- Instructions are tagged with the sender (`[Bob] …`) so the shared agent knows who's talking.
- If the process dies, the adapter restarts it with `--resume <session-id>` so conversation context is preserved.
- Everything Claude-specific is isolated here; the Claude Code session id, model and permission mode are adapter options (`--model`, `--permission-mode`, `--cwd` on `collagent create`).

A `MockAdapter` implements the same interface for tests and offline demos (`collagent create --adapter mock`).

> **Why two Claude adapters?** Native mode is the product: the host's Claude Code experience stays exactly as it was, so there is nothing new to trust. Headless mode exists because it's scriptable — CI tests and `npm run demo` can assert on a full turn without a human at a terminal. Both plug into the same `AgentAdapter` interface.

### Who runs where

- The **session server** can run anywhere (it's just routing + state). `collagent create` auto-starts one locally.
- The **agent host** (adapter + Claude Code process) runs on the creator's machine — their checkout, their credentials, their permission settings.
- **Participants** connect from anywhere with the CLI or the web page.

## Message flow for one instruction

```text
Bob types "Add OAuth callback validation."
  → CLI sends {instruction} to server
  → server checks permissions, appends event, broadcasts to Alice + Bob
  → server routes it to the session's agent connection
  → AgentHost (Alice's machine) → ClaudeCodeAdapter → claude stdin
  → Claude Code works; every message/tool call streams back up the same path
  → server appends + broadcasts each event
  → Alice and Bob both render: tool calls, agent messages, ✓ turn complete
```

## Testing

```bash
npm test        # 18 tests, no Claude account needed (mock adapter + fake claude)
npm run demo    # full end-to-end against REAL Claude Code (needs `claude` installed + logged in)
```

- `test/core.test.js` — sessions, permissions, driver fallback, event log.
- `test/server.test.js` — the full milestone flow over real WebSockets with the mock adapter, plus pause/resume, driver-mode/handoff, reconnect replay, status API.
- `test/claude-adapter.test.js` — stream-json normalization, and the adapter driving `test/fixtures/fake-claude.js`, a stub that speaks Claude Code's exact stream-json protocol.
- `scripts/e2e-demo.js` — the first-milestone proof: Alice creates → Bob joins → Bob instructs → real Claude Code writes a file → both feeds verified identical → pause/resume/handoff exercised.

## Security notes (MVP-level)

- Invite codes are unguessable-enough for a prototype but the server has no TLS/auth; run it on localhost or a trusted network.
- The agent connection is authenticated with a per-session `agentToken` handed only to the creator.
- Session snapshots never expose tokens.
- The default permission mode is `acceptEdits` — Claude Code can edit files in the session cwd without prompting, but Bash and other risky tools follow the host's normal Claude Code permission config. Choose `--permission-mode` deliberately; every participant you invite can drive the agent on the host's machine.

## Roadmap (not in the MVP)

- Adapters: Lovable, Cursor, Replit, custom-agent SDK (websocket protocol is already runtime-neutral)
- Interrupt/steer mid-turn, per-participant tool approval, richer roles
- Server persistence across restarts, TLS + auth for public servers
