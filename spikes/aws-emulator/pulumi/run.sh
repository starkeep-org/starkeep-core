#!/usr/bin/env bash
# AI-684: run admin-installer's per-app Pulumi compute program, and then
# installComputeStack unchanged, against AWS Emulator; invoke the deployed
# routes; print one row per declared resource and per invoke.
#
# Usage, from the repo root after `pnpm install`:
#   bash spikes/aws-emulator/pulumi/run.sh
#
# Environment (all optional), as in spikes/aws-emulator/runtime/run.sh:
#   EMULATOR_VERSION   package version to install, or "latest". Default: the pinned one below.
#   EMULATOR_INSTALL   "extract" (dpkg-deb -x, no root; default) or "apt" (sudo apt-get install).
#   EMULATOR_DATA_PORT port for the emulator, 1-65535. Default 9297.
#   SPIKE_VARIANTS     comma-separated provider-config variants to run (default: all).
#
# Needs: bash, curl, dpkg-deb, gpgv, sha256sum, zip, unzip, openssl, node 22+,
# pnpm, and the root workspace installed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
VERSION="${EMULATOR_VERSION:-1.0.322}"
PULUMI_CLI_VERSION="3.237.0" # = @pulumi/pulumi in the root lockfile
PULUMI_AWS_VERSION="6.83.3"  # = @pulumi/aws in the root lockfile
PORT="${EMULATOR_DATA_PORT:-9297}"
WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/aws-emulator-spike-pulumi"
# The CLI and the 781 MB aws provider plugin are kept between runs.
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/starkeep-aws-emulator-spike-pulumi"
BASE_URL="https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS"
# Fingerprint of the AWS package-signing key, from the getting-started-linux guide.
KEY_FPR="98BCF336A3BE53B734E967C52E5BF49BD940F624"

case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
  amd64 | x86_64) ARCH=amd64 PULUMI_ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 PULUMI_ARCH=arm64 ;;
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
for tool in curl dpkg-deb gpgv sha256sum zip unzip openssl node pnpm; do
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
mkdir -p "$WORK" "$CACHE"

# --- JavaScript: the spike's own dependencies and the code under test ------------
log "installing spike dependencies"
(cd "$HERE" && pnpm install --ignore-workspace --frozen-lockfile --reporter=silent)

# admin-installer is source-only and runs under tsx; it imports
# @starkeep/admin-manifest, which resolves to that package's dist.
log "building @starkeep/admin-manifest"
(cd "$ROOT" && pnpm exec turbo run build --output-logs=errors-only \
  --filter=@starkeep/admin-manifest) >"$WORK/build.log" 2>&1 || {
  cat "$WORK/build.log" >&2
  exit 1
}

# The example app is its own workspace; `pnpm bundle` is the contract the
# installer calls (cli-install-app), with the same two variables.
log "bundling example-app (example-app/web/scripts/bundle.mjs)"
(cd "$ROOT/example-app" && pnpm install --frozen-lockfile --reporter=silent) >"$WORK/example-install.log" 2>&1 || {
  cat "$WORK/example-install.log" >&2
  exit 1
}
(cd "$ROOT/example-app/web" && STARKEEP_APP_BASE_PATH=/apps/example-app \
  STARKEEP_BUNDLE_OUT="$WORK/example-app/dist.zip" pnpm bundle) >"$WORK/bundle.log" 2>&1 || {
  cat "$WORK/bundle.log" >&2
  exit 1
}
(cd "$HERE/control" && zip -q "$WORK/control-app.zip" index.mjs)

# What the bundle imports from Node, statically (ESM `from "node:…"`, resolved
# at INIT) — compared in the doc with the emulator's QuickJS module list.
mkdir -p "$WORK/unzipped" "$WORK/probe"
unzip -q "$WORK/example-app/dist.zip" -d "$WORK/unzipped"
SPIKE_BUNDLE_IMPORTS="$(for f in index.mjs api.mjs; do
  printf '%s: %s\n' "$f" "$(grep -oE "from ['\"]node:[a-z_/]+['\"]" "$WORK/unzipped/$f" |
    sed -E "s/from ['\"]//; s/['\"]$//" | sort -u | tr '\n' ' ')"
done)"
# The probe: the same bundle with esbuild's two-line `node:module` banner
# removed, to see what INIT fails on next.
cp -r "$WORK/unzipped/." "$WORK/probe/"
for f in index.mjs api.mjs; do sed -i '1,2d' "$WORK/probe/$f"; done
(cd "$WORK/probe" && zip -qr "$WORK/probe.zip" index.mjs api.mjs assets)

