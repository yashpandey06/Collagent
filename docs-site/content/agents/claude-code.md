# Claude Code

## Install / prerequisite

```
npm install -g @anthropic-ai/claude-code
```

## Create a Collagent session

```
collagent create --agent claude
```

Your normal Claude Code opens. The room code and who's present show in
Claude's own **status line**.

## Join an existing room

```
collagent join A7K2
```

## Resume a saved room

```
collagent open A7K2
```

Continues the same Claude conversation (`--resume` under the hood).

## What Collagent supports

- live shared session in Claude's real UI (native) or Collagent's feed (headless)
- participant presence in the status line
- instructions from every participant, attributed (`[Bob] …`)
- Claude's own slash commands from any terminal (`/model`, `/compact`, …)
- pause / resume, handoff, reconnect, full history
- token + cost reporting per turn (headless mode)

## Known limitations

- Native mode: trust/permission dialogs are answered by the host only.
- Native mode reports no token/cost data (Claude doesn't expose it there).
- Headless default permission mode is `acceptEdits` — remote participants can
  drive the host machine; override with `--permission-mode`.
