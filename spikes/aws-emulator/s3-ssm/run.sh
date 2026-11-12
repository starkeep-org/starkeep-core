#!/usr/bin/env bash
# AI-734: run packages/storage-s3's S3ObjectStorageAdapter and the SSM credential
# readers (admin-installer app-creds.ts and pulumi-passphrase.ts, app-client
# credentials.ts) against AWS Emulator, and print one row per operation.
#
# Usage, from the repo root after `pnpm install`:
#   bash spikes/aws-emulator/s3-ssm/run.sh
#
# Environment (all optional), as in spikes/aws-emulator/runtime/run.sh:
#   EMULATOR_VERSION   package version to install, or "latest". Default: the pinned one below.
#   EMULATOR_INSTALL   "extract" (dpkg-deb -x, no root; default) or "apt" (sudo apt-get install).
#   EMULATOR_DATA_PORT port for the emulator, 1-65535. Default 9297.
#
# Needs: bash, curl, dpkg-deb, gpgv, node 22+, pnpm, and the root workspace installed.
# Install, signature check and start are the runtime spike's steps (AI-679), unchanged.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
VERSION="${EMULATOR_VERSION:-1.0.322}"
PORT="${EMULATOR_DATA_PORT:-9297}"
WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/aws-emulator-spike-s3-ssm"
BASE_URL="https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS"
# Fingerprint of the AWS package-signing key, from the getting-started-linux guide.
KEY_FPR="98BCF336A3BE53B734E967C52E5BF49BD940F624"

case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
  amd64 | x86_64) ARCH=amd64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "EMULATOR_DATA_PORT must be 1-65535 (the emulator's files live under ~/.aws/emulator/<port>/)" >&2
  exit 1
fi
if [ "$VERSION" = latest ]; then
  PKG_URL="$BASE_URL/latest/aws-emulator_${ARCH}.deb"
else
  PKG_URL="$BASE_URL/aws-emulator_${VERSION}-1_${ARCH}.deb"
fi
EMULATOR_INSTALL="${EMULATOR_INSTALL:-extract}"
case "$EMULATOR_INSTALL" in
  apt | extract) ;;
  *) echo "EMULATOR_INSTALL must be apt or extract" >&2; exit 1 ;;
esac
for tool in curl dpkg-deb gpgv node pnpm; do
  command -v "$tool" >/dev/null || { echo "missing required command: $tool" >&2; exit 1; }
done
if [ ! -d "$ROOT/node_modules" ]; then
  echo "the root workspace is not installed; run 'pnpm install' at $ROOT first" >&2
  exit 1
fi

now_ns() { date +%s%N; }
secs_since() { awk -v a="$1" -v b="$(now_ns)" 'BEGIN { printf "%.2f", (b - a) / 1e9 }'; }
log() { echo "[spike] $*"; }

rm -rf "$WORK"
mkdir -p "$WORK"

# --- JavaScript: the spike's own dependencies, and the packages under test ------
log "installing spike dependencies"
(cd "$HERE" && pnpm install --ignore-workspace --frozen-lockfile --reporter=silent)

# storage-s3 is imported from its build (dist/index.js), and so is storage-adapter
# (its checksum helpers). admin-installer is source-only and runs under tsx, but
# its app-creds.ts imports @starkeep/protocol-primitives, which resolves to that
# package's dist. turbo builds each one's workspace dependencies first and replays
# unchanged builds from its cache.
log "building @starkeep/storage-s3 and @starkeep/protocol-primitives"
build_start=$(now_ns)
(cd "$ROOT" && pnpm exec turbo run build --output-logs=errors-only \
  --filter=@starkeep/storage-s3 --filter=@starkeep/protocol-primitives) >"$WORK/build.log" 2>&1 || {
  cat "$WORK/build.log" >&2
  exit 1
}
build_s=$(secs_since "$build_start")

# --- Install the emulator (runtime spike, step 1) ----------------------------------
log "install mode: $EMULATOR_INSTALL; package: $PKG_URL"
install_start=$(now_ns)
curl -fsSLo "$WORK/aws-emulator.deb" "$PKG_URL"
curl -fsSLo "$WORK/aws-emulator.deb.sig" "$PKG_URL.sig"
curl -fsSLo "$WORK/aws-publishing.asc" https://downloads.aws.com/keys/gpg/current.asc
awk '/^-----BEGIN/ { h = 1; next } h && /^$/ { b = 1; next } /^=|^-----END/ { b = 0 } b' \
  "$WORK/aws-publishing.asc" | base64 -d >"$WORK/aws-publishing.gpg"
