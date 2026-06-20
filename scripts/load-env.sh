#!/usr/bin/env bash
# Load STARKEEP_DIR (and any other vars) from the repo-root .env / .env.local so
# the shell scripts honor the same dotfile the TS consumers do (see
# packages/app-client/src/load-env.ts). Meant to be *sourced*, not executed:
#
#   source "$(dirname "$0")/load-env.sh"   # near the top of a script
#
# Precedence (highest wins): an already-exported value > .env.local > .env. We
# only set a var when it is currently unset, so an explicit `STARKEEP_DIR=... cmd`
# (or a test harness export) always takes priority, matching the TS loader.

# Directory to read the dotfiles from: STARKEEP_ENV_DIR override (used by tests),
# else the repo root (this file lives in <root>/scripts).
_starkeep_env_root() {
  if [[ -n "${STARKEEP_ENV_DIR:-}" ]]; then
    printf '%s\n' "$STARKEEP_ENV_DIR"
    return
  fi
  # BASH_SOURCE[0] is this file even when sourced.
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

# Parse a dotfile, exporting KEY=VALUE pairs that are not already set. Handles
# optional `export ` prefix, surrounding single/double quotes, blank lines and
# `#` comments. Intentionally simple — these are developer-owned dotfiles.
_starkeep_load_dotfile() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"   # ltrim
    [[ -z "$line" || "$line" == \#* ]] && continue
    line="${line#export }"
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"       # rtrim key
    # strip matching surrounding quotes
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    # only set when currently unset/empty (an exported value wins)
    if [[ -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done <"$file"
}

_starkeep_load_env() {
  local root
  root="$(_starkeep_env_root)"
  # .env.local first so it claims keys ahead of .env.
  _starkeep_load_dotfile "$root/.env.local"
  _starkeep_load_dotfile "$root/.env"
}

_starkeep_load_env
