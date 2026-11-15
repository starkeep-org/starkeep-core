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
# --force disables DSQL deletion protection so a protected cloud-data-server
# cluster can actually be removed (threaded through to
# teardown-cloud-data-server.sh, which runs unattended here).
#
# Usage: ./teardown-bootstrap.sh [--yes|-y] [--force] --prefix <stack-prefix> --region <region>
#
# --prefix and --region are both required: together they scope the teardown to
# one deployment in one place, and neither is ever inferred from config. A
# config-derived or CLI-default region can silently point at the wrong region
# (e.g. the test suite deploys to us-east-2 while the AWS CLI default is
# us-east-1), which skips the real resources and reports success. If either is
# omitted in an interactive shell you'll be prompted for it; an unattended run
# (--yes or no TTY) missing either errors out.
#
# Local config (STARKEEP_DIR/config.json): the cloud config is cleared only when
# it actually describes the deployment being torn down — i.e. its stackPrefix and
# region match --prefix/--region. Any other config belongs to some other
# deployment (typically the operator's real one under the default
# $HOME/.starkeep, whose resources are all still live) and is left untouched.
# Clearing removes only cloud state; the local 'appParentDirs' setting is always
# preserved.
#
# Cognito pools: the script finds the pools to delete from the target stack's
# own resources, and by the names and tags the bootstrap template gives them
# (<prefix>-auth tagged StackPrefix=<prefix>, and <prefix>_admin). It never
# takes a pool ID from the config, because the config may describe another
# deployment. It also refuses to touch a pool that the config names unless the
# config matches the target.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Honor repo-root .env / .env.local before the explicit-vs-default check below, so
# a STARKEEP_DIR provided via .env.local correctly counts as "explicit" (and thus
# this deployment's config gets cleared).
source "$SCRIPT_DIR/load-env.sh"

STARKEEP_DIR="${STARKEEP_DIR:-$HOME/.starkeep}"
CONFIG_FILE="$STARKEEP_DIR/config.json"

# ── Parse flags ───────────────────────────────────────────────────────────────

YES=false
FORCE=false
FLAG_PREFIX=""
FLAG_REGION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=true; shift ;;
    --force) FORCE=true; shift ;;
    --prefix) FLAG_PREFIX="$2"; shift 2 ;;
    --region) FLAG_REGION="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# ── Load config ───────────────────────────────────────────────────────────────

# The config's pool IDs serve two purposes only: the user pool ID stands in for
# the config's region, and both IDs mark pools that a teardown of another
# deployment must never touch. Neither ID selects a pool to delete.
CONFIG_STACK_PREFIX=""
CONFIG_USER_POOL_ID=""
CONFIG_IDENTITY_POOL_ID=""

if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_STACK_PREFIX=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('stackPrefix',''))" 2>/dev/null || true)
  CONFIG_USER_POOL_ID=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('userPoolId',''))" 2>/dev/null || true)
  CONFIG_IDENTITY_POOL_ID=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('identityPoolId',''))" 2>/dev/null || true)
fi

# The stack prefix is the only thing that scopes a teardown to a single
# deployment, so we never infer it silently from config — an unqualified run
# would otherwise delete whichever deployment the ambient
# ~/.starkeep/config.json happens to describe (typically the real one). It
# must be passed via --prefix, or entered at an interactive prompt.
STACK_PREFIX="$FLAG_PREFIX"
if [[ -z "$STACK_PREFIX" ]]; then
  if [[ "$YES" != "true" && -t 0 ]]; then
    if [[ -n "$CONFIG_STACK_PREFIX" ]]; then
      echo "No --prefix given. (For reference, $CONFIG_FILE describes prefix '$CONFIG_STACK_PREFIX'.)" >&2
    fi
    read -r -p "Enter the stack prefix to tear down: " STACK_PREFIX
  fi
  if [[ -z "$STACK_PREFIX" ]]; then
    echo "Error: a stack prefix is required; pass --prefix <stack-prefix>." >&2
    echo "Usage: $0 [--yes] --prefix <stack-prefix> --region <region>" >&2
    exit 1
  fi
