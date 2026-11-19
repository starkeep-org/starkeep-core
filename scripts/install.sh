#!/bin/sh
# Install Starkeep on this computer:
#
#   curl -fsSL https://starkeep.app/install.sh | sh
#   curl -fsSL https://starkeep.app/install.sh | sh -s -- --dir ~/src/starkeep
#
# The script clones starkeep-core into ~/.starkeep/platform (or --dir), or
# pulls there when a checkout already exists, so a second run repairs or
# updates the first. Then it runs `starkeep setup` in the checkout with every
# other argument passed through. Setup checks Node and pnpm, installs the
# workspace and starts the local services.
#
# Under `curl | sh`, standard input is the download, so setup reads its
# answers from the terminal (/dev/tty). Without a terminal, setup needs --yes.
#
# Options the script reads itself:
#   --dir <path>    Where the checkout lives (default ~/.starkeep/platform).
#   --repo <url>    The repository to clone (default starkeep-core on GitHub).

set -eu

DIR="${HOME}/.starkeep/platform"
REPO="https://github.com/starkeep-org/starkeep-core.git"

fail() {
  printf '\n%s\n\n' "$1" >&2
  exit 1
}

# Split our own options from the ones setup receives, keeping their order.
SETUP_ARGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || fail "--dir needs a folder."
      DIR="$2"
      shift 2
      ;;
    --repo)
      [ $# -ge 2 ] || fail "--repo needs a repository URL."
      REPO="$2"
      shift 2
      ;;
    *)
      # Quote each argument for the `eval set --` below.
      quoted=$(printf '%s\n' "$1" | sed "s/'/'\\\\''/g")
      SETUP_ARGS="$SETUP_ARGS '$quoted'"
      shift
      ;;
  esac
done
eval "set -- $SETUP_ARGS"

command -v git >/dev/null 2>&1 ||
  fail "Starkeep needs git. Install it (on macOS: xcode-select --install), then run this again."
command -v node >/dev/null 2>&1 ||
  fail "Starkeep needs Node 24 or later. Install it (for example with nvm: nvm install 24), then run this again."

if [ -d "$DIR/.git" ]; then
  printf 'Updating the Starkeep checkout in %s…\n' "$DIR"
  git -C "$DIR" pull --ff-only ||
    fail "Could not update $DIR with git pull --ff-only. Commit or stash your changes there, then run this again."
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  fail "$DIR exists and is not a Starkeep checkout. Move it away, or pick another folder with --dir."
else
  printf 'Cloning Starkeep into %s…\n' "$DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO" "$DIR" || fail "Could not clone $REPO."
fi

cd "$DIR"
if (exec </dev/tty) 2>/dev/null; then
  exec node scripts/starkeep.mjs setup "$@" </dev/tty
else
  exec node scripts/starkeep.mjs setup "$@"
fi
