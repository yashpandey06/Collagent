# Addressing an Agent

Only relevant when a room has more than one agent — single-agent rooms route
everything automatically.

## One-shot address

```
@codex-1 inspect the frontend request payload
```

Sends only to `codex-1` (and makes it your default). The runtime name works
too when it's unambiguous: `@codex …`.

## Set your default

```
/use claude-1
```

Your plain messages now go to `claude-1` until you change it. Typing
`@codex-1` alone does the same for codex-1.

## What happens without a target

```
› fix it
! several agents are here — address one (@claude-1 …) or pick a default (/use claude-1)
```

Explicit is better than a wrong guess.
