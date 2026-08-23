# History & Catch Up

Every room keeps its full history. You never scroll-lose work.

## Joining a room with history

Short histories replay in full. Long ones show a digest plus the recent
tail instead of thousands of raw lines:

```
SINCE YOU WERE AWAY

✓ Bob: "use payment_intent_id"
✓ claude-1 completed 3 turns, changed 4 files
✓ handoff: Alice → Bob

— last 12 of 214 events — full history stays in the room —
…
──────── YOU ARE HERE ────────
```

Then live events continue below the marker.

## Reconnecting

If your connection drops, Collagent reconnects automatically and replays only
what you missed — your read position is remembered per room on your machine.

## Seeing earlier activity

The full history is always in the room: reopen it with `collagent join CODE`
any time, view it in the dashboard's room timeline, or check a room's state
without joining:

```
collagent status A7K2
```
