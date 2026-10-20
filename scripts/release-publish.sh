#!/usr/bin/env bash
# Publishes every @starkeep package whose version npm does not have yet.
#
# Run it on a laptop, after the version pull request (`pnpm changeset version`)
# has merged. It publishes with your own `npm login`, so CI holds no npm
# credentials.
#
# The checks stand in for what a CI runner gives for free, because a laptop is
# where stale state lives:
#   - the checkout is `main`, has no uncommitted or untracked files, and matches
#     `origin/main`, so what gets published is what was reviewed;
#   - no changesets are pending, so a version PR has not been skipped;
#   - every package builds from scratch (turbo's cache bypassed), and format,
#     lint, typecheck and the unit suites pass on that build.
#
# It then shows the publish plan and asks before publishing. `changeset publish`
# publishes in dependency order through `pnpm publish` (which turns
# `workspace:*` into the exact version) and tags each release; this script
# pushes those tags.
#
# Usage: pnpm release:publish

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "release:publish: $*" >&2
  exit 1
}

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || fail "check out main first (on '$branch')."

[[ -z "$(git status --porcelain)" ]] ||
  fail "the working tree has uncommitted or untracked files. Commit, stash or remove them."

git fetch --quiet origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] ||
  fail "local main differs from origin/main. Pull or push until they match."

pending="$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' | wc -l | tr -d ' ')"
[[ "$pending" == "0" ]] ||
  fail "$pending changeset(s) are pending. Run 'pnpm changeset version' in a pull request and merge it first."

npm whoami >/dev/null 2>&1 || fail "not logged in to npm. Run 'npm login' first."

echo "==> Removing every package's dist/"
pnpm -r --parallel exec rm -rf dist

echo "==> Installing"
# The root postinstall builds through turbo, possibly from cache; the forced
# build below is the one that counts.
pnpm install --frozen-lockfile

echo "==> Building from scratch"
pnpm turbo run build --force

echo "==> Checking"
pnpm format:check
pnpm turbo run lint typecheck test --force

echo "==> Publish plan"
pnpm exec changeset publish-plan

read -r -p "Publish the packages above? [y/N] " answer
[[ "$answer" == "y" || "$answer" == "Y" ]] || fail "stopped before publishing."

tags_before="$(git tag --list | sort)"
pnpm exec changeset publish
new_tags="$(comm -13 <(echo "$tags_before") <(git tag --list | sort))"

if [[ -n "$new_tags" ]]; then
  echo "==> Pushing tags"
  # shellcheck disable=SC2086 # one tag per word
  git push origin $new_tags
else
  echo "==> Nothing new was published, so there are no tags to push."
fi
