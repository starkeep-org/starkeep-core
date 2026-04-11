#!/usr/bin/env bash
# Checks that browser-consumed packages contain no Node.js-only APIs.
# Run manually or automatically via predev/prebuild in apps/tasks-desktop.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BROWSER_PACKAGES=(
  "packages/sdk/src"
  "packages/access-control/src"
  "packages/metadata-engine/src"
  "packages/shared-space-api/src"
  "packages/storage-adapter/src"
  "packages/core/src"
  "apps/tasks-packages/tasks-lib/src"
  "apps/tasks-packages/tasks-ui/src"
)

PATTERNS=(
  "from 'node:"
  'from "node:'
  "from 'crypto'"
  'from "crypto"'
  "instanceof Buffer"
  "Buffer\.from"
  "Buffer\.alloc"
  ": Buffer[^a-zA-Z]"
)

FAILED=0
for rel in "${BROWSER_PACKAGES[@]}"; do
  dir="$REPO_ROOT/$rel"
  for pattern in "${PATTERNS[@]}"; do
    hits=$(grep -rn --include="*.ts" "$pattern" "$dir" 2>/dev/null || true)
    if [ -n "$hits" ]; then
      echo "❌  Browser-compat violation ($pattern) in $rel:"
      echo "$hits"
      FAILED=1
    fi
  done
done

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "Fix the above before running the dev server."
  exit 1
fi

echo "✅  No browser-compat violations found."
