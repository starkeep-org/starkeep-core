#!/bin/sh
# Runs every model and compares TLC's verdict with expected.txt.
# Usage: ./check-all.sh [name-filter]
# With QUICK=1, only the models tiered "quick" in expected.txt run (CI does this).
cd "$(dirname "$0")"
fail=0
while read -r name expect tier; do
  case "$name" in ''|'#'*) continue;; esac
  [ -n "$QUICK" ] && [ "$tier" != quick ] && continue
  [ -n "$1" ] && case "$name" in *$1*) ;; *) continue;; esac
  out=$(./run.sh "models/$name.cfg" check "${SECONDS_PER_MODEL:-600}" 2>&1)
  if echo "$out" | grep -q "No error has been found"; then got=pass
  elif v=$(echo "$out" | sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' | head -1); [ -n "$v" ]; then got=$v
  else got=incomplete; fi
  states=$(echo "$out" | sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' | tail -1)
  depth=$(echo "$out" | sed -n 's/^The depth of the complete state graph search is \([0-9]*\).*/\1/p')
  if [ "$got" = "$expect" ]; then mark=ok; else mark=UNEXPECTED; fail=1; fi
  printf '%-28s expected %-26s got %-26s states %-10s depth %s  %s\n' "$name" "$expect" "$got" "${states:--}" "${depth:--}" "$mark"
  mkdir -p traces; echo "$out" > "traces/$name.out"
done < expected.txt
exit $fail
