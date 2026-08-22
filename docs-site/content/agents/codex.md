# Codex

## Install / prerequisite

```
npm install -g @openai/codex
```

## Create a Collagent session

```
collagent create --agent codex
```

Your normal Codex TUI opens. Your Codex auth, config and sessions are used
as-is (Collagent overlays only its hooks, in a throwaway home).

## Join an existing room

```
collagent join A7K2
```

## Resume a saved room

```
collagent open A7K2
```

Runs `codex resume <session>` under the hood.

## What Collagent supports

- live shared session in the real Codex TUI (native) or Collagent's feed (headless, via `codex app-server`)
- instructions from every participant, attributed
- Codex slash commands from any terminal (`/model`, …)
- pause / resume, handoff, reconnect, full history
- token counts per turn (headless mode, where Codex reports them)

## Known limitations

- Codex has no command-driven status line, so presence can't render inside
  its UI — use `collagent rooms` or the dashboard.
- Headless mode sets `approvalPolicy: never` (remote participants can't
  answer approval prompts).
- Codex's first hook run may sit behind its trust prompt; queued instructions
  release after a startup window either way.
