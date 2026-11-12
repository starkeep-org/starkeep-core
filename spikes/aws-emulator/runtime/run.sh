#!/usr/bin/env bash
# AI-679: install AWS Emulator from its Debian package, start it, wait for
# /__admin/health, run an S3 round trip with @aws-sdk/client-s3, print a summary.
#
# Usage: bash spikes/aws-emulator/runtime/run.sh
#
# Environment (all optional):
#   EMULATOR_VERSION   package version to install, or "latest". Default: the pinned one below.
#   EMULATOR_INSTALL   "extract" (dpkg-deb -x into the work dir, no root needed; default) or
#                      "apt" (sudo apt-get install, the documented path; installs system-wide,
#                      used by the GitHub Actions workflow).
#   EMULATOR_DATA_PORT port for the emulator, 1-65535 (0 is not supported here). Default 9297.
#
# Needs: bash, curl, dpkg-deb, gpgv, node 22+, pnpm. The package signature is always
# verified with gpgv against the pinned AWS key; there is no opt-out.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${EMULATOR_VERSION:-1.0.322}"
PORT="${EMULATOR_DATA_PORT:-9297}"
# Package, extracted files and emulator log. Recreated on every run.
WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/aws-emulator-spike"
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

now_ns() { date +%s%N; }
secs_since() { awk -v a="$1" -v b="$(now_ns)" 'BEGIN { printf "%.2f", (b - a) / 1e9 }'; }
log() { echo "[spike] $*"; }

rm -rf "$WORK"
mkdir -p "$WORK"

# --- JavaScript dependencies (standalone: not part of the root pnpm workspace) ---
log "installing spike dependencies"
(cd "$HERE" && pnpm install --ignore-workspace --frozen-lockfile --reporter=silent)

# --- Install ------------------------------------------------------------------
log "install mode: $EMULATOR_INSTALL; package: $PKG_URL"
install_start=$(now_ns)
curl -fsSLo "$WORK/aws-emulator.deb" "$PKG_URL"
download_s=$(secs_since "$install_start")

# Verify the package signature. gpgv (installed with apt on Debian/Ubuntu) needs no
# keyring home and no root. It takes a binary keyring, so the armored key is decoded
# here. The signer is then pinned: the primary-key fingerprint in VALIDSIG must be
# KEY_FPR, so another key in current.asc cannot sign for AWS.
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
SIG_STATUS="valid signature by $KEY_FPR (gpgv)"

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
bin_bytes=$(stat -L -c %s "$BIN")
version_out="$("$BIN" -v)"
emu_version=$(awk -F': ' '/^Version/ { print $2 }' <<<"$version_out")
emu_release=$(awk -F': ' '/^Release date/ { print $2 }' <<<"$version_out")
emu_commit=$(awk -F': ' '/^Commit/ { print $2 }' <<<"$version_out")

# --- Start --------------------------------------------------------------------
EMU_DIR="$HOME/.aws/emulator/$PORT"
CA="$EMU_DIR/ca.pem"
# Only "connection refused" (curl exit 7) means nothing listens on the port. Anything
# else (a reply, a TLS error, a timeout) may be a live emulator whose files we must not touch.
probe=0
curl -sk -m 2 -o /dev/null "https://127.0.0.1:$PORT/__admin/health" || probe=$?
if [ "$probe" -ne 7 ]; then
  echo "something is listening on 127.0.0.1:$PORT (curl exit $probe); stop it or set EMULATOR_DATA_PORT" >&2
  exit 1
fi
# A previous run that was killed (not stopped cleanly) leaves its files behind;
# a stale ca.pem would make the health probe fail TLS until the new one lands.
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

# --- S3 round trip ------------------------------------------------------------
# Exactly the variables from the point-sdk-to-emulator guide, plus NODE_EXTRA_CA_CERTS
# (the guide's TLS setting for JavaScript v3). Every variable through which the SDK's
# default chain could pick up other credentials is removed.
set +e
rt_json=$(
  cd "$HERE" &&
    env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_PROFILE \
      -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN -u AWS_ROLE_SESSION_NAME \
      -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI -u AWS_CONTAINER_CREDENTIALS_FULL_URI \
      -u AWS_CONTAINER_AUTHORIZATION_TOKEN -u AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE \
      AWS_ENDPOINT_URL="https://127.0.0.1:$PORT" \
      AWS_SHARED_CREDENTIALS_FILE="$EMU_DIR/emulator_credentials" \
      AWS_CONFIG_FILE="$EMU_DIR/config" \
      AWS_CA_BUNDLE="$CA" \
      NODE_EXTRA_CA_CERTS="$CA" \
      AWS_EC2_METADATA_DISABLED=true \
      AWS_DISABLE_HOST_PREFIX_INJECTION=true \
      AWS_REGION=us-east-1 \
      AWS_DEFAULT_REGION=us-east-1 \
      node s3-roundtrip.mjs
)
rt_status=$?
set -e

stop_emulator
trap - EXIT
if [ -e "$EMU_DIR/emulator_credentials" ]; then cleanup="credentials file left behind"; else cleanup="credentials file removed"; fi

if [ "$rt_status" -eq 0 ]; then rt=ok; else rt=FAIL; fi

cat <<EOF

================ AWS Emulator runtime spike (AI-679) ================
emulator version : $emu_version (released $emu_release, commit $emu_commit)
package          : $PKG_URL
signature        : $SIG_STATUS
install mode     : $EMULATOR_INSTALL
package size     : $deb_bytes bytes ($((deb_bytes / 1048576)) MiB)
binary size      : $bin_bytes bytes ($((bin_bytes / 1048576)) MiB)
download seconds : $download_s
install seconds  : $install_s   (download + verify + install)
startup seconds  : $startup_s   (launch to GET /__admin/health = ok)
s3 round trip    : $rt
round-trip detail: $rt_json
on stop          : $cleanup
=====================================================================
EOF

exit "$rt_status"
