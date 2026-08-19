# Collagent

**Multiplayer infrastructure for AI agents.**

Collagent lets multiple people connect to and collaborate around the **same live agent session**. It supports **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, **OpenCode**, and **Goose** today, each through its own adapter. The core knows nothing about any of them, so new runtimes plug in without touching it.

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

     ●     ●
      ╲   ╱
       ╲ ╱
        ◉      C O L L A G E N T
        │      multiplayer sessions for AI coding agents
        ●

  Choose your coding agent

  ❯ ✳  Claude Code  Anthropic   native UI · hooks · status line
    ⬡  Codex        OpenAI      native UI · hooks · app-server threads
    ◆  Cursor       Anysphere   native UI · hooks · print mode
    ✦  Gemini CLI   Google      native UI · hooks · ACP
    ▌  OpenCode     Anomaly     native UI · server events · ACP
    ◈  Goose        Block       native UI · hooks · ACP

  ↑↓ move · enter select · q cancel
```

Pick one (or skip the chooser with `--agent claude` / `--agent codex`) and the room comes up:

```text
✓ Room created  7FK2P · Claude Code

  Invite your team   collagent join 7FK2P
  Watch in browser   http://localhost:7717/?code=7FK2P

Opening your normal Claude Code — teammates' instructions appear right in its prompt box.
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
collagent delete <code>     delete a room and its history (asks first; --yes skips)
collagent serve             run a standalone session server
```

`collagent rooms` (also bare `collagent`) shows every room — live rooms with people in them first — with the coding agent, who's there (and how many), the last instruction, the working directory, and recency:

```text
  ◉ collagent · 2 rooms

   CODE    AGENT        STATUS  PEOPLE          FOLDER
 ● 7FK2P   Claude Code  idle    2 · Alice* Bob  ~/dev/api
      └ Bob › add oauth validation to the login flow   2m ago · 47 events

 ○ ZADU8   Codex        saved   was Alice, Bob  ~/dev/api
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

Adapters emit **normalized events** — `agent_status`, `agent_message`, `tool_use`, `tool_result`, `result`, `error`, plus `local_prompt` and `notice` from adapters that watch a native UI — so the core never sees runtime-specific shapes.

New runtimes register in `src/adapters/registry.js`, which also carries each adapter's **capabilities**, so no caller has to branch on an adapter's name:

| Field | Meaning |
|---|---|
| `ownsTerminal` | the adapter takes over the terminal with the runtime's own UI, so Collagent must not start its own TUI on top of it |
| `resumeOptions(id)` | turns a stored runtime session id into adapter options, keeping each runtime's resume convention in one place |

Adapters are grouped by runtime:

```text
src/adapters/
  adapter.js          the AgentAdapter contract
  registry.js         runtimes + adapter descriptors (the extension point)
  claude/
    native.js         PTY passthrough + hooks + status line
    headless.js       stream-json child process
  codex/
    native.js         PTY passthrough + hooks (via a CODEX_HOME overlay)
    app-server.js     JSON-RPC over stdio to `codex app-server`
    protocol.js       app-server framing + event translation
    hooks.js          hook payload translation
  mock.js             runtime-neutral fake, for tests
```

### 3a. ClaudeNativeAdapter (`src/adapters/claude/native.js`) — the default for Claude

Multiplayer **around** the real interactive Claude Code UI, never instead of it. Three supported mechanisms:

1. **PTY passthrough** — `collagent create` launches your normal `claude` inside a pseudo-terminal and pipes keys/screen through byte-for-byte. Plan mode, permission prompts, pickers: all native, all answered by the host.
2. **Hooks + status line** (documented Claude Code features) — a `--settings` overlay registers `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop` and `SessionEnd` hooks. Each fires a tiny forwarder (`bin/collagent-hook.js`) that POSTs the payload to a loopback receiver; the adapter translates it into normalized events for remote participants. No output scraping. The same overlay sets a `statusLine` command (`bin/collagent-statusline.js`) so the session code, invite command and live participant presence render at the bottom of the native UI. (If you already use a custom status line, Collagent's takes over for shared sessions only.)
3. **Composer injection** — a remote instruction is typed into Claude Code's own prompt box (bracketed paste + Enter) as `[Bob] …`, visibly. Instructions arriving before `SessionStart` (or while paused) are queued. The `UserPromptSubmit` echo of an injected instruction is deduplicated so remote users don't see it twice.
4. **Transcript mirroring** — hooks report tool activity but never the agent's prose, so the adapter also tails the session transcript (a documented artifact whose path every hook payload carries) and mirrors new assistant text to participants as it lands. Remote users see Claude's replies, not just its tool calls.

What the host types locally is shared too: `UserPromptSubmit` hooks surface it to participants as `⌨ host terminal › …`.

### 3b. ClaudeCodeAdapter (`src/adapters/claude/headless.js`) — headless mode

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

### 3c. Codex — `codex-native` and `codex`

Codex gets the same two shapes, for the same reasons.

**`codex-native`** (`src/adapters/codex/native.js`) is the default when you pick Codex: your real `codex` CLI runs in a PTY with its UI untouched, and Collagent observes it through Codex's own **hook system** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`). Codex reads hook config from `$CODEX_HOME`, so the adapter builds a throwaway home that **symlinks** the real one — auth, config, sessions and plugins keep working exactly as before — and lays its own `hooks.json` on top, merged with any hooks you already had. Remote instructions are typed into Codex's own prompt box as `[Bob] …`, visibly.

> Unlike Claude Code, Codex has no command-backed status line, so room presence can't be drawn inside Codex's UI. Read it from `collagent status` or the web page instead.

**`codex`** (`src/adapters/codex/app-server.js`) drives `codex app-server` over JSON-RPC on stdio, which is the path your diagram describes:

```text
Collagent room → CodexAdapter → Codex app server → Codex thread
```

One long-lived process holds one thread. Instructions become `turn/start` calls; the thread streams items back as notifications that `protocol.js` folds into normalized events. Two details of Codex's wire format that the code has to handle: it **omits the `jsonrpc` field** entirely (a strict JSON-RPC client rejects every frame), and notifications carry an extra `emittedAtMs`. Per-token `item/agentMessage/delta` notifications are deliberately dropped in favour of the completed item — one broadcast event per token would flood every participant's feed — and `reasoning` items are never mirrored into a shared room.

Because this adapter sees every item the thread streams, Codex app-server rooms get the most complete feed. Hook-based rooms carry the agent's replies too: `codex-native` mirrors each turn's final message from the Stop hook's `last_assistant_message`, and `claude-native` tails the session transcript.

### 3d. Cursor — `cursor-native` and `cursor`

Cursor's CLI (`agent`, installed via `curl https://cursor.com/install -fsS | bash`) gets the same two shapes.

**`cursor-native`** runs the real interactive `agent` in a PTY and observes it through Cursor's hook system (`sessionStart`, `beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `afterAgentResponse`, `stop`, `sessionEnd`). Cursor reads hooks from several levels and symlink-checks the config files, so the adapter merges its forwarder into the **workspace's `.cursor/hooks.json`** and restores the original file byte-for-byte on disconnect — user- and enterprise-level hooks keep running untouched. Cursor's hooks are richer than Claude Code's: `afterAgentResponse` carries the agent's prose directly (no transcript tailing) and `stop` reports a real `completed|aborted|error` status. Remote instructions are typed into Cursor's own prompt box as `[Bob] …`, visibly.

**`cursor`** (headless) drives `agent -p --output-format stream-json`. Print mode is one-shot, so each instruction spawns one process; turns share a conversation via `--resume <session_id>`, captured from the first turn's `init` event. Instructions arriving mid-turn queue until the running turn ends. Runs with `--force` by default (pass it off with adapter options) — like every headless room, invitees can drive the host's machine, so choose deliberately.

### 3e. Gemini CLI, OpenCode, Goose

Three more runtimes, same two shapes each.

**Native mode.** `gemini-native` and `goose-native` are hook-observed like the others: Gemini's hooks merge into the workspace's `.gemini/settings.json` (restored byte-for-byte on disconnect; `AfterAgent` carries the turn's reply, `BeforeAgent` dedupes injections), and Goose's live in Collagent's own plugin dir (`<cwd>/.agents/plugins/collagent/`, created on start, removed on disconnect; `Stop` carries `last_assistant_message`). `opencode-native` needs no hooks at all — OpenCode is client/server, so the adapter launches the TUI with a fixed `--port` and works through OpenCode's own API: SSE `/event` for observation (including OpenCode's own session titles) and `/tui/append-prompt` + `/tui/submit-prompt` to type remote instructions visibly into the composer.

**Headless mode.** All three expose an [ACP](https://agentclientprotocol.com) agent (`gemini --acp`, `opencode acp`, `goose acp`), so one shared client (`src/adapters/acp/`) drives them: JSON-RPC over stdio, one `session/prompt` per instruction, streamed `session/update` prose coalesced into whole messages (flushed before interleaving tool calls), resume via `session/load` where the agent supports it. Agent-initiated permission requests are answered by policy: an approve-kind option is auto-selected (the acceptEdits spirit) unless the adapter runs with `autoApprove: false`, which declines them.

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
npm test        # 45 tests, no agent account needed (mock adapter + fake runtimes)
npm run demo    # full end-to-end against REAL Claude Code (needs `claude` installed + logged in)
```

- `test/core.test.js` — sessions, permissions, driver fallback, event log.
- `test/server.test.js` — the full milestone flow over real WebSockets with the mock adapter, plus pause/resume, driver-mode/handoff, reconnect replay, status API.
- `test/claude-adapter.test.js` — stream-json normalization, and the adapter driving `test/fixtures/fake-claude.js`, a stub that speaks Claude Code's exact stream-json protocol.
- `test/codex.test.js` — app-server and hook translation, the registry's capability descriptors, and the adapter driving `test/fixtures/fake-codex-app-server.js`, a stub that reproduces Codex's JSON-RPC quirks (no `jsonrpc` field, `emittedAtMs` on notifications).
- `test/cursor.test.js` — hook translation, the project-level `hooks.json` merge/restore, stream-json normalization, and the adapter driving `test/fixtures/fake-cursor-agent.js`, a stub that speaks Cursor's print-mode protocol (tool calls keyed by `<name>ToolCall`, `--resume` chaining).
- `test/acp.test.js` — the shared ACP client against `test/fixtures/fake-acp-agent.js` (chunk coalescing, permission policy, `session/load` resume, pause queueing).
- `test/gemini.test.js`, `test/opencode.test.js`, `test/goose.test.js` — per-runtime hook/SSE translation, settings- and plugin-dir install/restore, registry descriptors.
- `scripts/e2e-demo.js` — the first-milestone proof: Alice creates → Bob joins → Bob instructs → real Claude Code writes a file → both feeds verified identical → pause/resume/handoff exercised.

## Security notes (MVP-level)

- Invite codes are unguessable-enough for a prototype but the server has no TLS/auth; run it on localhost or a trusted network.
- The agent connection is authenticated with a per-session `agentToken` handed only to the creator.
- Session snapshots never expose tokens.
- The default permission mode is `acceptEdits` — Claude Code can edit files in the session cwd without prompting, but Bash and other risky tools follow the host's normal Claude Code permission config. Choose `--permission-mode` deliberately; every participant you invite can drive the agent on the host's machine.

## Roadmap (not in the MVP)

- Adapters: Lovable, Replit, custom-agent SDK (websocket protocol is already runtime-neutral)
- Interrupt/steer mid-turn, per-participant tool approval, richer roles
- Server persistence across restarts, TLS + auth for public servers
