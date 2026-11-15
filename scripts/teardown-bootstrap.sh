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
# Usage: ./teardown-bootstrap.sh [--yes|-y] [--force] [--dry-run] --prefix <stack-prefix> --region <region>
#
# --dry-run prints the resources the teardown would delete, including the lists
# from teardown-cloud-data-server.sh and teardown-cloud-apps.sh, then exits
# without deleting anything.
#
# A failed AWS call does not stop the bootstrap layer's teardown. The script
# lists each failure at the end and exits 1. A resource that is already gone is
# not a failure. A failure in teardown-cloud-data-server.sh stops this script
# before it deletes the bootstrap layer.
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
# deployment. It also refuses to touch a pool that a config for another
# deployment names, and it checks at the end that each such pool still exists.
# A pool that existed at the start and is gone fails the run. Two configs
# count: $STARKEEP_DIR/config.json and the default $HOME/.starkeep/config.json.
# The second matters when STARKEEP_DIR names the target's own config, as in the
# e2e harness, while the default config describes the live deployment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Honor repo-root .env / .env.local before the explicit-vs-default check below, so
# a STARKEEP_DIR provided via .env.local correctly counts as "explicit" (and thus
# this deployment's config gets cleared).
source "$SCRIPT_DIR/load-env.sh"
source "$SCRIPT_DIR/teardown-common.sh"

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
    --dry-run) DRY_RUN=true; shift ;;
    --prefix) FLAG_PREFIX="$2"; shift 2 ;;
    --region) FLAG_REGION="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# ── Load config ───────────────────────────────────────────────────────────────

# Config pool IDs serve two purposes only: the user pool ID stands in for the
# config's region, and both IDs mark pools that a teardown of another
# deployment must never touch (see protect_config_pools below). Neither ID
# selects a pool to delete.
CONFIG_STACK_PREFIX=""
CONFIG_USER_POOL_ID=""

if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_STACK_PREFIX=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('stackPrefix',''))" 2>/dev/null || true)
  CONFIG_USER_POOL_ID=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('userPoolId',''))" 2>/dev/null || true)
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
  aws_call cloudformation describe-stack-resource --stack-name "$STACK_NAME" \
    --logical-resource-id "$1" \
    --query 'StackResourceDetail.PhysicalResourceId' --output text || true
}

# A user pool counts as this deployment's only when the bootstrap template's
# StackPrefix tag names this prefix, whatever source named the pool.
user_pool_is_ours() {  # user_pool_is_ours <user-pool-id>
  local tag
  tag=$(aws_call cognito-idp describe-user-pool --user-pool-id "$1" \
    --query 'UserPool.UserPoolTags.StackPrefix' --output text) || true
  [[ "$tag" == "$STACK_PREFIX" ]]
}

CANDIDATE_USER_POOLS=$(stack_resource_id UserPool)
for id in $(aws_call cognito-idp list-user-pools --max-results 60 \
    --query "UserPools[?Name=='${STACK_PREFIX}-auth'].Id" --output text || true); do
  CANDIDATE_USER_POOLS=$(add_id "$CANDIDATE_USER_POOLS" "$id")
done
for id in $CANDIDATE_USER_POOLS; do
  if user_pool_is_ours "$id"; then
    USER_POOL_IDS=$(add_id "$USER_POOL_IDS" "$id")
  fi
done

IDENTITY_POOL_IDS=$(add_id "" "$(stack_resource_id IdentityPool)")
for id in $(aws_call cognito-identity list-identity-pools --max-results 60 \
    --query "IdentityPools[?IdentityPoolName=='${STACK_PREFIX}_admin'].IdentityPoolId" --output text || true); do
  IDENTITY_POOL_IDS=$(add_id "$IDENTITY_POOL_IDS" "$id")
done

