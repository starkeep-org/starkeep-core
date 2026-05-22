#!/usr/bin/env bash
# Tears down the cloud-data-server and all installed apps.
#
# Order of operations:
#   1. Per-app installs (teardown-cloud-apps.sh)
#   2. cloud-data-server: Lambda, log group, API Gateway, DSQL cluster,
#      files bucket, billing bucket, CUR report, IAM role
#
# Config is read from ~/.starkeep/config.json. If the file has been reset
# to {} (e.g. by teardown-bootstrap.sh), supply --prefix and --region:
#
# Usage:
#   ./teardown-cloud-data-server.sh [--yes|-y] [--prefix <stack-prefix>] [--region <region>]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
# a mismatch silently targets the wrong region. Note: the CUR (Cost &
# Usage Reports) section below explicitly overrides --region us-east-1 because
# CUR is only available in us-east-1.
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

PULUMI_STATE_BUCKET="${STACK_PREFIX}-pulumi-state-${ACCOUNT_ID}-${REGION}"
FILES_BUCKET="${STACK_PREFIX}-files-${ACCOUNT_ID}-${REGION}"
BILLING_BUCKET="${STACK_PREFIX}-billing-${ACCOUNT_ID}-${REGION}"
CUR_REPORT="${STACK_PREFIX}-billing"
CDS_LAMBDA="${STACK_PREFIX}-app-cloud-data-server-api"
CDS_LOG_GROUP="/aws/lambda/${CDS_LAMBDA}"
CDS_ROLE="${STACK_PREFIX}-app-cloud-data-server-role"
GATEWAY_NAME="${STACK_PREFIX}-gateway"

# ── Helpers ───────────────────────────────────────────────────────────────────

step() { echo ""; echo "==> $*"; }
skip() { echo "  Not found, skipping."; }

