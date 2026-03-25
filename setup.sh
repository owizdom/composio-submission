#!/bin/bash

set -e

# --- colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }

SETUP_OK=true

echo ""
echo "=== Endpoint Tester Setup ==="
echo ""

# --- check composio api key ---
if [ -z "$COMPOSIO_API_KEY" ]; then
	fail "COMPOSIO_API_KEY is not set"
	echo "  Usage: COMPOSIO_API_KEY=<key> sh setup.sh"
	exit 1
fi
pass "COMPOSIO_API_KEY is set"

# --- check bun ---
if command -v bun >/dev/null 2>&1; then
	pass "Bun is installed ($(bun --version))"
else
	fail "Bun is not installed"
	echo "  Install: curl -fsSL https://bun.sh/install | bash"
	exit 1
fi

# --- check composio cli ---
if command -v composio >/dev/null 2>&1; then
	pass "Composio CLI is installed"
else
	warn "Composio CLI not found — installing..."
	if bun install -g composio-core 2>/dev/null; then
		pass "Composio CLI installed"
	else
		warn "Composio CLI install failed (not required, but useful for debugging)"
	fi
fi

# --- install dependencies ---
echo ""
echo "Installing dependencies..."
bun install
pass "Dependencies installed"

# --- run scaffold.sh (create auth configs) ---
echo ""
echo "Creating auth configs..."
bash scaffold.sh
pass "Auth configs created"

# --- run connect.ts (Google OAuth) ---
echo ""
echo "Connecting Google accounts (OAuth)..."
echo ""
echo "  ⚠  You will see OAuth URLs below — open them in your browser to connect your Google account."
echo ""
bun src/connect.ts
pass "Google accounts connected"

# --- sanity check: test one endpoint ---
echo ""
echo "Running sanity check..."
SANITY_RESULT=$(bun -e "
import { Composio } from '@composio/core';

const composio = new Composio();

try {
  const result = await composio.tools.proxyExecute({
    endpoint: '/gmail/v1/users/me/profile',
    method: 'GET',
    connectedAccountId: 'candidate',
  });
  if (result && result.data) {
    console.log('OK');
  } else {
    console.log('FAIL: ' + JSON.stringify(result?.error || 'unknown'));
  }
} catch (e) {
  console.log('FAIL: ' + e.message);
}
" 2>&1)

if echo "$SANITY_RESULT" | grep -q "^OK"; then
	pass "Sanity check passed — composio.tools.proxyExecute() works"
else
	fail "Sanity check failed: $SANITY_RESULT"
	warn "OAuth may not have completed correctly. Try running: bun src/connect.ts"
	SETUP_OK=false
fi

# --- record start timestamp ---
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .start-timestamp
pass "Start timestamp recorded"

# --- summary ---
echo ""
echo "=== Setup Summary ==="
if [ "$SETUP_OK" = true ]; then
	echo -e "${GREEN}All checks passed. You're ready to go.${NC}"
else
	echo -e "${YELLOW}Some checks had warnings — review above before starting.${NC}"
fi
echo ""
echo "Next steps:"
echo "  1. Open your preferred AI coding agent (Claude Code, Cursor, Codex, etc.)"
echo "  2. Build your endpoint tester agent — see readme.md for requirements"
echo ""