gpgv --status-fd 1 --keyring "$WORK/aws-publishing.gpg" \
  "$WORK/aws-emulator.deb.sig" "$WORK/aws-emulator.deb" >"$WORK/gpgv-status.txt" 2>"$WORK/gpgv-stderr.txt" || true
signer=$(awk '$2 == "VALIDSIG" { print $NF }' "$WORK/gpgv-status.txt")
if [ "$signer" != "$KEY_FPR" ]; then
  echo "package signature is not a valid signature by $KEY_FPR; refusing to install" >&2
  cat "$WORK/gpgv-stderr.txt" "$WORK/gpgv-status.txt" >&2
  exit 1
fi
if [ "$EMULATOR_INSTALL" = apt ]; then
  sudo apt-get install -y -qq --allow-downgrades "$WORK/aws-emulator.deb" >"$WORK/apt.log" 2>&1 || {
    cat "$WORK/apt.log" >&2
    exit 1
  }
  BIN=/usr/bin/aws-emulator
else
  dpkg-deb -x "$WORK/aws-emulator.deb" "$WORK/root"
  BIN="$WORK/root/opt/aws-emulator/bin/aws-emulator"
fi
install_s=$(secs_since "$install_start")
deb_bytes=$(stat -c %s "$WORK/aws-emulator.deb")
version_out="$("$BIN" -v)"
emu_version=$(awk -F': ' '/^Version/ { print $2 }' <<<"$version_out")
emu_release=$(awk -F': ' '/^Release date/ { print $2 }' <<<"$version_out")
emu_commit=$(awk -F': ' '/^Commit/ { print $2 }' <<<"$version_out")

# --- Start and wait for health (runtime spike, step 2) ---------------------------
EMU_DIR="$HOME/.aws/emulator/$PORT"
CA="$EMU_DIR/ca.pem"
probe=0
curl -sk -m 2 -o /dev/null "https://127.0.0.1:$PORT/__admin/health" || probe=$?
if [ "$probe" -ne 7 ]; then
  echo "something is listening on 127.0.0.1:$PORT (curl exit $probe); stop it or set EMULATOR_DATA_PORT" >&2
  exit 1
fi
rm -rf "$EMU_DIR"

log "starting $BIN on port $PORT"
start_ns=$(now_ns)
"$BIN" --telemetry off -p "$PORT" >"$WORK/emulator.log" 2>&1 &
EMU_PID=$!

stop_emulator() {
  if kill -0 "$EMU_PID" 2>/dev/null; then
    kill -TERM "$EMU_PID"
    for _ in $(seq 100); do
      kill -0 "$EMU_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$EMU_PID" 2>/dev/null; then
      echo "emulator did not stop within 10s of SIGTERM; sending SIGKILL" >&2
      kill -KILL "$EMU_PID" 2>/dev/null || true
    fi
    wait "$EMU_PID" 2>/dev/null || true
  fi
}
trap stop_emulator EXIT

