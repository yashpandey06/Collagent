# Live Sessions

Once you're in a room, the feed shows everything as it happens.

```
● Alice [host, driver]  ● Bob (you)  ● Claude Code [working]

alice › add OAuth callback validation
  ⚙ Edit src/auth/callback.ts
    └ ok
⏺ Claude Code Added state validation to the callback …
✓ turn complete in 9.1s
```

## Send an instruction

Type at the `›` prompt and press Enter. On the host's screen it appears
inside the agent's own prompt box as `[Bob] …` — nothing reaches the agent
invisibly.

## Run agent slash commands

Slash commands Collagent doesn't own are forwarded to the agent:

```
/compact
```

If Collagent owns the name (like `/status`), force it through with a double
slash:

```
//status
```

## Check the room state

```
/status
```

## Who sees what

Everyone sees the same stream: instructions (with author), the agent's
replies, tool calls and results, turn completions with duration and cost
where reported. The agent's private reasoning is never broadcast.
