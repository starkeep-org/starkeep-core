#!/usr/bin/env bash
# Shared helpers for the three teardown scripts. Meant to be *sourced*:
#
#   source "$SCRIPT_DIR/teardown-common.sh"
#
# Failure reporting. A teardown keeps going after a failed AWS call, so one
# stuck resource does not leave the rest of the deployment standing. The script
# then fails at the end and lists every failure. A resource that does not exist
# is not a failure: a teardown that finds nothing to delete has succeeded.
# Failures go into one file rather than a bash array, so a failure recorded in
# a command substitution or in a python block still counts.
#
# A failing child teardown script stops its parent before the parent deletes
# its own layer, because each parent runs its child under `set -e`.

TEARDOWN_FAILURES=$(mktemp)
export TEARDOWN_FAILURES
trap 'rm -f "$TEARDOWN_FAILURES"' EXIT

# --dry-run, set by each script's flag parsing. A dry run resolves and prints
# every resource the teardown would delete, then exits without deleting.
DRY_RUN=false

# is_not_found <aws-error-text>: whether an AWS CLI error means "no such
# resource". Services name the case differently: ResourceNotFoundException,
# NotFoundException, ParameterNotFound, NoSuchEntity, NoSuchBucket, a bare 404
# from HeadBucket, and "Stack ... does not exist" from CloudFormation.
is_not_found() {
  case "$1" in
    *NotFound*|*NoSuch*|*"(404)"*|*"does not exist"*) return 0 ;;
  esac
  return 1
}

# record_failure <message>: prints the failure and records it for the summary.
# Prints to stderr, so a caller that captures stdout still shows the error.
record_failure() {
  local msg="${1//$'\n'/ }"
  echo "  ERROR $msg" >&2
  printf '%s\n' "$msg" >> "$TEARDOWN_FAILURES"
}

# AWS_ERROR holds the stderr of the last failed aws_probe call.
AWS_ERROR=""

# aws_probe <aws args...>: runs one AWS CLI call and prints its stdout. Returns
# 0 on success, 1 when the resource does not exist, and 2 on any other failure.
# Records nothing; aws_call is the recording form.
aws_probe() {
  local err_file out
  err_file=$(mktemp)
  if out=$(aws "$@" 2>"$err_file"); then
    rm -f "$err_file"
    printf '%s' "$out"
    return 0
  fi
  AWS_ERROR=$(cat "$err_file")
  rm -f "$err_file"
  is_not_found "$AWS_ERROR" && return 1
  return 2
}

# aws_call <aws args...>: aws_probe, but records any failure other than "does
# not exist". A lookup uses `x=$(aws_call ...) || true`: the failure is already
# recorded, and the empty result lets the teardown go on.
aws_call() {
  local rc=0
  aws_probe "$@" || rc=$?
  if [[ $rc -eq 2 ]]; then
    record_failure "aws $1 $2: $AWS_ERROR"
  fi
  return $rc
}

# exists <aws read args...>: returns 0 when the read succeeds. Otherwise it
# prints why the step is skipped and returns 1. A failed read is recorded.
exists() {
  local rc=0
  aws_call "$@" >/dev/null || rc=$?
  [[ $rc -eq 0 ]] && return 0
  [[ $rc -eq 1 ]] && echo "  Not found, skipping."
  return 1
}

# try_delete <what> <aws args...>: runs one destructive call. Prints "Deleted
# <what>." on success, and treats a resource that is already gone as deleted.
# Records any other failure. Always returns 0, so the teardown goes on.
try_delete() {
  local what="$1" rc=0
  shift
  aws_probe "$@" >/dev/null || rc=$?
  case $rc in
    0) echo "  Deleted $what." ;;
    1) echo "  $what: not found or already deleted." ;;
    *) record_failure "could not delete $what: $AWS_ERROR" ;;
  esac
  return 0
}

# try_quiet <aws args...>: runs one cleanup call, such as removing a
# permissions boundary, where "nothing to remove" is normal. Prints nothing
# unless the call fails for another reason, which it records.
try_quiet() {
  aws_call "$@" >/dev/null || true
}

# finish_teardown <name>: lists the recorded failures and exits 1, or prints
# "<name> complete.". A dry run reports that nothing was deleted instead.
finish_teardown() {
  echo ""
  if [[ -s "$TEARDOWN_FAILURES" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "Dry run of $1 is incomplete. These lookups failed:"
    else
      echo "$1 finished, but these steps failed:"
    fi
    sed 's/^/  /' "$TEARDOWN_FAILURES"
    exit 1
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "Dry run of $1: nothing was deleted."
  else
    echo "$1 complete."
  fi
  exit 0
}
