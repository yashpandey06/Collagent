# Gemini CLI

## Install / prerequisite

```
npm install -g @google/gemini-cli
```

## Create a Collagent session

```
collagent create --agent gemini
```

Collagent merges its hooks into the project's `.gemini/settings.json` and
restores the file byte-for-byte when the session ends.

## Join an existing room

```
collagent join A7K2
```

## Resume a saved room

```
collagent open A7K2
```

## What Collagent supports

- live shared session in the real Gemini CLI (native) or Collagent's feed (headless, via ACP)
- instructions from every participant, attributed
- Gemini slash commands from any terminal
- pause / resume, handoff, reconnect, full history

## Known limitations

- The turn's reply arrives via Gemini's `AfterAgent` hook — long turns show
  tool activity first, prose at the end.
- No token/cost reporting today.