empty_bucket() {
  local bucket="$1"
  python3 << PYEOF
import json, subprocess

bucket = "$bucket"

def aws_json(*args):
    r = subprocess.run(["aws"] + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return json.loads(r.stdout) if r.stdout.strip() else {}

def aws_cmd(*args):
    r = subprocess.run(["aws"] + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout

def report_delete_response(stdout):
    if not stdout.strip():
        return 0
    try:
        resp = json.loads(stdout)
    except json.JSONDecodeError:
        print(f"  (non-JSON delete-objects response): {stdout[:500]}")
        return 0
    errors = resp.get("Errors", []) or []
    for e in errors[:10]:
        print(f"  ERROR deleting Key={e.get('Key')!r} VersionId={e.get('VersionId')!r} "
              f"Code={e.get('Code')} Message={e.get('Message')}")
    if len(errors) > 10:
        print(f"  ... and {len(errors) - 10} more errors")
    return len(errors)

deleted = 0
stalled = 0
while True:
    data = aws_json("s3api", "list-object-versions", "--bucket", bucket,
                    "--max-items", "1000", "--output", "json")
    objs = [{"Key": o["Key"], "VersionId": o["VersionId"]}
            for o in data.get("Versions", []) + data.get("DeleteMarkers", [])]
    if not objs:
        break
    payload = json.dumps({"Objects": objs, "Quiet": False})
    out = aws_cmd("s3api", "delete-objects", "--bucket", bucket, "--delete", payload)
    n_errors = report_delete_response(out)
    deleted += len(objs)
    print(f"  Attempted {len(objs)} (errors: {n_errors}); {deleted} versions/markers processed so far...")
    if n_errors == len(objs):
        stalled += 1
        if stalled >= 2:
            print("  Aborting: every delete in the last batch failed. See errors above.")
            raise SystemExit(2)
    else:
        stalled = 0

while True:
    data = aws_json("s3api", "list-objects-v2", "--bucket", bucket,
                    "--max-keys", "1000", "--output", "json")
    objs = [{"Key": o["Key"]} for o in data.get("Contents", [])]
    if not objs:
        break
    payload = json.dumps({"Objects": objs, "Quiet": False})
    out = aws_cmd("s3api", "delete-objects", "--bucket", bucket, "--delete", payload)
    report_delete_response(out)
    deleted += len(objs)
    print(f"  Deleted {deleted} objects so far...")

print("  Bucket empty." if deleted == 0 else f"  Emptied {deleted} total items.")
PYEOF
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

# ── Confirmation ──────────────────────────────────────────────────────────────

echo ""
echo "This will permanently destroy all Starkeep cloud-data-server resources"
echo "(and all installed apps via teardown-cloud-apps.sh):"
echo ""
echo "  Stack prefix : $STACK_PREFIX  (region: $REGION, account: $ACCOUNT_ID)"
echo "  API Gateway  : $GATEWAY_NAME"
echo "  Lambda       : $CDS_LAMBDA"
echo "  DSQL cluster : (tagged starkeep:appId=cloud-data-server)"
echo "  S3 buckets   : $FILES_BUCKET, $BILLING_BUCKET"
echo "  CUR report   : $CUR_REPORT"
echo "  IAM role     : $CDS_ROLE"
echo "  Pulumi locks : s3://${PULUMI_STATE_BUCKET}/.pulumi/locks/ (cleared, bucket kept)"
echo ""

if [[ "$YES" != "true" ]]; then
  read -r -p "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── Step 1: Tear down per-app installs ────────────────────────────────────────

echo ""
echo ">>> Running teardown-cloud-apps.sh..."
"$SCRIPT_DIR/teardown-cloud-apps.sh" --yes --prefix "$STACK_PREFIX" --region "$REGION"

# ── Step 1b: Clear stale Pulumi locks ─────────────────────────────────────────
# The Pulumi state bucket survives teardown. If a previous install/uninstall
# was killed mid-run, its lock file is left behind and blocks the next run
# with "the stack is currently locked by N lock(s)". We don't try to be
# surgical — wipe every lock under .pulumi/locks/ so both the builtins stack
# (cloud-data-server) and any per-app stacks are unblocked.

step "Clearing stale Pulumi locks in s3://${PULUMI_STATE_BUCKET}/.pulumi/locks/"
if aws s3api head-bucket --bucket "$PULUMI_STATE_BUCKET" 2>/dev/null; then
  LOCK_KEYS=$(aws s3api list-objects-v2 --bucket "$PULUMI_STATE_BUCKET" \
    --prefix ".pulumi/locks/" \
    --query 'Contents[].Key' --output text 2>/dev/null || true)
  if [[ -z "$LOCK_KEYS" || "$LOCK_KEYS" == "None" ]]; then
    echo "  No locks found."
  else
    for key in $LOCK_KEYS; do
      echo "  Removing: $key"
      aws s3api delete-object --bucket "$PULUMI_STATE_BUCKET" --key "$key" >/dev/null
    done
  fi
else
  skip
fi

# ── Step 2: API Gateway v2 ────────────────────────────────────────────────────

step "Deleting API Gateway: $GATEWAY_NAME"
API_ID=$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${GATEWAY_NAME}'].ApiId | [0]" \
  --output text 2>/dev/null || true)
if [[ -n "$API_ID" && "$API_ID" != "None" ]]; then
  aws apigatewayv2 delete-api --api-id "$API_ID"
  echo "  Deleted API Gateway $API_ID ($GATEWAY_NAME)."
else
  skip
fi

# ── Step 3: cloud-data-server Lambda + log group ──────────────────────────────

step "Deleting Lambda: $CDS_LAMBDA"
if aws lambda get-function --function-name "$CDS_LAMBDA" >/dev/null 2>&1; then
  aws lambda delete-function --function-name "$CDS_LAMBDA"
  echo "  Deleted."
else
  skip
fi

step "Deleting log group: $CDS_LOG_GROUP"
if aws logs describe-log-groups --log-group-name-prefix "$CDS_LOG_GROUP" \
    --query "logGroups[?logGroupName=='$CDS_LOG_GROUP'] | length(@)" \
    --output text 2>/dev/null | grep -q "^1$"; then
  aws logs delete-log-group --log-group-name "$CDS_LOG_GROUP"
  echo "  Deleted."
else
  skip
fi

# ── Step 4: DSQL cluster ──────────────────────────────────────────────────────

step "Deleting DSQL cluster (tagged starkeep:appId=cloud-data-server)"
CLUSTER_IDS=$(python3 - "$REGION" << 'PYEOF'
import subprocess, json, sys

region = sys.argv[1]
r = subprocess.run(
    ["aws", "dsql", "list-clusters", "--region", region, "--output", "json"],
    capture_output=True, text=True,
)
if r.returncode != 0:
    sys.exit(0)

for cluster in json.loads(r.stdout).get("clusters", []):
    arn = cluster.get("arn", "")
    cid = cluster.get("identifier") or arn.split("/")[-1]
    if not arn:
        continue
    tr = subprocess.run(
        ["aws", "dsql", "list-tags-for-resource", "--resource-arn", arn,
         "--region", region, "--output", "json"],
        capture_output=True, text=True,
    )
    if tr.returncode != 0:
        continue
    tags = json.loads(tr.stdout).get("tags", {})
    if tags.get("starkeep:appId") == "cloud-data-server":
        print(cid)
PYEOF
)

if [[ -z "$CLUSTER_IDS" ]]; then
  skip
else
  for CID in $CLUSTER_IDS; do
    echo "  Deleting cluster: $CID"
    aws dsql delete-cluster --identifier "$CID" --region "$REGION"
    echo "  Delete initiated (DSQL deletion is asynchronous)."
  done
fi

# ── Step 5: S3 files bucket ───────────────────────────────────────────────────

step "Emptying S3 files bucket: $FILES_BUCKET"
if aws s3api head-bucket --bucket "$FILES_BUCKET" 2>/dev/null; then
  aws s3api delete-bucket-policy --bucket "$FILES_BUCKET" 2>/dev/null || true
  empty_bucket "$FILES_BUCKET"
  aws s3api delete-bucket --bucket "$FILES_BUCKET" --region "$REGION"
  echo "  Deleted $FILES_BUCKET."
else
  skip
fi

# ── Step 6: S3 billing bucket ─────────────────────────────────────────────────

step "Emptying S3 billing bucket: $BILLING_BUCKET"
if aws s3api head-bucket --bucket "$BILLING_BUCKET" 2>/dev/null; then
  empty_bucket "$BILLING_BUCKET"
  aws s3api delete-bucket --bucket "$BILLING_BUCKET" --region "$REGION"
  echo "  Deleted $BILLING_BUCKET."
else
  skip
fi

# ── Step 7: CUR report ────────────────────────────────────────────────────────

step "Deleting CUR report: $CUR_REPORT"
if aws cur describe-report-definitions --region us-east-1 \
    --query "ReportDefinitions[?ReportName=='${CUR_REPORT}'] | length(@)" \
    --output text 2>/dev/null | grep -q "^1$"; then
  aws cur delete-report-definition --report-name "$CUR_REPORT" --region us-east-1
  echo "  Deleted."
else
  skip
fi

# ── Step 8: cloud-data-server IAM role ────────────────────────────────────────

delete_role "$CDS_ROLE"

echo ""
echo "Cloud-data-server teardown complete."