healthy=no
for _ in $(seq 600); do
  if ! kill -0 "$EMU_PID" 2>/dev/null; then
    echo "emulator exited before becoming healthy; log:" >&2
    cat "$WORK/emulator.log" >&2
    exit 1
  fi
  if [ -s "$CA" ] && [ "$(curl -sf -m 1 --cacert "$CA" "https://127.0.0.1:$PORT/__admin/health" 2>/dev/null)" = ok ]; then
    healthy=yes
    break
  fi
  sleep 0.1
done
startup_s=$(secs_since "$start_ns")
if [ "$healthy" != yes ]; then
  echo "emulator not healthy after 60s; log:" >&2
  cat "$WORK/emulator.log" >&2
  exit 1
fi

# --- The environment the code under test runs in (runtime spike, step 3) --------
# Every variable through which the SDK's default chain could pick up other
# credentials is removed; the drivers refuse to run if one is still set.
# $1 is the endpoint, the rest is the command.
with_emulator_env() {
  local endpoint="$1"
  shift
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_PROFILE \
    -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN -u AWS_ROLE_SESSION_NAME \
    -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI -u AWS_CONTAINER_CREDENTIALS_FULL_URI \
    -u AWS_CONTAINER_AUTHORIZATION_TOKEN -u AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE \
    -u STARKEEP_AWS_TESTS \
    AWS_ENDPOINT_URL="$endpoint" \
    AWS_SHARED_CREDENTIALS_FILE="$EMU_DIR/emulator_credentials" \
    AWS_CONFIG_FILE="$EMU_DIR/config" \
    AWS_CA_BUNDLE="$CA" \
    NODE_EXTRA_CA_CERTS="$CA" \
    AWS_EC2_METADATA_DISABLED=true \
    AWS_DISABLE_HOST_PREFIX_INJECTION=true \
    AWS_REGION=us-east-1 \
    AWS_DEFAULT_REGION=us-east-1 \
    "$@"
}
ENDPOINT="https://127.0.0.1:$PORT"

# --- The drivers ----------------------------------------------------------------
log "S3: S3ObjectStorageAdapter from packages/storage-s3/dist (plain node)"
s3_start=$(now_ns)
(cd "$HERE" && with_emulator_env "$ENDPOINT" node s3.mjs) >"$WORK/s3.json" 2>"$WORK/s3.err" || true
s3_s=$(secs_since "$s3_start")

log "SSM: admin-installer and app-client readers from source (tsx)"
ssm_start=$(now_ns)
(cd "$HERE" && with_emulator_env "$ENDPOINT" ./node_modules/.bin/tsx ssm.mjs) >"$WORK/ssm.json" 2>"$WORK/ssm.err" || true
ssm_s=$(secs_since "$ssm_start")

# --- storage-s3's own vitest suite, pointed at the emulator by environment alone --
# Run it twice: with the emulator's environment, and with the same environment but
# an endpoint where nothing listens. Identical results mean no test reaches S3.
vitest_line() { grep -Eo 'Tests +[0-9]+ (passed|failed)[^|]*(\| *[0-9]+ [a-z]+)*' "$1" | tail -1 | tr -s ' '; }
log "storage-s3 vitest: emulator endpoint, then a dead endpoint"
(cd "$ROOT/packages/storage-s3" && with_emulator_env "$ENDPOINT" pnpm exec vitest run) >"$WORK/vitest-emulator.log" 2>&1 &&
  vt_emu="exit 0, $(vitest_line "$WORK/vitest-emulator.log")" || vt_emu="exit $?, $(vitest_line "$WORK/vitest-emulator.log")"
(cd "$ROOT/packages/storage-s3" && with_emulator_env "https://127.0.0.1:1" pnpm exec vitest run) >"$WORK/vitest-dead.log" 2>&1 &&
  vt_dead="exit 0, $(vitest_line "$WORK/vitest-dead.log")" || vt_dead="exit $?, $(vitest_line "$WORK/vitest-dead.log")"

stop_emulator
trap - EXIT
if [ -e "$EMU_DIR/emulator_credentials" ]; then cleanup="credentials file left behind"; else cleanup="credentials file removed"; fi

cat <<EOF

================ AWS Emulator: S3 adapter and SSM readers (AI-734) ================
emulator version : $emu_version (released $emu_release, commit $emu_commit)
package          : $PKG_URL ($((deb_bytes / 1048576)) MiB, signature verified by $KEY_FPR)
build seconds    : $build_s   (turbo build of storage-s3 + protocol-primitives and their deps)
install seconds  : $install_s   (download + verify + install, mode $EMULATOR_INSTALL)
startup seconds  : $startup_s   (launch to GET /__admin/health = ok)
s3 driver        : $s3_s s   (node, process start to exit)
ssm driver       : $ssm_s s   (tsx, process start to exit)
storage-s3 tests : emulator endpoint: $vt_emu
                   dead endpoint    : $vt_dead
on stop          : $cleanup
EOF
for area in s3 ssm; do
  if [ -s "$WORK/$area.err" ]; then
    echo "--- $area driver stderr ---"
    cat "$WORK/$area.err"
  fi
done
echo
node "$HERE/report.mjs" "$WORK/s3.json" "$WORK/ssm.json"
echo "==================================================================================="