fi

STACK_NAME="${STACK_PREFIX}-bootstrap"

# Region, like the prefix, scopes a teardown to one place and is never inferred
# silently: a config-derived or CLI-default region can point at the wrong place
# (e.g. the test suite deploys to us-east-2 while the AWS CLI default is
# us-east-1), which would skip the real resources and falsely report success.
# It must be passed via --region, or entered at an interactive prompt.
CONFIG_REGION="${CONFIG_USER_POOL_ID%%_*}"
REGION="$FLAG_REGION"
if [[ -z "$REGION" ]]; then
  if [[ "$YES" != "true" && -t 0 ]]; then
    if [[ -n "$CONFIG_REGION" ]]; then
      echo "No --region given. (For reference, $CONFIG_FILE describes region '$CONFIG_REGION'.)" >&2
    fi
    read -r -p "Enter the region to tear down: " REGION
  fi
  if [[ -z "$REGION" ]]; then
    echo "Error: a region is required; pass --region <region>." >&2
    echo "Usage: $0 [--yes] --prefix <stack-prefix> --region <region>" >&2
    exit 1
  fi
fi

# Does $CONFIG_FILE describe the deployment being torn down? Step 6 clears its
# cloud state, which is only correct for *this* deployment's config. The target
# comes from --prefix/--region while the config is whatever STARKEEP_DIR
# (default $HOME/.starkeep) points at — so tearing down a test stack must not
# blank the real deployment's config. Both scoping keys must match first; the
# config carries no region key, but userPoolId is region-prefixed
# (us-east-1_xxxx) and stands in for one. A config missing either key can't be
# shown to match, so it's left alone. Mirrors the same check in
# teardown-cloud-data-server.sh, which clears the cloud-data-server subset.
CONFIG_MATCHES_TEARDOWN=false
if [[ -n "$CONFIG_STACK_PREFIX" && "$CONFIG_STACK_PREFIX" == "$STACK_PREFIX" \
      && -n "$CONFIG_REGION" && "$CONFIG_REGION" == "$REGION" ]]; then
  CONFIG_MATCHES_TEARDOWN=true
fi

# Pin every aws subcommand below to the resolved region. The CLI's default
# region (from ~/.aws/config) may differ from the starkeep config region, and
# a mismatch silently targets the wrong region.
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="${STACK_PREFIX}-pulumi-state-${ACCOUNT_ID}-${REGION}"
ARTIFACTS_BUCKET="${STACK_PREFIX}-artifacts-${ACCOUNT_ID}-${REGION}"
APP_ASSETS_BUCKET="${STACK_PREFIX}-app-assets-${ACCOUNT_ID}-${REGION}"
SSM_PARAM="/${STACK_PREFIX}/pulumi/passphrase"

# ── Find this deployment's Cognito pools ─────────────────────────────────────
# Read before the stack deletion below, because the stack's resource list goes
# away with the stack. The name lookups find pools that a failed or partial
# stack deletion left behind. Each list is space-separated (bash 3.2 has no
# associative arrays) and holds each ID once.

USER_POOL_IDS=""
IDENTITY_POOL_IDS=""

add_id() {  # add_id <list> <id>: print <list> with <id> appended once
  local list="$1" id="$2"
  if [[ -z "$id" || "$id" == "None" ]]; then printf '%s' "$list"; return; fi
  case " $list " in
    *" $id "*) printf '%s' "$list" ;;
    *) printf '%s' "${list:+$list }$id" ;;
  esac
}

stack_resource_id() {  # stack_resource_id <logical-id>
  aws cloudformation describe-stack-resource --stack-name "$STACK_NAME" \
    --logical-resource-id "$1" \
    --query 'StackResourceDetail.PhysicalResourceId' --output text 2>/dev/null || true
}

# A user pool counts as this deployment's only when the bootstrap template's
# StackPrefix tag names this prefix, whatever source named the pool.
user_pool_is_ours() {  # user_pool_is_ours <user-pool-id>
  local tag
  tag=$(aws cognito-idp describe-user-pool --user-pool-id "$1" \
    --query 'UserPool.UserPoolTags.StackPrefix' --output text 2>/dev/null || true)
  [[ "$tag" == "$STACK_PREFIX" ]]
}