# Pools that must survive this teardown: those that a config for another
# deployment names. Two configs count. The first is $CONFIG_FILE. The second is
# the default $HOME/.starkeep/config.json, because the e2e harness and its
# printed cleanup command point STARKEEP_DIR at the run's own config, while the
# operator's live deployment stays described at the default path. Each line is
# "<user|identity>\t<pool-id>\t<config-file>\t<config-prefix>".
PROTECTED_POOLS=""
protect_config_pools() {  # protect_config_pools <config-file>
  local file="$1" prefix user identity
  [[ -f "$file" ]] || return 0
  prefix=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('stackPrefix',''))" "$file" 2>/dev/null || true)
  user=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('userPoolId',''))" "$file" 2>/dev/null || true)
  identity=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('identityPoolId',''))" "$file" 2>/dev/null || true)
  # A config that describes the target names the pools this teardown deletes.
  if [[ -n "$prefix" && "$prefix" == "$STACK_PREFIX" && "${user%%_*}" == "$REGION" ]]; then
    return 0
  fi
  if [[ -n "$user" ]]; then PROTECTED_POOLS+="user"$'\t'"$user"$'\t'"$file"$'\t'"$prefix"$'\n'; fi
  if [[ -n "$identity" ]]; then PROTECTED_POOLS+="identity"$'\t'"$identity"$'\t'"$file"$'\t'"$prefix"$'\n'; fi
}
DEFAULT_CONFIG_FILE="$HOME/.starkeep/config.json"
protect_config_pools "$CONFIG_FILE"
if [[ "$DEFAULT_CONFIG_FILE" != "$CONFIG_FILE" ]]; then
  protect_config_pools "$DEFAULT_CONFIG_FILE"
fi

# Reaching a protected pool here means the stack or a name lookup points at the
# other deployment's pool, so the script stops before it deletes anything.
while IFS=$'\t' read -r kind pid file cprefix; do
  [[ -z "${pid:-}" ]] && continue
  for id in $USER_POOL_IDS $IDENTITY_POOL_IDS; do
    if [[ "$id" == "$pid" ]]; then
      echo "Error: Cognito pool $id belongs to the deployment that $file" >&2
      echo "describes (prefix '${cprefix:-<none>}'), not to ${STACK_PREFIX}/${REGION}." >&2
      echo "Nothing was deleted." >&2
      exit 1
    fi
  done
done <<< "$PROTECTED_POOLS"

# Record which protected pools exist now, so the check at the end can tell a
# pool this run removed from one that was already gone. A pool ID carries its
# region.
config_pool_present() {  # config_pool_present <user|identity> <pool-id>: 0 present, 1 gone, 2 unknown
  local region="${2%%[_:]*}"
  if [[ "$1" == "user" ]]; then
    aws_probe cognito-idp describe-user-pool --user-pool-id "$2" --region "$region" >/dev/null
  else
    aws_probe cognito-identity describe-identity-pool --identity-pool-id "$2" --region "$region" >/dev/null
  fi
}
CONFIG_POOLS_PRESENT=""
while IFS=$'\t' read -r kind pid file cprefix; do
  [[ -z "${pid:-}" ]] && continue
  rc=0
  config_pool_present "$kind" "$pid" || rc=$?
  case $rc in
    0) CONFIG_POOLS_PRESENT+="$kind"$'\t'"$pid"$'\t'"$file"$'\t'"$cprefix"$'\n' ;;
    1) ;;
    *) echo "  WARN could not read the $kind pool $pid that $file names, so this teardown" >&2
       echo "       cannot confirm afterwards that the pool survived: ${AWS_ERROR//$'\n'/ }" >&2 ;;
  esac
done <<< "$PROTECTED_POOLS"

# ── Find this deployment's parameters and leftover certificates ──────────────
# Selected before the confirmation, like the pools, so the confirmation and
# --dry-run list what Steps 2a, 2b and 2c delete.

prefixed_parameters() {  # prefixed_parameters <path>: SSM parameter names under <path>
  local names
  names=$(aws_call ssm get-parameters-by-path --path "$1" --recursive --region "$REGION" \
    --query 'Parameters[].Name' --output text) || true
  [[ "$names" == "None" ]] || printf '%s' "$names"
}
APP_CREDS_PREFIX="/${STACK_PREFIX}/app-creds/"
PLATFORM_PREFIX="/${STACK_PREFIX}/platform/"
APP_CREDS_NAMES=$(prefixed_parameters "$APP_CREDS_PREFIX")
PLATFORM_NAMES=$(prefixed_parameters "$PLATFORM_PREFIX")

# Every certificate tagged with the prefix. CloudFront takes certificates only
# from us-east-1, so they live there whatever $REGION is.
CERT_ARNS=""
CERT_CANDIDATES=$(aws_call acm list-certificates --region us-east-1 \
  --certificate-statuses PENDING_VALIDATION ISSUED INACTIVE EXPIRED VALIDATION_TIMED_OUT REVOKED FAILED \
  --query 'CertificateSummaryList[].CertificateArn' --output text) || true
