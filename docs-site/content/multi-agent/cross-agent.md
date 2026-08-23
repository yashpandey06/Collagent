# Cross-Agent Collaboration

Agents don't talk to each other directly — humans relay what matters. That's
deliberate: each agent stays reliable in its own context, and people stay in
control of what crosses over.

## A real workflow

```
› @claude-1 investigate the payment failure in the backend
⏺ claude-1 The backend expects payment_intent_id, not transaction_id.

› @codex-1 the backend expects payment_intent_id — update the frontend request
⏺ codex-1 Updated checkout.ts to send payment_intent_id.

› @claude-1 frontend now sends payment_intent_id — run the integration tests
✓ claude-1 turn complete · 34.1s
```

Claude's finding became a room event; you passed the decision to Codex in one
line; both kept their own context throughout.

## Tips

- Split by territory (backend / frontend / tests) rather than interleaving
  two agents in the same files.
- `/agents` any time you lose track of who's doing what.
- Use [/handoff @agent](agent-handoff.md) when one agent should carry the
  room's focus for a while.
