#!/usr/bin/env bash
# Wipes local Starkeep data: object files, the SQLite database, and watches.
# Does NOT touch cloud config, credentials, or other ~/.starkeep files.

set -euo pipefail

STARKEEP_DIR="${STARKEEP_DIR:-$HOME/.starkeep}"
OBJECTS_DIR="$STARKEEP_DIR/objects"
DB_FILE="$STARKEEP_DIR/data.db"
DB_WAL="$STARKEEP_DIR/data.db-wal"
DB_SHM="$STARKEEP_DIR/data.db-shm"
WATCHES_FILE="$STARKEEP_DIR/watches.json"

echo "This will permanently delete:"
echo "  $OBJECTS_DIR  (all object files)"
echo "  $DB_FILE (and WAL/SHM journal files)"
echo "  $WATCHES_FILE"
echo ""
read -r -p "Continue? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

if [[ -d "$OBJECTS_DIR" ]]; then
  rm -rf "$OBJECTS_DIR"
  echo "Deleted $OBJECTS_DIR"
else
  echo "Objects directory not found, skipping: $OBJECTS_DIR"
fi

for f in "$DB_FILE" "$DB_WAL" "$DB_SHM" "$WATCHES_FILE"; do
  if [[ -f "$f" ]]; then
    rm "$f"
    echo "Deleted $f"
  fi
done

echo "Done. Start the data server to reinitialize."
