#!/usr/bin/env bash
# Wipes local Starkeep data: object files and the SQLite database.
# Does NOT touch cloud config, credentials, or other ~/.starkeep files.

set -euo pipefail

STARKEEP_DIR="${STARKEEP_DIR:-$HOME/.starkeep}"
OBJECTS_DIR="$STARKEEP_DIR/objects"
DB_FILE="$STARKEEP_DIR/data.db"

echo "This will permanently delete:"
echo "  $OBJECTS_DIR  (all object files)"
echo "  $DB_FILE"
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

if [[ -f "$DB_FILE" ]]; then
  rm "$DB_FILE"
  echo "Deleted $DB_FILE"
else
  echo "Database file not found, skipping: $DB_FILE"
fi

echo "Done. Start the data server to reinitialize."
