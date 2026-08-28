#!/usr/bin/env bash
# Send an app-HMAC-signed request to the local data server.
#
# Every route on the local data server except the loopback-authorized ones
# (/health, /config, /auth, /admin, /watches, /events, /residency/*) requires
# X-Starkeep-App-Id, X-Starkeep-App-Sig and X-Starkeep-App-Ts. This signs as an
# installed app so those routes can be driven by hand — /sync/reship,
# /sync/verify, /sync/exchange and the /data plane.
#
# Usage:
#   scripts/lds-request.sh POST /sync/reship
#   scripts/lds-request.sh GET  /data/records?type=image/jpeg
#   scripts/lds-request.sh POST /data/records '{"type":"image/jpeg",…}'
#   STARKEEP_APP=photos scripts/lds-request.sh GET /data/types
#
# The signature covers `${appId}:${METHOD}:${path}:${ts}:` as UTF-8 bytes
# followed by the raw body bytes, matching signRequest in
# packages/app-client/src/sign.ts and validateAppHmac in
# apps/local-data-server/server.ts. The path signed is the pathname alone, with
# any query string stripped.
set -euo pipefail

METHOD="${1:?usage: lds-request.sh METHOD PATH [BODY]}"
RAW_PATH="${2:?usage: lds-request.sh METHOD PATH [BODY]}"
BODY="${3-}"

APP="${STARKEEP_APP:-starkeep-drive}"
PORT="${STARKEEP_PORT:-9820}"
CREDS="${HOME}/.starkeep/app-creds/${APP}.json"

if [[ ! -f "$CREDS" ]]; then
  echo "no credentials for app '${APP}' at ${CREDS}" >&2
  exit 1
fi

SECRET="$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["hmacSecret"])' "$CREDS")"
TS="$(python -c 'import time; print(int(time.time()*1000))')"

# A GET or HEAD is signed over an empty body regardless of what was passed,
# because the server reads no body for those methods.
UPPER="$(printf '%s' "$METHOD" | tr '[:lower:]' '[:upper:]')"
if [[ "$UPPER" == "GET" || "$UPPER" == "HEAD" ]]; then BODY=""; fi

SIG="$(
  APP="$APP" UPPER="$UPPER" RAW_PATH="$RAW_PATH" TS="$TS" BODY="$BODY" SECRET="$SECRET" \
  python - <<'PY'
import hashlib, hmac, os, urllib.parse

path = os.environ["RAW_PATH"].split("?", 1)[0]
path = urllib.parse.unquote(path)
prefix = f'{os.environ["APP"]}:{os.environ["UPPER"]}:{path}:{os.environ["TS"]}:'
message = prefix.encode() + os.environ["BODY"].encode()
print(hmac.new(os.environ["SECRET"].encode(), message, hashlib.sha256).hexdigest())
PY
)"

curl -sS -X "$UPPER" "http://127.0.0.1:${PORT}${RAW_PATH}" \
  -H "X-Starkeep-App-Id: ${APP}" \
  -H "X-Starkeep-App-Sig: ${SIG}" \
  -H "X-Starkeep-App-Ts: ${TS}" \
  ${BODY:+-H "Content-Type: application/json" --data-binary "$BODY"}
echo
