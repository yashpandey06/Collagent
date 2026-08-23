# First Room

A short tour of what you can do once you're in a room.

## See who's here

```
/participants
```

## Watch the agent work

Everything streams automatically — instructions, tool calls, results:

```
bob › fix the failing login test
  ⚙ Bash npm test -- login
    └ 1 failed: expects 401 on bad password
⏺ Claude Code The test expected the old error shape …
✓ turn complete in 12.3s ($0.02)
```

## Run the agent's own commands

Any slash command that isn't a Collagent room command goes to the agent
itself, from anyone's terminal:

```
/model
```

## Pause, hand off, finish

```
/pause
```

```
/handoff bob
```

```
/end
```

`/end` closes the room for everyone (host only). Just closing your terminal
does **not** end the room — it stays saved, and `collagent open A7K2`
picks it back up with the agent's conversation resumed.