# --- Pulumi CLI and aws provider plugin, pinned -------------------------------------
PULUMI_ROOT="$CACHE/cli-$PULUMI_CLI_VERSION" # PulumiCommand.get wants <root>/bin/pulumi
PULUMI_HOME_DIR="$CACHE/pulumi-home"
if [ ! -x "$PULUMI_ROOT/bin/pulumi" ]; then
  log "downloading Pulumi CLI v$PULUMI_CLI_VERSION"
  tgz="pulumi-v${PULUMI_CLI_VERSION}-linux-${PULUMI_ARCH}.tar.gz"
  curl -fsSLo "$WORK/$tgz" "https://get.pulumi.com/releases/sdk/$tgz"
  curl -fsSLo "$WORK/pulumi-checksums.txt" \
    "https://get.pulumi.com/releases/sdk/pulumi-${PULUMI_CLI_VERSION}-checksums.txt"
  (cd "$WORK" && grep " $tgz\$" pulumi-checksums.txt | sha256sum -c --quiet -) || {
    echo "Pulumi CLI checksum mismatch; refusing to use it" >&2
    exit 1
  }
  rm -rf "$PULUMI_ROOT" && mkdir -p "$PULUMI_ROOT"
  tar xzf "$WORK/$tgz" -C "$PULUMI_ROOT"
  mv "$PULUMI_ROOT/pulumi" "$PULUMI_ROOT/bin"
fi
log "installing aws provider plugin v$PULUMI_AWS_VERSION (cached after the first run)"
PULUMI_HOME="$PULUMI_HOME_DIR" PULUMI_SKIP_UPDATE_CHECK=true \
  "$PULUMI_ROOT/bin/pulumi" plugin install resource aws "$PULUMI_AWS_VERSION" >"$WORK/plugin.log" 2>&1 || {
  cat "$WORK/plugin.log" >&2
  exit 1
}

# --- Install the emulator (runtime spike, step 1) ----------------------------------
log "install mode: $EMULATOR_INSTALL; package: $PKG_URL"
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
if [ "$healthy" != yes ]; then
  echo "emulator not healthy after 60s; log:" >&2
  cat "$WORK/emulator.log" >&2
  exit 1
fi

# --- The driver ---------------------------------------------------------------------
# Every variable through which an SDK or the Pulumi provider could pick up other
# credentials is removed. HOME is a fresh directory so installComputeStack's
# ensurePulumiCli downloads into the work directory, not ~/.starkeep.
mkdir -p "$WORK/home"
log "running the Pulumi program and installComputeStack (a few minutes)"
driver_start=$(now_ns)
(cd "$HERE" && env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_PROFILE \
  -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN -u AWS_ROLE_SESSION_NAME \
  -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI -u AWS_CONTAINER_CREDENTIALS_FULL_URI \
  -u AWS_CONTAINER_AUTHORIZATION_TOKEN -u AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE \
  -u STARKEEP_AWS_TESTS -u PULUMI_ACCESS_TOKEN -u PULUMI_BACKEND_URL \
  HOME="$WORK/home" \
  AWS_ENDPOINT_URL="https://127.0.0.1:$PORT" \
  AWS_SHARED_CREDENTIALS_FILE="$EMU_DIR/emulator_credentials" \
  AWS_CONFIG_FILE="$EMU_DIR/config" \
  AWS_CA_BUNDLE="$CA" \
  NODE_EXTRA_CA_CERTS="$CA" \
  AWS_EC2_METADATA_DISABLED=true \
  AWS_REGION=us-east-1 \
  AWS_DEFAULT_REGION=us-east-1 \
  PULUMI_CONFIG_PASSPHRASE="$(openssl rand -hex 24)" \
  SPIKE_WORK="$WORK" \
  SPIKE_PULUMI_ROOT="$PULUMI_ROOT" \
  SPIKE_PULUMI_HOME="$PULUMI_HOME_DIR" \
  SPIKE_EXAMPLE_ZIP="$WORK/example-app/dist.zip" \
  SPIKE_CONTROL_ZIP="$WORK/control-app.zip" \
  SPIKE_PROBE_ZIP="$WORK/probe.zip" \
  SPIKE_BUNDLE_IMPORTS="$SPIKE_BUNDLE_IMPORTS" \
  ./node_modules/.bin/tsx spike.mjs) >"$WORK/result.json" 2>"$WORK/driver.err" && driver_rc=0 || driver_rc=$?
driver_s=$(secs_since "$driver_start")

stop_emulator
trap - EXIT

cat <<EOF

================ AWS Emulator: per-app Pulumi compute stack (AI-684) ================
emulator version : $emu_version (released $emu_release, commit $emu_commit)
pulumi           : CLI v$PULUMI_CLI_VERSION, aws provider plugin v$PULUMI_AWS_VERSION
driver           : $driver_s s, exit $driver_rc
EOF
if [ -s "$WORK/driver.err" ]; then
  echo "--- driver stderr (last 40 lines) ---"
  tail -40 "$WORK/driver.err"
fi
echo
if [ -s "$WORK/result.json" ]; then
  node "$HERE/report.mjs" "$WORK/result.json"
fi
echo "====================================================================================="
exit "$driver_rc"
