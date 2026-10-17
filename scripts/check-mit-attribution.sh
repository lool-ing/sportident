#!/usr/bin/env bash
# Enforce that every .ts file under src/** and tests/fixtures/upstream/**
# carries a header: the MIT NOTICE ('Ported from allestuetsmerweh/sportident.js')
# or the lool authored header.
# This script is wired into `pnpm lint` so CI catches missing headers.
set -euo pipefail

MISSING=()
SCANNED=0
while IFS= read -r f; do
  SCANNED=$((SCANNED + 1))
  # Accept any of: "Ported from", "Ported (qualifier) from", "Derived from",
  # "Test data from" — every form anchors on `from allestuetsmerweh/sportident.js`
  # which is the canonical upstream URL. A file that carries the lool
  # header has no upstream content and needs no notice.
  if ! head -10 "$f" | grep -qE '(Ported|Derived|Test data)( \([^)]+\))? from allestuetsmerweh/sportident\.js|^// Authored for lool\. Not ported from upstream\.$'; then
    MISSING+=("$f")
  fi
done < <(find src tests/fixtures/upstream -type f -name '*.ts' 2>/dev/null | sort)

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "MIT attribution missing in ${#MISSING[@]} file(s):" >&2
  printf '  - %s\n' "${MISSING[@]}" >&2
  exit 1
fi

# Repo-wide: the lool header is the only accepted "authored" header.
OTHER_HEADERS="$(git grep -n -E '^\s*(//|#|--|<!--)?\s*Authored for ' -- ':!*.md' | grep -v 'Authored for lool\. Not ported from upstream\.' || true)"
if [[ -n "$OTHER_HEADERS" ]]; then
  echo "Use the header '// Authored for lool. Not ported from upstream.':" >&2
  echo "$OTHER_HEADERS" >&2
  exit 1
fi

echo "MIT attribution: OK ($SCANNED files scanned)"
exit 0
