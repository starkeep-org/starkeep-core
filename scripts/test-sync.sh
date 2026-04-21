#!/usr/bin/env bash
# Two-node sync smoke test. Assumes:
#   - cloud-server on :9920
#   - data-server A on :9820
#   - data-server B on :9821
# All three are healthy before running.

set -euo pipefail

A=http://127.0.0.1:9820
B=http://127.0.0.1:9821
CLOUD=http://127.0.0.1:9920

hr() { printf '\n\033[36m=== %s ===\033[0m\n' "$*"; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

hr "health checks"
curl -fsS $CLOUD/health >/dev/null && pass "cloud up"
curl -fsS $A/health      >/dev/null && pass "A up"
curl -fsS $B/health      >/dev/null && pass "B up"

hr "1. create on A, pull on B"
CREATE=$(curl -fsS -X POST $A/data/records \
  -H 'Content-Type: application/json' \
  -d '{"type":"@test/note","payload":{"title":"hello from A","body":"v1"}}')
RECORD_ID=$(echo "$CREATE" | jq -r '.record.id')
echo "  created id=$RECORD_ID on A"

curl -fsS -X POST $A/sync/now >/dev/null
pass "A sync/now"
curl -fsS -X POST $B/sync/now >/dev/null
pass "B sync/now"

BODY_ON_B=$(curl -fsS "$B/data/records/$RECORD_ID" | jq -r '.record.payload.body')
[[ "$BODY_ON_B" == "v1" ]] && pass "B sees record from A (body=v1)" \
  || fail "B does not see A's record (got '$BODY_ON_B')"

hr "2. create on B, pull on A (reverse direction)"
CREATE_B=$(curl -fsS -X POST $B/data/records \
  -H 'Content-Type: application/json' \
  -d '{"type":"@test/note","payload":{"title":"hello from B","body":"b1"}}')
RECORD_B_ID=$(echo "$CREATE_B" | jq -r '.record.id')
echo "  created id=$RECORD_B_ID on B"

curl -fsS -X POST $B/sync/now >/dev/null
curl -fsS -X POST $A/sync/now >/dev/null

BODY_ON_A=$(curl -fsS "$A/data/records/$RECORD_B_ID" | jq -r '.record.payload.body')
[[ "$BODY_ON_A" == "b1" ]] && pass "A sees record from B (body=b1)" \
  || fail "A does not see B's record"

hr "3. sync status"
echo "  A status:"
curl -fsS $A/sync/status | jq .
echo "  B status:"
curl -fsS $B/sync/status | jq .

hr "4. conflict counts (should be 0 — two disjoint creates)"
AC=$(curl -fsS $A/sync/conflicts | jq '.conflicts | length')
BC=$(curl -fsS $B/sync/conflicts | jq '.conflicts | length')
[[ "$AC" == "0" && "$BC" == "0" ]] && pass "no conflicts" \
  || fail "unexpected conflicts A=$AC B=$BC"

hr "5. HLC persistence across restart (optional, manual)"
echo "  Check sync cursors are persisted in SQLite:"
echo "    sqlite3 $HOME/.starkeep-a/data.db 'SELECT key, value_json FROM sync_state;'"
echo "    sqlite3 $HOME/.starkeep-b/data.db 'SELECT key, value_json FROM sync_state;'"

hr "DONE — basic bidirectional sync works"
echo
echo "This script does NOT yet exercise OCC rejection, because the data-server"
echo "does not expose an update endpoint. To test OCC you need writes to the"
echo "SAME record from both nodes. Options:"
echo "  a) Add POST /data/records/:id to data-server that calls sdk.data.update()."
echo "  b) Use two file watches on the same file path across both nodes and"
echo "     modify it concurrently (watcher generates new versions)."
echo "  c) Write a direct SDK-level test in packages/sync-engine/__tests__/"
echo "     that spins up two SyncEngines against the same in-process cloud."
