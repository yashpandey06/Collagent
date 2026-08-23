# Handoff

Pass control of the session to another person (or, in multi-agent rooms,
move focus to an agent — see [Agent Handoff](../multi-agent/agent-handoff.md)).

## Terminal

```
/handoff bob
```

## Who can hand off

The host or the current driver.

## What changes

- Bob becomes the **driver** (matters in driver mode: only the driver/host
  can instruct).
- Everyone sees `⇄ Alice handed off to Bob` with the room's objective.
- The handoff is saved with structured context (objective, recent direction,
  agent states) — it survives in history.

## What doesn't change

The agent keeps running exactly as it was; no context is lost. If Bob is
offline the seat still transfers — he has it when he returns.
