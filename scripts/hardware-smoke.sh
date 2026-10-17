#!/usr/bin/env bash
# Hardware smoke for the @lool-ing/sportident readout bin.
#
# Operator-driven: prompts you to insert each card type (SI5, SI9, SI10, SIAC)
# IN TURN, runs `lool-readout --record <basename> --once` SEPARATELY per
# card type (produces 4 distinct fixture pairs natively, no
# post-hoc splitting), and asserts per-card NDJSON events via `node -e` JSON
# parsing.
#
# Exit 0 = all four cards round-tripped + fixtures landed in
# tests/fixtures/bench/. Exit 1 = any card failed (preflight or assertion).
#
# Preflight:
#   - /dev/ttyUSB0 must exist; if not, `dmesg | grep cp210x` to see why, and
#     `sudo apt-get remove brltty` to remove the brltty conflict.
#   - $USER must be in `dialout` group; if not, `sudo usermod -aG dialout $USER`
#     and log out/in.
#   - Node 26+ (the version .nvmrc and engines require).
#   - pnpm available.
#   - The lool-readout dist bundle must exist (run `pnpm build` if missing).
#
# NEVER edit hard-coded absolute home paths; everything is relative to the
# repo root we run from.

set -Eeuo pipefail

trap 'echo "smoke FAILED at line $LINENO" >&2; exit 1' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FIXTURE_DIR="tests/fixtures/bench"
DIST_BIN="dist/bin/lool-readout.cjs"

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------

echo "=== lool hardware-smoke preflight ==="
echo "repo root: $REPO_ROOT"

# 1a. /dev/ttyUSB0
if [[ ! -e /dev/ttyUSB0 ]]; then
  echo "FAIL: /dev/ttyUSB0 missing" >&2
  echo "  - check 'dmesg | grep cp210x' for the kernel driver bind" >&2
  echo "  - if you see 'brltty' messages, remove it: 'sudo apt-get remove brltty'" >&2
  echo "" >&2
  exit 1
fi
echo "OK: /dev/ttyUSB0 present ($(ls -l /dev/ttyUSB0 | awk '{print $1, $3, $4}'))"

# 1b. dialout-group read/write access
if [[ ! -r /dev/ttyUSB0 || ! -w /dev/ttyUSB0 ]]; then
  echo "FAIL: $USER cannot read/write /dev/ttyUSB0" >&2
  echo "  - add yourself to the 'dialout' group: 'sudo usermod -aG dialout $USER'" >&2
  echo "  - then log out and log back in for the group to take effect" >&2
  echo "" >&2
  exit 1
fi
echo "OK: /dev/ttyUSB0 readable+writable"

# 1c. Node version (>= 26, as .nvmrc and engines require)
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed -E 's/^v([0-9]+)\..*/\1/')"
if [[ "$NODE_MAJOR" -lt 26 ]]; then
  echo "FAIL: Node $NODE_VERSION < 26" >&2
  exit 1
fi
echo "OK: Node $NODE_VERSION"

# 1d. pnpm available
if ! command -v pnpm >/dev/null 2>&1; then
  echo "FAIL: pnpm not on PATH" >&2
  echo "  - install via 'corepack enable && corepack prepare pnpm@latest --activate'" >&2
  exit 1
fi
echo "OK: pnpm $(pnpm --version)"

# 1e. dist bin built
if [[ ! -f "$DIST_BIN" ]]; then
  echo "Building dist bundle (missing $DIST_BIN)..."
  pnpm exec tsup --silent
fi
test -f "$DIST_BIN"
echo "OK: $DIST_BIN exists"

mkdir -p "$FIXTURE_DIR"

# ---------------------------------------------------------------------------
# 2. Per-card capture loop (--record --once per card type).
#
# Card types covered (must match the bench inventory):
#   - SI5   : legacy single-page GET_SI5 readout, cardNumber 1k..500k
#   - SI9   : modern card via SI8_DET, cardNumber range 1M..2M
#   - SI10  : modern card via SI8_DET, cardNumber range 7M..8M
#   - SIAC  : modern card via SI8_DET, cardNumber range 8M..9M (touch-free)
# ---------------------------------------------------------------------------

FAIL=0
for card_type in si5 si9 si10 siac; do
  BASENAME="${FIXTURE_DIR}/${card_type}-bench-001"
  CARD_LABEL="$(echo "$card_type" | tr 'a-z' 'A-Z')"
  echo
  echo "=== ${CARD_LABEL} capture ==="
  echo "Insert the ${CARD_LABEL} card into the BSM7/8 reader."
  echo "Press Enter to start the --record --once capture (Ctrl-C to abort)."
  read -r

  # --once causes lool-readout to exit cleanly after a single cardRead.
  # --record writes the directional transcript + expected.json fixture pair.
  # --include-raw-pages threads the flag through; Phase 0 currently omits the
  # raw_pages_b64 field but the flag is in place for forward compatibility.
  if ! node "$DIST_BIN" \
        --record "$BASENAME" --once --include-raw-pages \
        2> "${BASENAME}.stderr.log"; then
    echo "FAIL: ${CARD_LABEL} bin exited non-zero" >&2
    tail -20 "${BASENAME}.stderr.log" >&2
    FAIL=1
    continue
  fi

  # JSON-parsed NDJSON assertion.
  if ! node -e "
    const fs = require('node:fs');
    const lines = fs
      .readFileSync('${BASENAME}.expected.json', 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    const events = lines.map((l) => JSON.parse(l));
    const ci = events.find((e) => e.event === 'card_inserted');
    const cr = events.find((e) => e.event === 'card_read');
    if (!ci || ci.card_type !== '${CARD_LABEL}') {
      console.error('FAIL: expected card_inserted with card_type=${CARD_LABEL}, got', ci);
      process.exit(1);
    }
    if (!cr || cr.card_type !== '${CARD_LABEL}') {
      console.error('FAIL: expected card_read with card_type=${CARD_LABEL}, got', cr);
      process.exit(1);
    }
    console.log('  -> Detected ${CARD_LABEL} card_number=' + cr.card_number +
                ' (' + (cr.punches ? cr.punches.length : 0) + ' punches). ' +
                'Verify against printed label.');
  "; then
    echo "FAIL: ${CARD_LABEL} NDJSON assertion failed" >&2
    tail -20 "${BASENAME}.stderr.log" >&2
    FAIL=1
    continue
  fi

  echo "Remove the ${CARD_LABEL} card. Press Enter when ready for the next card."
  read -r
done

if [[ "$FAIL" -ne 0 ]]; then
  echo
  echo "smoke FAILED — at least one card did not round-trip cleanly" >&2
  exit 1
fi

echo
echo "Smoke passed: 4 cards round-tripped. Fixtures in ${FIXTURE_DIR}/."
echo "Next step:"
echo "  git add ${FIXTURE_DIR} && git commit -m \"test(00-06): capture bench hardware fixtures\""
echo "  git tag -s v0.0.1-handshake -m \"Phase 0 hardware-proof complete\""
exit 0
