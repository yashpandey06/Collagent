# Add an Agent

A room starts with one agent and stays that way until you say otherwise. Add
another agent only when the work benefits from multiple runtimes.

## From a new terminal (native UI)

```
collagent add A7K2 --agent codex
```

Codex's real UI opens in that terminal, attached to the same room. The new
agent gets a stable id like `codex-1` (the same runtime twice gives
`claude-1`, `claude-2`).

## From inside a feed terminal (headless)

```
/add codex
```

The agent runs headlessly so your feed keeps the terminal.

## From the dashboard

**＋ New room** creates rooms; adding to an existing room shows you the exact
`collagent add` command — agents run on real machines, not in the browser.

## Who can add

The host or the current driver.

## What changes

Nothing, until the second agent attaches — then the room shows an agent
roster and [addressing](addressing.md) becomes available. Single-agent rooms
never see any of it.
