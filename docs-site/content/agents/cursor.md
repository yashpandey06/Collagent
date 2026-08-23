# Cursor

## Install / prerequisite

```
curl https://cursor.com/install -fsS | bash
```

Native mode needs Node ≥ 22.5 on the host (Collagent reads Cursor's chat
store with `node:sqlite`).

## Create a Collagent session

```
collagent create --agent cursor
```

## Join an existing room

```
collagent join A7K2
```

## Resume a saved room

```
collagent open A7K2
```

Re-attaches to the same Cursor chat (`--resume` under the hood).

## What Collagent supports

- live shared session in the real `agent` TUI (native) or Collagent's feed (headless print mode)
- instructions from every participant, attributed
- pause / resume, handoff, reconnect, full history

## Known limitations

- Current Cursor CLI builds ship hook support but don't execute it, so
  Collagent observes by tailing Cursor's own chat store — replies appear with
  a short (≈0.7s) polling delay.
- Headless mode runs one process per instruction and uses `--force` by
  default.
- No token/cost reporting from Cursor's wire formats today.
