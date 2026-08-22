# Agent Handoff

Move the room's working focus to a specific agent.

## Terminal

```
/handoff @codex-1
```

## Who can hand off

Host or driver (same rule as human handoff).

## What happens

1. The room's default agent becomes `codex-1` — everyone's plain messages now
   route there unless they've set their own `/use` default.
2. `codex-1` receives a **briefing message**: the room's objective, the last
   few instructions, and which other agents are active.
3. Everyone sees `⇄ Alice handed off to codex-1` in the feed; the handoff is
   saved with its context.

The other agents keep whatever they were doing — handoff moves focus, it
doesn't stop work.
