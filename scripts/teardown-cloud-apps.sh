#!/usr/bin/env bash
# Tears down all per-app installs (photos, etc.) from AWS.
#
# Removes, for each discovered app (excluding cloud-data-server):
#   - Lambda functions
#   - CloudWatch log groups
#   - IAM app role (inline policies removed first)
#
# cloud-data-server is NOT touched here — run teardown-cloud-data-server.sh
# to remove it (which calls this script first).
#
# Config is read from ~/.starkeep/config.json. If the file has been reset
# to {} (e.g. by teardown-bootstrap.sh), supply --prefix and --region:
#
# Usage:
#   ./teardown-cloud-apps.sh [--yes|-y] [--prefix <stack-prefix>] [--region <region>]

set -euo pipefail

STARKEEP_DATA_DIR="${STARKEEP_DATA_DIR:-$HOME/.starkeep}"
CONFIG_FILE="$STARKEEP_DATA_DIR/config.json"

# ── Parse flags ───────────────────────────────────────────────────────────────

YES=false
FLAG_PREFIX=""
FLAG_REGION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=true; shift ;;
    --prefix) FLAG_PREFIX="$2"; shift 2 ;;
    --region) FLAG_REGION="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# ── Load config ───────────────────────────────────────────────────────────────

CONFIG_STACK_PREFIX=""
CONFIG_USER_POOL_ID=""

if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_STACK_PREFIX=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('stackPrefix',''))" 2>/dev/null || true)
  CONFIG_USER_POOL_ID=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('userPoolId',''))" 2>/dev/null || true)
fi

STACK_PREFIX="${FLAG_PREFIX:-$CONFIG_STACK_PREFIX}"
if [[ -z "$STACK_PREFIX" ]]; then
  echo "Error: stackPrefix not found in config and --prefix not provided."
  echo "Usage: $0 [--yes] --prefix <stack-prefix> [--region <region>]"
  exit 1
fi

# Resolve region: flag > userPoolId prefix > AWS config
if [[ -n "$FLAG_REGION" ]]; then
  REGION="$FLAG_REGION"
elif [[ -n "$CONFIG_USER_POOL_ID" ]]; then
  REGION="${CONFIG_USER_POOL_ID%%_*}"
elif [[ -n "${AWS_DEFAULT_REGION:-}" ]]; then
  REGION="$AWS_DEFAULT_REGION"
elif [[ -n "${AWS_REGION:-}" ]]; then
  REGION="$AWS_REGION"
elif REGION=$(aws configure get region 2>/dev/null) && [[ -n "$REGION" ]]; then
  :
else
  echo "Error: cannot determine region. Supply --region <region> or set AWS_DEFAULT_REGION."
  exit 1
fi

# Pin every aws subcommand below to the resolved region. The CLI's default
# region (from ~/.aws/config) may differ from the starkeep config region, and
# a mismatch silently targets the wrong region — orphan log groups, lambdas,
# etc. get missed in cleanup. See teardown-bootstrap.sh / -cloud-data-server.sh
# for the matching exports.
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# ── Helpers ───────────────────────────────────────────────────────────────────

step() { echo ""; echo "==> $*"; }
skip() { echo "  Not found, skipping."; }

delete_lambda() {
  local fn_name="$1"
  if aws lambda get-function --function-name "$fn_name" >/dev/null 2>&1; then
    aws lambda delete-function --function-name "$fn_name"
    echo "  Deleted Lambda: $fn_name"
  fi
}

delete_log_group() {
  local group="$1"
  if aws logs describe-log-groups --log-group-name-prefix "$group" \
      --query "logGroups[?logGroupName=='$group'] | length(@)" \
      --output text 2>/dev/null | grep -q "^1$"; then
    aws logs delete-log-group --log-group-name "$group"
    echo "  Deleted log group: $group"
  fi
}

delete_role() {
  local role_name="$1"
  step "Deleting IAM role: $role_name"
  if ! aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    skip; return
  fi

  aws iam delete-role-permissions-boundary --role-name "$role_name" 2>/dev/null || true

  local arns
  arns=$(aws iam list-attached-role-policies --role-name "$role_name" \
    --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null || true)
  for arn in $arns; do
    echo "  Detaching: $arn"
    aws iam detach-role-policy --role-name "$role_name" --policy-arn "$arn" || true
  done

  local inline
  inline=$(aws iam list-role-policies --role-name "$role_name" \
    --query 'PolicyNames[]' --output text 2>/dev/null || true)
  for p in $inline; do
    echo "  Deleting inline policy: $p"
    aws iam delete-role-policy --role-name "$role_name" --policy-name "$p" || true
  done

  aws iam delete-role --role-name "$role_name"
  echo "  Deleted."
}

# ── Discover per-app IDs (excludes cloud-data-server) ────────────────────────

step "Discovering installed apps via IAM roles (prefix: ${STACK_PREFIX}-app-*-role)"

