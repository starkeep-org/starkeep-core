#!/usr/bin/env bash
# Tears down all Starkeep resources from AWS (apps → cloud-data-server → bootstrap).
#
# Calls teardown-cloud-data-server.sh first (which calls teardown-cloud-apps.sh),
# then removes the bootstrap layer: CloudFormation stack, Pulumi state bucket,
# SSM passphrase, Cognito pools, and IAM roles/policies.
#
# Handles what CloudFormation delete-stack misses:
#   - Versioned S3 bucket (CF can't delete non-empty buckets)
#   - Permissions boundary policies attached to roles outside the stack
#   - Any resources left in ROLLBACK_COMPLETE / partial-delete state
#
# Usage: ./teardown-bootstrap.sh [--yes|-y] [--prefix <stack-prefix>] [--region <region>]

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
USER_POOL_ID=""
IDENTITY_POOL_ID=""

if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_STACK_PREFIX=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('stackPrefix',''))" 2>/dev/null || true)
  USER_POOL_ID=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('userPoolId',''))" 2>/dev/null || true)
  IDENTITY_POOL_ID=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('identityPoolId',''))" 2>/dev/null || true)
fi

STACK_PREFIX="${FLAG_PREFIX:-$CONFIG_STACK_PREFIX}"
if [[ -z "$STACK_PREFIX" ]]; then
  echo "Error: stackPrefix not found in config and --prefix not provided."
  echo "Usage: $0 [--yes] --prefix <stack-prefix> --region <region>"
  exit 1
fi

STACK_NAME="${STACK_PREFIX}-bootstrap"

# Resolve region: flag > userPoolId prefix > AWS config
if [[ -n "$FLAG_REGION" ]]; then
  REGION="$FLAG_REGION"
elif [[ -n "$USER_POOL_ID" ]]; then
  REGION="${USER_POOL_ID%%_*}"
elif [[ -n "${AWS_DEFAULT_REGION:-}" ]]; then
  REGION="$AWS_DEFAULT_REGION"
elif [[ -n "${AWS_REGION:-}" ]]; then
  REGION="$AWS_REGION"
elif REGION=$(aws configure get region 2>/dev/null) && [[ -n "$REGION" ]]; then
  : # got it
else
  echo "Error: cannot determine region. Supply --region <region> or set AWS_DEFAULT_REGION."
  exit 1
fi

# Pin every aws subcommand below to the resolved region. The CLI's default
# region (from ~/.aws/config) may differ from the starkeep config region, and
# a mismatch silently targets the wrong region.
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="${STACK_PREFIX}-pulumi-state-${ACCOUNT_ID}-${REGION}"
ARTIFACTS_BUCKET="${STACK_PREFIX}-artifacts-${ACCOUNT_ID}-${REGION}"
SSM_PARAM="/${STACK_PREFIX}/pulumi/passphrase"

# ── Confirmation ────────────────────────────────────────────────────────────
echo ""
echo "This will permanently destroy ALL Starkeep resources in AWS:"
echo ""
echo "  Phase 1 — apps         : all installed apps (photos, etc.)"
echo "  Phase 2 — cloud-data-server: Lambda, API Gateway, DSQL, S3 app buckets, CUR"
echo "  Phase 3 — bootstrap    :"
echo "    CloudFormation stack : $STACK_NAME  (region: $REGION)"
echo "    S3 bucket            : $BUCKET"
echo "    S3 bucket            : $ARTIFACTS_BUCKET"
echo "    SSM parameter        : $SSM_PARAM"
echo "    IAM role             : ${STACK_PREFIX}-app-admin-role"
echo "    IAM role             : ${STACK_PREFIX}-manager-role"
echo "    IAM role             : ${STACK_PREFIX}-install-ddl-role"
echo "    IAM role             : ${STACK_PREFIX}-install-infra-role"
echo "    IAM policy           : ${STACK_PREFIX}-app-permissions-boundary"
echo "    IAM policy           : ${STACK_PREFIX}-foundational-permissions-boundary"
echo "    IAM policy           : ${STACK_PREFIX}-install-ddl-permissions-boundary"
echo "    IAM policy           : ${STACK_PREFIX}-install-infra-permissions-boundary"
[[ -n "$USER_POOL_ID" ]]      && echo "    Cognito User Pool    : $USER_POOL_ID"
[[ -n "$IDENTITY_POOL_ID" ]]  && echo "    Cognito Identity Pool: $IDENTITY_POOL_ID"
echo ""
echo "After all resources are deleted, $CONFIG_FILE will be reset to {}."
echo ""

if [[ "$YES" != "true" ]]; then
  read -r -p "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── Phase 1 + 2: Cloud apps and cloud-data-server ────────────────────────────
echo ""
echo ">>> Running teardown-cloud-data-server.sh (phases 1–2: apps, then cloud-data-server)..."
"$SCRIPT_DIR/teardown-cloud-data-server.sh" --yes --prefix "$STACK_PREFIX" --region "$REGION"

# ── Helpers ──────────────────────────────────────────────────────────────────

step() { echo ""; echo "==> $*"; }
skip() { echo "  Not found, skipping."; }