for arn in $CERT_CANDIDATES; do
  [[ "$arn" == "None" ]] && continue
  owner=$(aws_call acm list-tags-for-certificate --region us-east-1 --certificate-arn "$arn" \
    --query "Tags[?Key=='starkeep:stackPrefix'].Value | [0]" --output text) || continue
  if [[ "$owner" == "$STACK_PREFIX" ]]; then CERT_ARNS="${CERT_ARNS:+$CERT_ARNS }$arn"; fi
done

# ── Confirmation ────────────────────────────────────────────────────────────
echo ""
[[ "$DRY_RUN" == "true" ]] && echo "DRY RUN: nothing will be deleted. A real run would do the following."
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
for name in $APP_CREDS_NAMES $PLATFORM_NAMES; do echo "    SSM parameter        : $name"; done
for arn in $CERT_ARNS; do echo "    Certificate          : $arn (us-east-1)"; done
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
while IFS=$'\t' read -r kind pid file cprefix; do
  [[ -z "${pid:-}" ]] && continue
  echo "  Kept, and checked at the end: $kind pool $pid ($file, prefix '${cprefix:-<none>}')"
done <<< "$CONFIG_POOLS_PRESENT"
[[ -n "$CONFIG_POOLS_PRESENT" ]] && echo ""
if [[ "$CONFIG_MATCHES_TEARDOWN" == "true" ]]; then
  echo "After all resources are deleted, the cloud config in $CONFIG_FILE will be"
  echo "cleared (the local 'appParentDirs' setting is preserved)."
else
  echo "$CONFIG_FILE will be left UNTOUCHED — it describes prefix"
  echo "'${CONFIG_STACK_PREFIX:-<none>}' / region '${CONFIG_REGION:-<none>}', not the deployment being torn down."
fi
echo ""

CDS_FORCE_FLAG=""
[[ "$FORCE" == "true" ]] && CDS_FORCE_FLAG="--force"

if [[ "$DRY_RUN" == "true" ]]; then
  echo ">>> Running teardown-cloud-data-server.sh --dry-run..."
  "$SCRIPT_DIR/teardown-cloud-data-server.sh" --yes --dry-run $CDS_FORCE_FLAG \
    --prefix "$STACK_PREFIX" --region "$REGION"
  finish_teardown "Bootstrap teardown"
fi

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
# CDS_FORCE_FLAG is a plain string (not an array): macOS ships bash 3.2, where
# expanding an empty array under `set -u` errors. --force has no spaces, so
# unquoted is safe.
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
  exists iam get-role --role-name "$role_name" || return 0

  # Remove permissions boundary
  try_quiet iam delete-role-permissions-boundary --role-name "$role_name"

  # Detach managed policies
  local arns
  arns=$(aws_call iam list-attached-role-policies --role-name "$role_name" \
    --query 'AttachedPolicies[].PolicyArn' --output text) || true
  for arn in $arns; do
    echo "  Detaching: $arn"
    try_quiet iam detach-role-policy --role-name "$role_name" --policy-arn "$arn"
  done

  # Delete inline policies
  local inline
  inline=$(aws_call iam list-role-policies --role-name "$role_name" \
    --query 'PolicyNames[]' --output text) || true
  for p in $inline; do
    echo "  Deleting inline policy: $p"
    try_quiet iam delete-role-policy --role-name "$role_name" --policy-name "$p"
  done

  try_delete "role $role_name" iam delete-role --role-name "$role_name"
}