APP_IDS=$(python3 - "$STACK_PREFIX" << 'PYEOF'
import subprocess, json, sys, re

prefix = sys.argv[1]
marker = None
found = []

while True:
    cmd = ["aws", "iam", "list-roles", "--output", "json"]
    if marker:
        cmd += ["--starting-token", marker]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        break
    data = json.loads(r.stdout)
    for role in data.get("Roles", []):
        name = role["RoleName"]
        pattern = rf"^{re.escape(prefix)}-app-(.+)-role$"
        m = re.match(pattern, name)
        if not m:
            continue
        app_id = m.group(1)
        # Skip bootstrap-owned roles:
        #   - cloud-data-server: torn down by teardown-cloud-data-server.sh (step 8)
        #   - admin: created by the bootstrap stack and wired into the Cognito
        #     Identity Pool's authenticated role attachment. Deleting it breaks
        #     bootstrap-user sign-in with "Invalid identity pool configuration".
        if app_id in ("cloud-data-server", "admin"):
            continue
        tags_r = subprocess.run(
            ["aws", "iam", "list-role-tags", "--role-name", name, "--output", "json"],
            capture_output=True, text=True,
        )
        if tags_r.returncode != 0:
            continue
        tags = {t["Key"]: t["Value"] for t in json.loads(tags_r.stdout).get("Tags", [])}
        if tags.get("starkeep:managed") == "true":
            found.append(app_id)
    marker = data.get("Marker")
    if not marker:
        break

for app_id in found:
    print(app_id)
PYEOF
)

if [[ -n "$APP_IDS" ]]; then
  echo "  Found: $(echo "$APP_IDS" | tr '\n' ' ')"
else
  echo "  No per-app IAM roles found for prefix '${STACK_PREFIX}'."
fi

# Detect orphan Lambdas + log groups (from prior partial deploys where the IAM
# role was never created or was torn down separately). Without sweeping these,
# subsequent deploys fail with ResourceConflictException on CreateFunction or
# ResourceAlreadyExistsException on CreateLogGroup.
step "Scanning for orphan Lambdas under ${STACK_PREFIX}-app-"
ORPHAN_LAMBDAS=$(aws lambda list-functions \
  --query "Functions[?starts_with(FunctionName, '${STACK_PREFIX}-app-')].FunctionName" \
  --output text 2>/dev/null \
  | tr '\t' '\n' \
  | grep -Ev "^${STACK_PREFIX}-app-(cloud-data-server|admin)-" \
  || true)

if [[ -n "$ORPHAN_LAMBDAS" ]]; then
  echo "  Found: $(echo "$ORPHAN_LAMBDAS" | tr '\n' ' ')"
else
  echo "  None."
fi

step "Scanning for orphan log groups under /aws/lambda/${STACK_PREFIX}-app-"
ORPHAN_LOG_GROUPS=$(aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/${STACK_PREFIX}-app-" \
  --query 'logGroups[].logGroupName' --output text 2>/dev/null \
  | tr '\t' '\n' \
  | grep -Ev "^/aws/lambda/${STACK_PREFIX}-app-(cloud-data-server|admin)-" \
  || true)

if [[ -n "$ORPHAN_LOG_GROUPS" ]]; then
  echo "  Found: $(echo "$ORPHAN_LOG_GROUPS" | tr '\n' ' ')"
else
  echo "  None."
fi

if [[ -z "$APP_IDS" && -z "$ORPHAN_LAMBDAS" && -z "$ORPHAN_LOG_GROUPS" ]]; then
  echo ""
  echo "Nothing to do."
  exit 0
fi

# ── Confirmation ──────────────────────────────────────────────────────────────

echo ""
echo "This will permanently destroy the following app resources:"
echo ""
echo "  Stack prefix    : $STACK_PREFIX  (region: $REGION, account: $ACCOUNT_ID)"
echo "  Apps            : $(echo "${APP_IDS:-<none>}" | tr '\n' ' ')"
echo "  Orphan lambdas  : $(echo "${ORPHAN_LAMBDAS:-<none>}" | tr '\n' ' ')"
echo "  Orphan logs     : $(echo "${ORPHAN_LOG_GROUPS:-<none>}" | tr '\n' ' ')"
echo "  Resources       : Lambda functions, CloudWatch log groups, IAM app roles"
echo ""

if [[ "$YES" != "true" ]]; then
  read -r -p "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── Teardown ──────────────────────────────────────────────────────────────────

for APP_ID in $APP_IDS; do
  step "Deleting compute resources for app: $APP_ID"

  LAMBDAS=$(aws lambda list-functions \
    --query "Functions[?starts_with(FunctionName, '${STACK_PREFIX}-app-${APP_ID}-')].FunctionName" \
    --output text 2>/dev/null || true)
  for fn in $LAMBDAS; do
    delete_lambda "$fn"
  done

  LOG_GROUPS=$(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK_PREFIX}-app-${APP_ID}-" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null || true)
  for lg in $LOG_GROUPS; do
    delete_log_group "$lg"
  done
done

if [[ -n "$ORPHAN_LAMBDAS" ]]; then
  step "Deleting orphan Lambdas"
  for fn in $ORPHAN_LAMBDAS; do
    delete_lambda "$fn"
  done
fi

if [[ -n "$ORPHAN_LOG_GROUPS" ]]; then
  step "Deleting orphan log groups"
  for lg in $ORPHAN_LOG_GROUPS; do
    delete_log_group "$lg"
  done
fi

for APP_ID in $APP_IDS; do
  delete_role "${STACK_PREFIX}-app-${APP_ID}-role"
done

echo ""
echo "App teardown complete."