CANDIDATE_USER_POOLS=$(stack_resource_id UserPool)
for id in $(aws cognito-idp list-user-pools --max-results 60 \
    --query "UserPools[?Name=='${STACK_PREFIX}-auth'].Id" --output text 2>/dev/null || true); do
  CANDIDATE_USER_POOLS=$(add_id "$CANDIDATE_USER_POOLS" "$id")
done
for id in $CANDIDATE_USER_POOLS; do
  if user_pool_is_ours "$id"; then
    USER_POOL_IDS=$(add_id "$USER_POOL_IDS" "$id")
  fi
done

IDENTITY_POOL_IDS=$(add_id "" "$(stack_resource_id IdentityPool)")
for id in $(aws cognito-identity list-identity-pools --max-results 60 \
    --query "IdentityPools[?IdentityPoolName=='${STACK_PREFIX}_admin'].IdentityPoolId" --output text 2>/dev/null || true); do
  IDENTITY_POOL_IDS=$(add_id "$IDENTITY_POOL_IDS" "$id")
done

# A config for another deployment names pools that must survive this teardown.
# Reaching one here means the stack or a name lookup points at the other
# deployment's pool, so the script stops before it deletes anything.
if [[ "$CONFIG_MATCHES_TEARDOWN" != "true" ]]; then
  for id in $USER_POOL_IDS $IDENTITY_POOL_IDS; do
    if [[ "$id" == "$CONFIG_USER_POOL_ID" || "$id" == "$CONFIG_IDENTITY_POOL_ID" ]]; then
      echo "Error: Cognito pool $id belongs to the deployment that $CONFIG_FILE" >&2
      echo "describes (prefix '${CONFIG_STACK_PREFIX:-<none>}'), not to ${STACK_PREFIX}/${REGION}." >&2
      echo "Nothing was deleted." >&2
      exit 1
    fi
  done
fi

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
echo "    S3 bucket            : $APP_ASSETS_BUCKET"
echo "    SSM parameter        : $SSM_PARAM"
echo "    IAM role             : ${STACK_PREFIX}-app-admin-role"
echo "    IAM role             : ${STACK_PREFIX}-manager-role"
echo "    IAM role             : ${STACK_PREFIX}-install-ddl-role"
echo "    IAM role             : ${STACK_PREFIX}-install-infra-role"
echo "    IAM policy           : ${STACK_PREFIX}-app-permissions-boundary"
echo "    IAM policy           : ${STACK_PREFIX}-foundational-permissions-boundary"
echo "    IAM policy           : ${STACK_PREFIX}-install-ddl-permissions-boundary"
echo "    IAM policy           : ${STACK_PREFIX}-install-infra-permissions-boundary"
for id in $USER_POOL_IDS; do echo "    Cognito User Pool    : $id"; done
for id in $IDENTITY_POOL_IDS; do echo "    Cognito Identity Pool: $id"; done
echo ""
if [[ "$CONFIG_MATCHES_TEARDOWN" == "true" ]]; then
  echo "After all resources are deleted, the cloud config in $CONFIG_FILE will be"
  echo "cleared (the local 'appParentDirs' setting is preserved)."
else
  echo "$CONFIG_FILE will be left UNTOUCHED — it describes prefix"
  echo "'${CONFIG_STACK_PREFIX:-<none>}' / region '${CONFIG_REGION:-<none>}', not the deployment being torn down."
fi
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
# Thread --force through: bootstrap teardown runs CDS teardown unattended
# (--yes), so a deletion-protected DSQL cluster would be skipped unless the
# operator opted in with --force here too.
# Plain string (not an array): macOS ships bash 3.2, where expanding an empty
# array under `set -u` errors. --force has no spaces, so unquoted is safe.
CDS_FORCE_FLAG=""
[[ "$FORCE" == "true" ]] && CDS_FORCE_FLAG="--force"
"$SCRIPT_DIR/teardown-cloud-data-server.sh" --yes $CDS_FORCE_FLAG --prefix "$STACK_PREFIX" --region "$REGION"

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