# Empties a versioned S3 bucket by deleting all versions and delete markers.
empty_versioned_bucket() {
  local bucket="$1"
  python3 << PYEOF
import json, os, subprocess, sys, tempfile

bucket = "$bucket"

def aws_json(*args):
    r = subprocess.run(["aws"] + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return json.loads(r.stdout) if r.stdout.strip() else {}

def delete_batch(objs):
    """Batch-delete up to 1000 objects in one call.

    The payload is written to a temp file and passed as --delete file://...,
    not as an inline JSON argument. Inline JSON is what produced the
    'MalformedXML' errors (shell/CLI mangling of the argument); file:// hands
    the bytes to the CLI verbatim. S3's delete-objects also caps each call at
    1000 keys, so callers must chunk to that limit."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"Objects": objs, "Quiet": True}, f)
        path = f.name
    try:
        r = subprocess.run(
            ["aws", "s3api", "delete-objects", "--bucket", bucket,
             "--delete", "file://" + path],
            capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip())
    finally:
        os.unlink(path)

deleted = 0
while True:
    data = aws_json("s3api", "list-object-versions", "--bucket", bucket,
                    "--max-items", "1000", "--output", "json")
    objs = [{"Key": o["Key"], "VersionId": o["VersionId"]}
            for o in data.get("Versions", []) + data.get("DeleteMarkers", [])]
    if not objs:
        break
    for i in range(0, len(objs), 1000):
        delete_batch(objs[i:i + 1000])
    deleted += len(objs)
    print(f"  Deleted {deleted} versions/markers so far...", flush=True)

print("  Bucket empty." if deleted == 0 else f"  Emptied {deleted} total versions/markers.")
PYEOF
}

delete_role() {
  local role_name="$1"
  step "Cleaning up IAM role: $role_name"
  if ! aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    skip; return
  fi

  # Remove permissions boundary
  aws iam delete-role-permissions-boundary --role-name "$role_name" 2>/dev/null || true

  # Detach managed policies
  local arns
  arns=$(aws iam list-attached-role-policies --role-name "$role_name" \
    --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null || true)
  for arn in $arns; do
    echo "  Detaching: $arn"
    aws iam detach-role-policy --role-name "$role_name" --policy-arn "$arn" || true
  done

  # Delete inline policies
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

delete_managed_policy() {
  local policy_name="$1"
  local policy_arn="arn:aws:iam::${ACCOUNT_ID}:policy/${policy_name}"
  step "Cleaning up IAM managed policy: $policy_name"
  if ! aws iam get-policy --policy-arn "$policy_arn" >/dev/null 2>&1; then
    skip; return
  fi

  # Detach from all roles using it as an attached policy.
  # Also remove it as a permissions boundary on those same roles — a role can
  # hold the same policy in both positions simultaneously (e.g. cloud-data-server-role).
  local attached_roles
  attached_roles=$(aws iam list-entities-for-policy --policy-arn "$policy_arn" \
    --entity-filter Role --query 'PolicyRoles[].RoleName' --output text 2>/dev/null || true)
  for role in $attached_roles; do
    echo "  Detaching from role: $role"
    aws iam detach-role-policy --role-name "$role" --policy-arn "$policy_arn" 2>/dev/null || true
    aws iam delete-role-permissions-boundary --role-name "$role" 2>/dev/null || true
  done

  # Also scan for roles that use this policy *only* as a permissions boundary
  # (not attached). Use Python3 to paginate through all roles — aws iam list-roles
  # --query filters per-page and silently misses roles on later pages.
  local boundary_only_roles
  boundary_only_roles=$(python3 - "$policy_arn" << 'PYEOF'
import subprocess, json, sys
policy_arn = sys.argv[1]
marker = None
while True:
    cmd = ["aws", "iam", "list-roles", "--output", "json"]
    if marker:
        cmd += ["--starting-token", marker]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        break
    data = json.loads(r.stdout)
    for role in data.get("Roles", []):
        if role.get("PermissionsBoundary", {}).get("PermissionsBoundaryArn") == policy_arn:
            print(role["RoleName"])
    marker = data.get("Marker")
    if not marker:
        break
PYEOF
  )
  for role in $boundary_only_roles; do
    echo "  Removing boundary from role: $role"
    aws iam delete-role-permissions-boundary --role-name "$role" 2>/dev/null || true
  done

  # Delete non-default versions before deleting the policy
  local versions
  versions=$(aws iam list-policy-versions --policy-arn "$policy_arn" \
    --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null || true)
  for ver in $versions; do
    aws iam delete-policy-version --policy-arn "$policy_arn" --version-id "$ver" || true
  done

  aws iam delete-policy --policy-arn "$policy_arn"
  echo "  Deleted."
}

# ── Step 1: Empty S3 buckets ──────────────────────────────────────────────────
step "Emptying S3 bucket: $BUCKET"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  empty_versioned_bucket "$BUCKET"
else
  skip
fi

step "Emptying S3 bucket: $ARTIFACTS_BUCKET"
if aws s3api head-bucket --bucket "$ARTIFACTS_BUCKET" 2>/dev/null; then
  empty_versioned_bucket "$ARTIFACTS_BUCKET"
else
  skip
fi

# ── Step 2: Delete SSM parameter ─────────────────────────────────────────────
step "Deleting SSM parameter: $SSM_PARAM"
if aws ssm get-parameter --name "$SSM_PARAM" --region "$REGION" >/dev/null 2>&1; then
  aws ssm delete-parameter --name "$SSM_PARAM" --region "$REGION"
  echo "  Deleted."
else
  skip
fi

# ── Step 2a: Delete per-app HMAC credential parameters ───────────────────────
# Each cloud-installed app has a /${STACK_PREFIX}/app-creds/${appId}
# SecureString written by the installer (see admin-installer/src/app-creds.ts).
# Normal uninstall removes these per-app; the sweep here catches any left
# behind by an interrupted run so a re-bootstrap starts clean.
APP_CREDS_PREFIX="/${STACK_PREFIX}/app-creds/"
step "Deleting per-app SSM credential parameters under $APP_CREDS_PREFIX"
APP_CREDS_NAMES=$(aws ssm get-parameters-by-path \
  --path "$APP_CREDS_PREFIX" \
  --recursive \
  --region "$REGION" \
  --query 'Parameters[].Name' \
  --output text 2>/dev/null || true)
if [ -n "$APP_CREDS_NAMES" ] && [ "$APP_CREDS_NAMES" != "None" ]; then
  for name in $APP_CREDS_NAMES; do
    aws ssm delete-parameter --name "$name" --region "$REGION" 2>/dev/null \
      && echo "  Deleted $name" \
      || echo "  Could not delete $name (continuing)"
  done
else
  skip
fi

# ── Step 3: Delete IAM roles and policies manually ───────────────────────────
# Done before CF deletion so CF never races against us or gets stuck on
# dependency errors (e.g. can't delete a policy while a role holds it as a
# permissions boundary).
delete_role "${STACK_PREFIX}-app-admin-role"
delete_role "${STACK_PREFIX}-manager-role"
delete_role "${STACK_PREFIX}-install-ddl-role"
delete_role "${STACK_PREFIX}-install-infra-role"
delete_managed_policy "${STACK_PREFIX}-app-permissions-boundary"
delete_managed_policy "${STACK_PREFIX}-foundational-permissions-boundary"
delete_managed_policy "${STACK_PREFIX}-install-ddl-permissions-boundary"
delete_managed_policy "${STACK_PREFIX}-install-infra-permissions-boundary"

# ── Step 4: Delete CloudFormation stack ──────────────────────────────────────
# All resources that CF would trip over are already gone; this is fast and
# should succeed cleanly.
step "Deleting CloudFormation stack: $STACK_NAME"
if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
  echo "  Waiting for stack deletion (this may take a few minutes)..."
  if aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION" 2>/dev/null; then
    echo "  Stack deleted."
  else
    echo "  WARNING: stack-delete-complete timed out or failed — Cognito and S3 cleanup will still proceed."
  fi
else
  skip
fi

# Delete the buckets themselves (should be empty by now). CF stack deletion
# normally removes them, but if the stack was in CREATE_FAILED / ROLLBACK state
# the bucket may have been orphaned from the stack — handle that here.
step "Deleting S3 bucket: $BUCKET"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
  echo "  Deleted."
else
  skip
fi

step "Deleting S3 bucket: $ARTIFACTS_BUCKET"
if aws s3api head-bucket --bucket "$ARTIFACTS_BUCKET" 2>/dev/null; then
  aws s3api delete-bucket --bucket "$ARTIFACTS_BUCKET" --region "$REGION"
  echo "  Deleted."
else
  skip
fi

# Delete Cognito resources using IDs from config (CF may not have removed them)
if [[ -n "$IDENTITY_POOL_ID" ]]; then
  step "Deleting Cognito Identity Pool: $IDENTITY_POOL_ID"
  if aws cognito-identity delete-identity-pool \
      --identity-pool-id "$IDENTITY_POOL_ID" --region "$REGION" 2>/dev/null; then
    echo "  Deleted."
  else
    echo "  Not found or already deleted."
  fi
fi

if [[ -n "$USER_POOL_ID" ]]; then
  step "Deleting Cognito User Pool: $USER_POOL_ID"
  # Must disable deletion protection before deleting
  aws cognito-idp update-user-pool --user-pool-id "$USER_POOL_ID" \
    --deletion-protection INACTIVE --region "$REGION" 2>/dev/null || true
  if aws cognito-idp delete-user-pool \
      --user-pool-id "$USER_POOL_ID" --region "$REGION" 2>/dev/null; then
    echo "  Deleted."
  else
    echo "  Not found or already deleted."
  fi
fi

# ── Step 6: Reset config ──────────────────────────────────────────────────────
step "Resetting $CONFIG_FILE"
python3 -c "
import json
with open('$CONFIG_FILE', 'w') as f:
    json.dump({}, f, indent=2)
    f.write('\n')
"
echo "  Config reset to {}."

echo ""
echo "Bootstrap teardown complete."
