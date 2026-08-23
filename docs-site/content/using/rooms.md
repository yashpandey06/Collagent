# Rooms

A room is a shared, persistent workspace identified by a 5-character code
like `A7K2`.

## Create a room

```
collagent create --agent claude
```

Omit `--agent` to pick interactively. Use `--cwd` to set the agent's working
directory, `--model` to override the model.

## List your rooms

```
collagent rooms
```

Live rooms (people or agents connected) sort first; saved rooms keep their
history and can be reopened anytime.

## Reopen a saved room

```
collagent open A7K2
```

Re-attaches the agent and **resumes its actual conversation** (each runtime's
own resume mechanism).

## Archive or delete

```
/archive
```

Archives hide the room from listings; joining it again revives it. Deleting
erases history permanently:

```
collagent delete A7K2
```

Rooms only end when someone runs `/end` or deletes them — closing terminals
never kills a room.