# Unversioned, which the helper handles: S3 lists each object once, with the
# version id "null".
step "Emptying S3 bucket: $APP_ASSETS_BUCKET"
if aws s3api head-bucket --bucket "$APP_ASSETS_BUCKET" 2>/dev/null; then
  empty_versioned_bucket "$APP_ASSETS_BUCKET"
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

# ── Step 2b: Delete the platform's own parameters ────────────────────────────
# The deployment's settings (/${STACK_PREFIX}/platform/deployment-settings),
# written by admin-web through Manager, and any device records a deployment kept
# from before pairing was retired. Nothing uninstalls these, so the sweep is the
# only thing that removes them.
PLATFORM_PREFIX="/${STACK_PREFIX}/platform/"
step "Deleting platform SSM parameters under $PLATFORM_PREFIX"
PLATFORM_NAMES=$(aws ssm get-parameters-by-path \
  --path "$PLATFORM_PREFIX" \
  --recursive \
  --region "$REGION" \
  --query 'Parameters[].Name' \
  --output text 2>/dev/null || true)
if [ -n "$PLATFORM_NAMES" ] && [ "$PLATFORM_NAMES" != "None" ]; then
  for name in $PLATFORM_NAMES; do
    aws ssm delete-parameter --name "$name" --region "$REGION" 2>/dev/null \
      && echo "  Deleted $name" \
      || echo "  Could not delete $name (continuing)"
  done
else
  skip
fi

# ── Step 2c: Delete custom-domain certificates ───────────────────────────────
# teardown-cloud-data-server.sh above deletes every certificate tagged with the
# prefix after it deletes the distribution, which releases each one at once.
# This step deletes any certificate an earlier, failed run left. CloudFront
# takes certificates only from us-east-1, so they live there whatever $REGION
# is. Each delete runs once: a certificate still in use means a distribution
# still holds it, and the script names the distribution and fails at the end.
step "Deleting custom-domain certificates tagged starkeep:stackPrefix=${STACK_PREFIX} (us-east-1)"
CERT_ARNS=$(aws acm list-certificates --region us-east-1 \
  --certificate-statuses PENDING_VALIDATION ISSUED INACTIVE EXPIRED VALIDATION_TIMED_OUT REVOKED FAILED \
  --query 'CertificateSummaryList[].CertificateArn' --output text 2>/dev/null || true)
CERTS_DELETED=false
CERT_FAILURES=()
if [ -n "$CERT_ARNS" ] && [ "$CERT_ARNS" != "None" ]; then
  for arn in $CERT_ARNS; do
    owner=$(aws acm list-tags-for-certificate --region us-east-1 --certificate-arn "$arn" \
      --query "Tags[?Key=='starkeep:stackPrefix'].Value | [0]" --output text 2>/dev/null || true)
    [ "$owner" = "$STACK_PREFIX" ] || continue
    CERTS_DELETED=true
    if err=$(aws acm delete-certificate --region us-east-1 --certificate-arn "$arn" 2>&1); then
      echo "  Deleted $arn"
      continue
    fi
    holders=$(aws acm describe-certificate --region us-east-1 --certificate-arn "$arn" \
      --query 'Certificate.InUseBy[]' --output text 2>/dev/null || true)
    if [ -n "$holders" ] && [ "$holders" != "None" ]; then
      echo "  ERROR $arn is in use by $holders; run teardown-cloud-data-server.sh, then this script again"
    else
      echo "  ERROR could not delete $arn: $err"
    fi
    CERT_FAILURES+=("$arn")
  done
fi
[ "$CERTS_DELETED" = true ] || skip

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

step "Deleting S3 bucket: $APP_ASSETS_BUCKET"
if aws s3api head-bucket --bucket "$APP_ASSETS_BUCKET" 2>/dev/null; then
  aws s3api delete-bucket --bucket "$APP_ASSETS_BUCKET" --region "$REGION"
  echo "  Deleted."
else
  skip
fi

