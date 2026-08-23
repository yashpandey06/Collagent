# Installation

## Requirements

- Node.js ≥ 18.17 (≥ 22.5 recommended — enables the SQLite store and the Cursor adapter)
- At least one coding agent installed (only needed to **host** rooms — joining needs none)

## Install

From a clone of the repository:

```
./scripts/setup.sh
```

This installs dependencies and links the `collagent` command onto your PATH.

## Check it

```
collagent agents
```

Lists the six supported agents and which are installed on this machine.

## Install an agent (if you need one)

```
npm install -g @anthropic-ai/claude-code
```

```
npm install -g @openai/codex
```

See each [agent page](../agents/index.md) for the other install commands.
