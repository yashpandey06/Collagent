#!/usr/bin/env bash
# Collagent local setup
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ checking prerequisites"
if ! command -v node >/dev/null; then
  echo "✗ node not found — install Node.js >= 18.17" >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js >= 18.17 required (found $(node --version))" >&2
  exit 1
fi
echo "  ✓ node $(node --version)"

if command -v claude >/dev/null; then
  echo "  ✓ claude $(claude --version 2>/dev/null | head -1)"
else
  echo "  ! claude CLI not found — the ClaudeCodeAdapter needs it."
  echo "    Install: https://claude.com/claude-code (tests still run via the mock adapter)"
fi

echo "▸ installing dependencies"
npm install --no-audit --no-fund

chmod +x bin/collagent.js bin/collagent-hook.js test/fixtures/fake-claude.js scripts/e2e-demo.js

# node-pty ships prebuilt binaries whose exec bit npm sometimes strips;
# without this, PTY spawn fails with "posix_spawnp failed".
if ls node_modules/node-pty/prebuilds/*/spawn-helper >/dev/null 2>&1; then
  chmod +x node_modules/node-pty/prebuilds/*/spawn-helper
  xattr -d com.apple.quarantine node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
fi

echo "▸ linking the collagent command (npm link)"
if npm link >/dev/null 2>&1; then
  echo "  ✓ 'collagent' is now on your PATH"
else
  echo "  ! npm link failed (permissions?) — use: node $(pwd)/bin/collagent.js"
fi

echo ""
echo "Done. Try it:"
echo "  collagent create                 # terminal 1 (Alice)"
echo "  collagent join <CODE>            # terminal 2 (Bob)"
echo "  npm test                         # unit + integration tests"
echo "  npm run demo                     # scripted end-to-end with real Claude Code"