# Delete the Cognito pools found above. The stack deletion normally removes
# them; this sweep catches pools a failed or partial deletion left behind. A
# missing pool counts as deleted. Any other failure, such as a user pool that
# still has a domain, names the pool and fails the script at the end, like the
# certificate step.
COGNITO_FAILURES=()

report_pool_delete_failure() {  # report_pool_delete_failure <pool-id> <error>
  if [[ "$2" == *ResourceNotFoundException* ]]; then
    echo "  Not found or already deleted."
  else
    echo "  ERROR could not delete $1: $2"
    COGNITO_FAILURES+=("$1")
  fi
}

for id in $IDENTITY_POOL_IDS; do
  step "Deleting Cognito Identity Pool: $id"
  if err=$(aws cognito-identity delete-identity-pool \
      --identity-pool-id "$id" --region "$REGION" 2>&1); then
    echo "  Deleted."
  else
    report_pool_delete_failure "$id" "$err"
  fi
done

for id in $USER_POOL_IDS; do
  step "Deleting Cognito User Pool: $id"
  # UpdateUserPool resets every setting the call omits to its default, so the
  # script turns deletion protection off only when it is on. The template
  # never turns it on.
  protection=$(aws cognito-idp describe-user-pool --user-pool-id "$id" --region "$REGION" \
    --query 'UserPool.DeletionProtection' --output text 2>/dev/null || true)
  if [[ "$protection" == "ACTIVE" ]]; then
    aws cognito-idp update-user-pool --user-pool-id "$id" \
      --deletion-protection INACTIVE --region "$REGION" 2>/dev/null || true
  fi
  if err=$(aws cognito-idp delete-user-pool \
      --user-pool-id "$id" --region "$REGION" 2>&1); then
    echo "  Deleted."
  else
    report_pool_delete_failure "$id" "$err"
  fi
done

# ── Step 6: Clear cloud config ────────────────────────────────────────────────
# Only a config whose prefix+region match the teardown target describes the
# deployment we just destroyed (see CONFIG_MATCHES_TEARDOWN above). Any other
# one we leave alone: the default $HOME/.starkeep config usually describes the
# real deployment, and blanking it after tearing down some other prefix/region
# would strand a working install.
#
# Even when we do clear it, this removes only the *cloud* state. 'appParentDirs'
# is a purely local concern (where apps live on disk) and survives a cloud
# teardown.
if [[ "$CONFIG_MATCHES_TEARDOWN" == "true" ]]; then
  step "Clearing cloud config in $CONFIG_FILE (preserving local appParentDirs)"
  python3 -c "
import json, os
path = '$CONFIG_FILE'
try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, ValueError):
    cfg = {}
LOCAL_KEYS = ('appParentDirs',)
preserved = {k: cfg[k] for k in LOCAL_KEYS if k in cfg}
with open(path, 'w') as f:
    json.dump(preserved, f, indent=2)
    f.write('\n')
"
  echo "  Cloud config cleared; local appParentDirs preserved."
else
  step "Leaving $CONFIG_FILE untouched (describes prefix '${CONFIG_STACK_PREFIX:-<none>}' / region '${CONFIG_REGION:-<none>}', not ${STACK_PREFIX}/${REGION})"
  echo "  It belongs to a different deployment, so its cloud state was not"
  echo "  cleared. Point STARKEEP_DIR at this deployment's config dir if you"
  echo "  expected it to be."
fi

echo ""
if [ "${#CERT_FAILURES[@]}" -gt 0 ]; then
  echo "Bootstrap teardown finished, but these certificates could not be deleted:"
  printf '  %s\n' "${CERT_FAILURES[@]}"
fi
if [ "${#COGNITO_FAILURES[@]}" -gt 0 ]; then
  echo "Bootstrap teardown finished, but these Cognito pools could not be deleted:"
  printf '  %s\n' "${COGNITO_FAILURES[@]}"
fi
if [ "${#CERT_FAILURES[@]}" -gt 0 ] || [ "${#COGNITO_FAILURES[@]}" -gt 0 ]; then
  exit 1
fi
echo "Bootstrap teardown complete."
