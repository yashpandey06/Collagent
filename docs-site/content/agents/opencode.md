# OpenCode

## Install / prerequisite

```
npm install -g opencode-ai
```

## Create a Collagent session

```
collagent create --agent opencode
```

No hook files, nothing written to your project — Collagent talks to the
OpenCode TUI's own built-in API.

## Join an existing room

```
collagent join A7K2
```

## Resume a saved room

```
collagent open A7K2
```

## What Collagent supports

- live shared session in the real OpenCode TUI (native) or Collagent's feed (headless, via ACP)
- instructions from every participant, attributed
- OpenCode slash commands from any terminal
- pause / resume, handoff, reconnect, full history
- OpenCode's own session titles appear as the room topic

## Known limitations

- Native mode launches the TUI with a fixed `--port` so Collagent can reach
  its API; if something else occupies it, a free port is chosen.
- No token/cost reporting today.