delete_managed_policy() {
  local policy_name="$1"
  local policy_arn="arn:aws:iam::${ACCOUNT_ID}:policy/${policy_name}"
  step "Cleaning up IAM managed policy: $policy_name"
  exists iam get-policy --policy-arn "$policy_arn" || return 0

  # Detach from all roles using it as an attached policy.
  # Also remove it as a permissions boundary on those same roles — a role can
  # hold the same policy in both positions simultaneously (e.g. cloud-data-server-role).
  local attached_roles
  attached_roles=$(aws_call iam list-entities-for-policy --policy-arn "$policy_arn" \
    --entity-filter Role --query 'PolicyRoles[].RoleName' --output text) || true
  for role in $attached_roles; do
    echo "  Detaching from role: $role"
    try_quiet iam detach-role-policy --role-name "$role" --policy-arn "$policy_arn"
    try_quiet iam delete-role-permissions-boundary --role-name "$role"
  done

  # Also scan for roles that use this policy *only* as a permissions boundary
  # (not attached). Use Python3 to paginate through all roles — aws iam list-roles
  # --query filters per-page and silently misses roles on later pages.
  local boundary_only_roles
  boundary_only_roles=$(python3 - "$policy_arn" << 'PYEOF'
import os, subprocess, json, sys
policy_arn = sys.argv[1]
marker = None
while True:
    cmd = ["aws", "iam", "list-roles", "--output", "json"]
    if marker:
        cmd += ["--starting-token", marker]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        msg = " ".join(f"aws iam list-roles: {r.stderr}".split())
        print(f"  ERROR {msg}", file=sys.stderr)
        with open(os.environ["TEARDOWN_FAILURES"], "a") as f:
            f.write(msg + "\n")
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
    try_quiet iam delete-role-permissions-boundary --role-name "$role"
  done

  # Delete non-default versions before deleting the policy
  local versions
  versions=$(aws_call iam list-policy-versions --policy-arn "$policy_arn" \
    --query 'Versions[?!IsDefaultVersion].VersionId' --output text) || true
  for ver in $versions; do
    try_quiet iam delete-policy-version --policy-arn "$policy_arn" --version-id "$ver"
  done

  try_delete "policy $policy_name" iam delete-policy --policy-arn "$policy_arn"
}

# ── Step 1: Empty S3 buckets ──────────────────────────────────────────────────
step "Emptying S3 bucket: $BUCKET"
if exists s3api head-bucket --bucket "$BUCKET"; then
  empty_versioned_bucket "$BUCKET" || record_failure "could not empty $BUCKET"
fi

step "Emptying S3 bucket: $ARTIFACTS_BUCKET"
if exists s3api head-bucket --bucket "$ARTIFACTS_BUCKET"; then
  empty_versioned_bucket "$ARTIFACTS_BUCKET" || record_failure "could not empty $ARTIFACTS_BUCKET"
fi

# Unversioned, which the helper handles: S3 lists each object once, with the
# version id "null".
step "Emptying S3 bucket: $APP_ASSETS_BUCKET"
if exists s3api head-bucket --bucket "$APP_ASSETS_BUCKET"; then
  empty_versioned_bucket "$APP_ASSETS_BUCKET" || record_failure "could not empty $APP_ASSETS_BUCKET"
fi

# ── Step 2: Delete SSM parameter ─────────────────────────────────────────────
step "Deleting SSM parameter: $SSM_PARAM"
if exists ssm get-parameter --name "$SSM_PARAM" --region "$REGION"; then
  try_delete "$SSM_PARAM" ssm delete-parameter --name "$SSM_PARAM" --region "$REGION"
fi

# ── Step 2a: Delete per-app HMAC credential parameters ───────────────────────
# Each cloud-installed app has a /${STACK_PREFIX}/app-creds/${appId}
# SecureString written by the installer (see admin-installer/src/app-creds.ts).
# Normal uninstall removes these per-app; the sweep here catches any left
# behind by an interrupted run so a re-bootstrap starts clean. The names were
# selected before the confirmation.
step "Deleting per-app SSM credential parameters under $APP_CREDS_PREFIX"
if [[ -n "$APP_CREDS_NAMES" ]]; then
  for name in $APP_CREDS_NAMES; do
    try_delete "$name" ssm delete-parameter --name "$name" --region "$REGION"
  done
else
  skip
fi

# ── Step 2b: Delete the platform's own parameters ────────────────────────────
# The deployment's settings (/${STACK_PREFIX}/platform/deployment-settings),
# written by admin-web through Manager, and any device records a deployment kept
# from before pairing was retired. Nothing uninstalls these, so the sweep is the
# only thing that removes them.
step "Deleting platform SSM parameters under $PLATFORM_PREFIX"
if [[ -n "$PLATFORM_NAMES" ]]; then
  for name in $PLATFORM_NAMES; do
    try_delete "$name" ssm delete-parameter --name "$name" --region "$REGION"
  done
else
  skip
fi

# ── Step 2c: Delete custom-domain certificates ───────────────────────────────
# teardown-cloud-data-server.sh above deletes every certificate tagged with the
# prefix after it deletes the distribution, which releases each one at once.
# This step deletes any certificate an earlier, failed run left; one that the
# cloud-data-server teardown already deleted reads as already gone. Each
# delete runs once: a certificate still in use means a distribution still
# holds it, and the script names the distribution and fails at the end.
step "Deleting custom-domain certificates tagged starkeep:stackPrefix=${STACK_PREFIX} (us-east-1)"
for arn in $CERT_ARNS; do
  rc=0
  aws_probe acm delete-certificate --region us-east-1 --certificate-arn "$arn" >/dev/null || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "  Deleted $arn"
    continue
  fi
  [[ $rc -eq 1 ]] && { echo "  $arn: not found or already deleted."; continue; }
  err="$AWS_ERROR"
  holders=$(aws_probe acm describe-certificate --region us-east-1 --certificate-arn "$arn" \
    --query 'Certificate.InUseBy[]' --output text) || true
  if [ -n "$holders" ] && [ "$holders" != "None" ]; then
    record_failure "certificate $arn is in use by $holders; run teardown-cloud-data-server.sh, then this script again"
  else
    record_failure "could not delete certificate $arn: $err"
  fi
done
[[ -n "$CERT_ARNS" ]] || skip

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
if exists cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION"; then
  if aws_call cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION" >/dev/null; then
    echo "  Waiting for stack deletion (this may take a few minutes)..."
    if aws_probe cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION" >/dev/null; then
      echo "  Stack deleted."
    else
      record_failure "stack $STACK_NAME did not finish deleting: ${AWS_ERROR:-timed out}. Cognito and S3 cleanup still ran."
    fi
  fi
fi

# Delete the buckets themselves (should be empty by now). CF stack deletion
# normally removes them, but if the stack was in CREATE_FAILED / ROLLBACK state
# the bucket may have been orphaned from the stack — handle that here.
step "Deleting S3 bucket: $BUCKET"
if exists s3api head-bucket --bucket "$BUCKET"; then
  try_delete "$BUCKET" s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
fi

step "Deleting S3 bucket: $ARTIFACTS_BUCKET"
if exists s3api head-bucket --bucket "$ARTIFACTS_BUCKET"; then
  try_delete "$ARTIFACTS_BUCKET" s3api delete-bucket --bucket "$ARTIFACTS_BUCKET" --region "$REGION"
fi

step "Deleting S3 bucket: $APP_ASSETS_BUCKET"
if exists s3api head-bucket --bucket "$APP_ASSETS_BUCKET"; then
  try_delete "$APP_ASSETS_BUCKET" s3api delete-bucket --bucket "$APP_ASSETS_BUCKET" --region "$REGION"
fi

# Delete the Cognito pools found above. The stack deletion normally removes
# them; this sweep catches pools a failed or partial deletion left behind. A
# missing pool counts as deleted. Any other failure, such as a user pool that
# still has a domain, is recorded and fails the script at the end.
for id in $IDENTITY_POOL_IDS; do
  step "Deleting Cognito Identity Pool: $id"
  try_delete "identity pool $id" cognito-identity delete-identity-pool \
    --identity-pool-id "$id" --region "$REGION"
done

for id in $USER_POOL_IDS; do
  step "Deleting Cognito User Pool: $id"
  # UpdateUserPool resets every setting the call omits to its default, so the
  # script turns deletion protection off only when it is on. The template
  # never turns it on.
  protection=$(aws_call cognito-idp describe-user-pool --user-pool-id "$id" --region "$REGION" \
    --query 'UserPool.DeletionProtection' --output text) || true
  if [[ "$protection" == "ACTIVE" ]]; then
    try_quiet cognito-idp update-user-pool --user-pool-id "$id" \
      --deletion-protection INACTIVE --region "$REGION"
  fi
  try_delete "user pool $id" cognito-idp delete-user-pool --user-pool-id "$id" --region "$REGION"
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

# ── Step 7: Confirm the other deployment's pools survived ────────────────────
# A teardown of this prefix must never remove the pools of another deployment
# that a config describes. Recheck every protected pool that existed at the
# start.
if [[ -n "$CONFIG_POOLS_PRESENT" ]]; then
  step "Checking that the other deployments' Cognito pools still exist"
  while IFS=$'\t' read -r kind id file cprefix; do
    [[ -z "${id:-}" ]] && continue
    rc=0
    config_pool_present "$kind" "$id" || rc=$?
    case $rc in
      0) echo "  $id still exists." ;;
      1) record_failure "the $kind pool $id that $file names (prefix '${cprefix:-<none>}') existed when this teardown started and is gone now. Investigate before running another teardown." ;;
      *) record_failure "could not confirm that the $kind pool $id still exists: $AWS_ERROR" ;;
    esac
  done <<< "$CONFIG_POOLS_PRESENT"
fi

finish_teardown "Bootstrap teardown"
