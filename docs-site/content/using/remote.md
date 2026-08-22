# Remote / Network Usage

By default everything runs on your machine. To collaborate across machines,
run the server somewhere everyone can reach.

```
Alice CLI ───┐
Bob CLI ─────┼──→ Collagent Server (ws://host:7717)
Agent Host ──┘
```

## Run a shared server

On the shared machine:

```
collagent serve --host 0.0.0.0
```

## Create a room against it

```
collagent create --server ws://192.168.1.20:7717
```

The invite line now includes the room's **join key**:

```
Invite your team   collagent join A7K2 --key f3a9c1e0d2 --server ws://192.168.1.20:7717
```

## Join from another machine

```
collagent join A7K2 --key f3a9c1e0d2 --server ws://192.168.1.20:7717
```

First contact with a remote server registers you automatically and stores
your access token in `~/.collagent/credentials.json` — you won't be asked
again.

## Good to know

- The **room code** finds the room; the **join key** authorizes you. Local
  (same-machine) usage needs no key.
- Set the server once with `export COLLAGENT_SERVER=ws://host:7717` instead
  of repeating `--server`.
- If the connection drops, the CLI reconnects and replays what you missed —
  see [History & Catch Up](history-catchup.md).
- The agent always runs on the machine of the person who created/opened the
  room — the server only coordinates.
- Deploying a permanent team server (Docker + Postgres) is covered in the
  repository's `docker-compose.yml` and `.env.example`.
