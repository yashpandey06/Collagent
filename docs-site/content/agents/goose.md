# Goose

## Install / prerequisite

```
curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash
```

## Create a Collagent session

```
collagent create --agent goose
```

Collagent installs its hooks as a plugin dir (`.agents/plugins/collagent/` in
the project) and removes it when the session ends; your other plugins are
untouched.

## Join an existing room

```
collagent join A7K2
```

## Resume a saved room

```
collagent open A7K2
```

## What Collagent supports

- live shared session in the real `goose session` (native) or Collagent's feed (headless, via ACP)
- instructions from every participant, attributed
- pause / resume, handoff, reconnect, full history

## Known limitations

- The turn's reply arrives on Goose's Stop hook (end of turn).
- No token/cost reporting today.
