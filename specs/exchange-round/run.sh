#!/bin/sh
# Usage: ./run.sh models/<name>.cfg [check|simulate] [seconds]
# Needs Java 11+ and tla2tools.jar: set TLA2TOOLS, or put the jar beside this script.
set -e
here=$(cd "$(dirname "$0")" && pwd)
jar=${TLA2TOOLS:-$here/tla2tools.jar}
cfg=$1
mode=${2:-check}
seconds=${3:-600}
meta=$(mktemp -d)
flags=""
[ "$mode" = simulate ] && flags="-simulate -depth 100"
cd "$here"
java -XX:+UseParallelGC -cp "$jar" tlc2.TLC $flags -workers "${WORKERS:-auto}" \
  -deadlock -metadir "$meta" -config "$cfg" ExchangeRound.tla &
pid=$!
( sleep "$seconds"; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
watchdog=$!
wait "$pid" || true
kill "$watchdog" 2>/dev/null || true
