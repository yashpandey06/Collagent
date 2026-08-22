# CLI Reference

Every command Collagent has today. Run any of them with no arguments to see
usage.

## collagent create

Create a room and launch an agent in this terminal.

```
collagent create --agent claude
```

Options: `--agent <id>` · `--name <you>` · `--server <url>` · `--cwd <dir>` ·
`--model <m>` · `--headless` · `--adapter <type>` · `--permission-mode <m>`
(headless).

## collagent join

Join a room by code. Catch-up first, then live.

```
collagent join A7K2 --name Bob
```

Options: `--name` · `--key <join key>` (remote servers) · `--server <url>`.

## collagent open

Reopen a saved room as host and resume its agent's conversation.

```
collagent open A7K2
```

## collagent add

Add another agent to an existing room (the multi-agent opt-in).

```
collagent add A7K2 --agent codex
```

Options: `--agent` · `--headless` · `--key` · `--server`.

## collagent rooms

List every room — live first, then saved. Works offline from local history.

```
collagent rooms
```

## collagent agents

The supported agent runtimes and which are installed here.

```
collagent agents
```

## collagent status

One room's state, participants and agents, without joining.

```
collagent status A7K2
```

## collagent leave

Leave the last room you joined from this machine.

```
collagent leave
```

## collagent delete

Delete a room and its history (asks for confirmation; bare `delete` opens a
picker).

```
collagent delete A7K2
```

Use `--yes` to skip confirmation in scripts.

## collagent serve

Run a Collagent server (loopback by default; `--host 0.0.0.0` for a team).

```
collagent serve --host 0.0.0.0
```

Options: `--port` · `--host` · `--pg <postgres-url>`.

## collagent dev

Local dev server with sensible defaults, plus the dashboard URL.

```
collagent dev
```
