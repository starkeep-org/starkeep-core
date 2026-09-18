#!/usr/bin/env bash
# Back up one app's node-local data, then restore the backup and count what
# came back.
#
# Written for the rendition-ownership phase 1 work, whose new operations
# (`retainData` and node-local removal) both delete app data on purpose and are
# both one inverted condition away from deleting the wrong thing. Memo's decks
# are the one body of app-specific data in the system nothing can regenerate,
# so they get a backup before any of that runs against them.
#
# The backup lands OUTSIDE $STARKEEP_DIR by default. Every operation phase 1
# adds deletes inside it, and a backup in ~/.starkeep/backups sits in the blast
# radius.
#
# Two artifacts cover an app completely:
#   - a SQL dump of its `<app>_syncable_*` tables from the node's SQLite file
#   - its object-storage subtree at $STARKEEP_DIR/objects/apps/<appId>
#
# The cloud's copy of the same tables lives in DSQL, not SQLite, and is not
# covered here — dumping it needs a Cognito session and the DSQL endpoint. Take
# it separately before a cloud uninstall.
#
# Usage:
#   scripts/backup-app-data.sh memo
#   scripts/backup-app-data.sh memo /path/to/backup/dir

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/load-env.sh"

APP_ID="${1:-}"
if [[ -z "$APP_ID" ]]; then
  echo "Usage: $(basename "$0") <appId> [destination-dir]" >&2
  exit 1
fi

STARKEEP_DIR="${STARKEEP_DIR:-$HOME/.starkeep}"
DB_FILE="$STARKEEP_DIR/data.db"
BLOB_DIR="$STARKEEP_DIR/objects/apps/$APP_ID"

# `<appId>` reaches SQLite table names with hyphens turned into underscores,
# the way the installer names them.
TABLE_PREFIX="${APP_ID//-/_}_syncable_"

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${2:-$HOME/starkeep-backups/$APP_ID-$STAMP}"

case "$DEST" in
  "$STARKEEP_DIR"|"$STARKEEP_DIR"/*)
    echo "Refusing to write the backup inside $STARKEEP_DIR." >&2
    echo "Everything this backup protects against deletes inside that directory." >&2
    exit 1
    ;;
esac

if [[ ! -f "$DB_FILE" ]]; then
  echo "No database at $DB_FILE." >&2
  exit 1
fi

mkdir -p "$DEST"
DUMP="$DEST/$APP_ID-syncable.sql"

TABLES="$(sqlite3 "$DB_FILE" \
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '${TABLE_PREFIX}%' ORDER BY name;")"

if [[ -z "$TABLES" ]]; then
  echo "No tables named ${TABLE_PREFIX}* in $DB_FILE — is $APP_ID installed on this node?" >&2
  exit 1
fi

echo "Backing up $APP_ID from $STARKEEP_DIR"
echo "  destination: $DEST"
echo ""
echo "Tables:"
while read -r t; do
  printf '  %-56s %s rows\n' "$t" "$(sqlite3 "$DB_FILE" "SELECT count(*) FROM \"$t\";")"
done <<< "$TABLES"

# One `.dump` per table. `.dump <pattern>` takes a LIKE pattern, but naming
# each table is what makes the dump's contents match the list printed above.
{
  echo "PRAGMA foreign_keys=OFF;"
  echo "BEGIN TRANSACTION;"
  while read -r t; do
    sqlite3 "$DB_FILE" ".dump $t" | grep -v -E '^(PRAGMA foreign_keys|BEGIN TRANSACTION|COMMIT);$'
  done <<< "$TABLES"
  echo "COMMIT;"
} > "$DUMP"

if [[ -d "$BLOB_DIR" ]]; then
  cp -R "$BLOB_DIR" "$DEST/objects-apps-$APP_ID"
  echo ""
  echo "Blobs: $(du -sh "$DEST/objects-apps-$APP_ID" | cut -f1) copied from $BLOB_DIR"
else
  echo ""
  echo "Blobs: none at $BLOB_DIR"
fi

# Restore into a scratch database and count what came back. A backup nobody has
# restored is a claim rather than a backup, and the counts below are the claim
# being checked.
echo ""
echo "Restoring the dump into a scratch database to verify it…"
SCRATCH="$DEST/.verify.db"
rm -f "$SCRATCH"
sqlite3 "$SCRATCH" < "$DUMP"

FAILED=0
while read -r t; do
  want="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM \"$t\";")"
  got="$(sqlite3 "$SCRATCH" "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo "MISSING")"
  if [[ "$want" == "$got" ]]; then
    printf '  %-56s %s rows ✓\n' "$t" "$got"
  else
    printf '  %-56s expected %s, restored %s ✗\n' "$t" "$want" "$got"
    FAILED=1
  fi
done <<< "$TABLES"
rm -f "$SCRATCH"

echo ""
if [[ "$FAILED" -ne 0 ]]; then
  echo "The restored copy does not match the live one. Do not rely on this backup." >&2
  exit 1
fi
echo "Backup verified: $DEST"
