#!/usr/bin/env bash
# Waits until npm shows every given package version.
#
# npm can take several minutes to show a version after its upload, in no fixed
# order, so an install right after a publish may fail. `release:publish` runs
# this after `changeset publish`, and the release is complete when it returns.
#
# Usage: scripts/wait-for-npm.sh <name@version>...
#
# STARKEEP_NPM_WAIT_TIMEOUT_S (default 600) and STARKEEP_NPM_WAIT_INTERVAL_S
# (default 15) set how long to wait in total and between checks.

set -euo pipefail

timeout_s="${STARKEEP_NPM_WAIT_TIMEOUT_S:-600}"
interval_s="${STARKEEP_NPM_WAIT_INTERVAL_S:-15}"

(($# > 0)) || {
  echo "usage: wait-for-npm.sh <name@version>..." >&2
  exit 2
}

# `npm view` answers a version it does not have yet with nothing, and a package
# it does not have yet with an error. Either way the version is still missing.
# --prefer-online skips npm's local metadata cache.
shows() {
  local spec="$1"
  [[ "$(npm view "$spec" version --prefer-online 2>/dev/null || true)" == "${spec##*@}" ]]
}

missing=("$@")
deadline=$(($(date +%s) + timeout_s))
while :; do
  still=()
  for spec in "${missing[@]}"; do
    shows "$spec" || still+=("$spec")
  done
  if ((${#still[@]} == 0)); then
    echo "npm shows all $# version(s)."
    exit 0
  fi
  missing=("${still[@]}")
  if (($(date +%s) >= deadline)); then
    echo "npm still does not show these after ${timeout_s}s:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    echo "They may still appear. Check later with 'npm view <name@version> version'." >&2
    exit 1
  fi
  echo "Waiting for npm to show ${#missing[@]} of $# version(s): ${missing[*]}"
  sleep "$interval_s"
done
