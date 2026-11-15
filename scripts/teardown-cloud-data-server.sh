#!/usr/bin/env bash
# Tears down the cloud-data-server and all installed apps.
#
# Order of operations:
#   1. Per-app installs (teardown-cloud-apps.sh)
#   2. cloud-data-server: Lambda, log group, API Gateway, DSQL cluster,
#      files bucket, billing bucket, CUR report, IAM role
#
# --prefix and --region are both required: they scope the teardown to one
# deployment in one place and neither is ever inferred from config. A
# config-derived or CLI-default region can silently target the wrong region
# (e.g. the test suite deploys to us-east-2 while the AWS CLI default is
# us-east-1), skipping the real resources. If either is omitted in an
# interactive shell you'll be prompted for it; an unattended run (--yes or no
# TTY) missing either errors out.
#
# Real (non-ephemeral) DSQL clusters are created with deletion protection ON by
# design (see cloud-data-server-program.ts), so a plain delete-cluster fails on
# them. Since removing the whole CDS stack is the entire point of this script,
# it can disable that protection before deleting — but only with explicit
# consent: pass --force, or answer the interactive y/N prompt. Without either,
# a protected cluster is left intact and the run says so.
#
# The script resolves the gateway, Lambdas, log groups, DSQL clusters,
# distribution and certificates before the confirmation, and the confirmation
# lists their IDs. --dry-run prints that list, and the list from
# teardown-cloud-apps.sh, then exits without deleting anything.
#
# A failed AWS call does not stop the teardown. The script lists each failure
# at the end and exits 1. A resource that is already gone is not a failure.
#
# Usage:
#   ./teardown-cloud-data-server.sh [--yes|-y] [--force] [--dry-run] --prefix <stack-prefix> --region <region>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Honor repo-root .env / .env.local (STARKEEP_DIR etc.) before defaulting below.
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

# Does $CONFIG_FILE actually describe the deployment being torn down? Step 9
# strips the cloud-data-server keys from it, and that is only correct when the
# config belongs to *this* deployment. The teardown target comes from
# --prefix/--region while the config is whatever STARKEEP_DIR (default
# $HOME/.starkeep) happens to point at — usually the operator's real
# deployment. Tearing down a test stack must not blank the real deployment's
# config, so we require both scoping keys to match before touching it.
#
# The config carries no region key; userPoolId is region-prefixed
# (us-east-1_xxxx), so it stands in for one. A config missing either key can't
# be shown to match, so it's left alone.
CONFIG_MATCHES_TEARDOWN=false
if [[ -n "$CONFIG_STACK_PREFIX" && "$CONFIG_STACK_PREFIX" == "$STACK_PREFIX" \
      && -n "$CONFIG_REGION" && "$CONFIG_REGION" == "$REGION" ]]; then
  CONFIG_MATCHES_TEARDOWN=true
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
# Every Lambda under this prefix, not one hard-coded name. teardown-cloud-apps.sh
# excludes `-app-cloud-data-server-*` from its orphan scan on the understanding
# that this script owns them, so anything here that the name below did not match
# fell through both scripts and survived every teardown — which is how an
# `-api-stream` function from an abandoned streaming design outlived the stack it
# belonged to and wedged the next install (Pulumi planned a delete the install
# role had no permission to perform).
CDS_LAMBDA_PREFIX="${STACK_PREFIX}-app-cloud-data-server-"
CDS_ROLE="${STACK_PREFIX}-app-cloud-data-server-role"
GATEWAY_NAME="${STACK_PREFIX}-gateway"

# ── Helpers ───────────────────────────────────────────────────────────────────

step() { echo ""; echo "==> $*"; }
skip() { echo "  Not found, skipping."; }

empty_bucket() {
  local bucket="$1"
  python3 << PYEOF
import json, os, subprocess, tempfile

bucket = "$bucket"

def aws_json(*args):
    r = subprocess.run(["aws"] + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return json.loads(r.stdout) if r.stdout.strip() else {}

def delete_objects(objs):
    """Batch-delete up to 1000 objects in one call, returning the raw stdout.

    The payload goes through a temp file (--delete file://...) rather than an
    inline JSON argument — inline JSON is what triggered the 'MalformedXML'
    errors. Callers must chunk to delete-objects' 1000-key-per-call limit."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"Objects": objs, "Quiet": False}, f)
        path = f.name
    try:
        r = subprocess.run(
            ["aws", "s3api", "delete-objects", "--bucket", bucket,
             "--delete", "file://" + path],
            capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip())
        return r.stdout
    finally:
        os.unlink(path)

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

def delete_in_batches(objs):
    """Delete an arbitrary number of objects, chunked to the 1000-key limit.
    Returns the total number of per-object errors reported."""
    n_errors = 0
    for i in range(0, len(objs), 1000):
        n_errors += report_delete_response(delete_objects(objs[i:i + 1000]))
    return n_errors

deleted = 0
stalled = 0
while True:
    data = aws_json("s3api", "list-object-versions", "--bucket", bucket,
                    "--max-items", "1000", "--output", "json")
    objs = [{"Key": o["Key"], "VersionId": o["VersionId"]}
            for o in data.get("Versions", []) + data.get("DeleteMarkers", [])]
    if not objs:
        break
    n_errors = delete_in_batches(objs)
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
    delete_in_batches(objs)
    deleted += len(objs)
    print(f"  Deleted {deleted} objects so far...")

print("  Bucket empty." if deleted == 0 else f"  Emptied {deleted} total items.")
PYEOF
}

delete_role() {
  local role_name="$1"
  step "Deleting IAM role: $role_name"
  exists iam get-role --role-name "$role_name" || return 0

  try_quiet iam delete-role-permissions-boundary --role-name "$role_name"

  local arns
  arns=$(aws_call iam list-attached-role-policies --role-name "$role_name" \
    --query 'AttachedPolicies[].PolicyArn' --output text) || true
  for arn in $arns; do
    echo "  Detaching: $arn"
    try_quiet iam detach-role-policy --role-name "$role_name" --policy-arn "$arn"
  done

  local inline
  inline=$(aws_call iam list-role-policies --role-name "$role_name" \
    --query 'PolicyNames[]' --output text) || true
  for p in $inline; do
    echo "  Deleting inline policy: $p"
    try_quiet iam delete-role-policy --role-name "$role_name" --policy-name "$p"
  done

  try_delete "role $role_name" iam delete-role --role-name "$role_name"
}

# list_or_none <list>: prints the list space-separated, or "<none>" when empty.
list_or_none() {
  local v
  v=$(echo $1)
  echo "${v:-<none>}"
}

# ── Resolve this deployment's resources ──────────────────────────────────────
# Every selection happens here, before the confirmation, so the confirmation
# and --dry-run list the actual IDs that the steps below delete.

API_IDS=$(aws_call apigatewayv2 get-apis \
  --query "Items[?Name=='${GATEWAY_NAME}'].ApiId" --output text) || true

CDS_LAMBDAS=$(aws_call lambda list-functions \
  --query "Functions[?starts_with(FunctionName, '${CDS_LAMBDA_PREFIX}')].FunctionName" \
  --output text) || true

CDS_LOG_GROUPS=$(aws_call logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/${CDS_LAMBDA_PREFIX}" \
  --query "logGroups[].logGroupName" --output text) || true

# A DSQL cluster's identifier is assigned by AWS, so unlike every other resource
# here it cannot be selected by a prefixed name — the `starkeep:stackPrefix` tag
# is the only thing that says which deployment a cluster belongs to. Clusters
# created before that tag existed carry only `starkeep:appId=cloud-data-server`,
# which every deployment's cluster carries, so an untagged cluster cannot be
# attributed to this prefix and is never deleted on that basis alone. The one
# exception is a cluster with deletion protection off: the program sets
# protection from `!ephemeral`, so an unprotected cluster is a disposable e2e
# one by construction and no real deployment has one.
#
# Each CLUSTERS line is "<mine|other|untagged> <cluster-id> <owner or -> <protection or ->".
CLUSTER_TAGS=$(python3 - "$REGION" << 'PYEOF'
import os, subprocess, json, sys

region = sys.argv[1]

def record_failure(msg):
    msg = " ".join(msg.split())
    print(f"  ERROR {msg}", file=sys.stderr)
    with open(os.environ["TEARDOWN_FAILURES"], "a") as f:
        f.write(msg + "\n")

r = subprocess.run(
    ["aws", "dsql", "list-clusters", "--region", region, "--output", "json"],
    capture_output=True, text=True,
)
if r.returncode != 0:
    record_failure(f"aws dsql list-clusters: {r.stderr}")
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
        record_failure(f"aws dsql list-tags-for-resource {cid}: {tr.stderr}")
        continue
    tags = json.loads(tr.stdout).get("tags", {})
    if tags.get("starkeep:appId") != "cloud-data-server":
        continue
    print(cid, tags.get("starkeep:stackPrefix") or "-")
PYEOF
)
CLUSTERS=""
while read -r CID OWNER; do
  [[ -z "${CID:-}" ]] && continue
  if [[ "$OWNER" != "-" && "$OWNER" != "$STACK_PREFIX" ]]; then
    CLUSTERS+="other $CID $OWNER -"$'\n'
    continue
  fi
  # Read once: it decides both whether an untagged cluster is attributable and
  # whether a deletable one needs its protection lifted first.
  PROTECTED=$(aws_call dsql get-cluster --identifier "$CID" --region "$REGION" \
    --query 'deletionProtectionEnabled' --output text) || PROTECTED=unknown
  if [[ "$OWNER" == "-" ]]; then
    CLUSTERS+="untagged $CID - $PROTECTED"$'\n'
  else
    CLUSTERS+="mine $CID - $PROTECTED"$'\n'
  fi
done <<< "$CLUSTER_TAGS"

describe_cluster() {  # describe_cluster <state> <cluster-id> <owner> <protection>
  case "$1:$4" in
    other:*) echo "$2 (skipped: belongs to deployment '$3')" ;;
    untagged:False|untagged:false) echo "$2 (untagged and unprotected: deleted as a disposable e2e cluster)" ;;
    untagged:*) echo "$2 (skipped: untagged and protected)" ;;
    mine:True|mine:true)
      if [[ "$FORCE" == "true" ]]; then
        echo "$2 (protected: --force lifts the protection)"
      else
        echo "$2 (protected: kept unless --force or a 'y' at the prompt)"
      fi ;;
    *) echo "$2" ;;
  esac
}

DIST_IDS=$(aws_call cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${STACK_PREFIX} platform CDN'].Id" \
  --output text) || true
[[ "$DIST_IDS" == "None" ]] && DIST_IDS=""

# Every certificate tagged with the prefix and the cloud-data-server: the
# stack's (Route53 mode) and the installer's (external mode). CloudFront takes
# certificates only from us-east-1, so they live there whatever $REGION is.
CERT_CANDIDATES=$(aws_call acm list-certificates --region us-east-1 \
  --certificate-statuses PENDING_VALIDATION ISSUED INACTIVE EXPIRED VALIDATION_TIMED_OUT REVOKED FAILED \
  --query 'CertificateSummaryList[].CertificateArn' --output text) || true
CERT_ARNS=""
for arn in $CERT_CANDIDATES; do
  [[ "$arn" == "None" ]] && continue
  owner_app=$(aws_call acm list-tags-for-certificate --region us-east-1 --certificate-arn "$arn" \
    --query "[Tags[?Key=='starkeep:stackPrefix'].Value | [0], Tags[?Key=='starkeep:appId'].Value | [0]]" \
    --output text) || continue
  read -r owner app <<< "$owner_app"
  if [[ "$owner" == "$STACK_PREFIX" && "$app" == "cloud-data-server" ]]; then
    CERT_ARNS="${CERT_ARNS:+$CERT_ARNS }$arn"
  fi
done

# ── Confirmation ──────────────────────────────────────────────────────────────

echo ""
[[ "$DRY_RUN" == "true" ]] && echo "DRY RUN: nothing will be deleted. A real run would do the following."
echo "This will permanently destroy all Starkeep cloud-data-server resources"
echo "(and all installed apps via teardown-cloud-apps.sh):"
echo ""
echo "  Stack prefix : $STACK_PREFIX  (region: $REGION, account: $ACCOUNT_ID)"
echo "  API Gateway  : $GATEWAY_NAME ($(list_or_none "$API_IDS"))"
echo "  Lambdas      : $(list_or_none "$CDS_LAMBDAS")"
echo "  Log groups   : $(list_or_none "$CDS_LOG_GROUPS")"
if [[ -z "$CLUSTERS" ]]; then
  echo "  DSQL cluster : <none>"
else
  while read -r STATE CID OWNER PROTECTED; do
    [[ -z "${CID:-}" ]] && continue
    echo "  DSQL cluster : $(describe_cluster "$STATE" "$CID" "$OWNER" "$PROTECTED")"
  done <<< "$CLUSTERS"
fi
echo "  CloudFront   : distribution $(list_or_none "$DIST_IDS"), with its OAC, cache policies, public key, key group and function"
echo "  Certificates : $(list_or_none "$CERT_ARNS") (us-east-1), and a Route53-zone domain's records"
echo "  Signing key  : SSM /${STACK_PREFIX}/app-creds/_cloudfront-signing"
echo "  S3 buckets   : $FILES_BUCKET, $BILLING_BUCKET"
echo "  CUR report   : $CUR_REPORT"
echo "  IAM role     : $CDS_ROLE"
echo "  Pulumi locks : s3://${PULUMI_STATE_BUCKET}/.pulumi/locks/ (cleared, bucket kept)"
if [[ "$CONFIG_MATCHES_TEARDOWN" == "true" ]]; then
  echo "  Config keys  : stale cloud-data-server keys stripped from $CONFIG_FILE"
else
  echo "  Config keys  : NOT touched — $CONFIG_FILE describes"
  echo "                 prefix '${CONFIG_STACK_PREFIX:-<none>}' / region '${CONFIG_REGION:-<none>}', not this teardown"
fi
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  echo ">>> Running teardown-cloud-apps.sh --dry-run..."
  "$SCRIPT_DIR/teardown-cloud-apps.sh" --yes --dry-run --prefix "$STACK_PREFIX" --region "$REGION"
  finish_teardown "Cloud-data-server teardown"
fi

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
if exists s3api head-bucket --bucket "$PULUMI_STATE_BUCKET"; then
  LOCK_KEYS=$(aws_call s3api list-objects-v2 --bucket "$PULUMI_STATE_BUCKET" \
    --prefix ".pulumi/locks/" \
    --query 'Contents[].Key' --output text) || true
  if [[ -z "$LOCK_KEYS" || "$LOCK_KEYS" == "None" ]]; then
    echo "  No locks found."
  else
    for key in $LOCK_KEYS; do
      try_delete "lock $key" s3api delete-object --bucket "$PULUMI_STATE_BUCKET" --key "$key"
    done
  fi
fi

# ── Step 2: API Gateway v2 ────────────────────────────────────────────────────

step "Deleting API Gateway: $GATEWAY_NAME"
if [[ -n "$API_IDS" ]]; then
  for api_id in $API_IDS; do
    try_delete "API Gateway $api_id ($GATEWAY_NAME)" apigatewayv2 delete-api --api-id "$api_id"
  done
else
  skip
fi

# ── Step 3: cloud-data-server Lambda + log group ──────────────────────────────

step "Deleting Lambdas under: ${CDS_LAMBDA_PREFIX}"
if [[ -n "$CDS_LAMBDAS" ]]; then
  for fn in $CDS_LAMBDAS; do
    try_delete "$fn" lambda delete-function --function-name "$fn"
  done
else
  skip
fi

step "Deleting log groups under: /aws/lambda/${CDS_LAMBDA_PREFIX}"
if [[ -n "$CDS_LOG_GROUPS" ]]; then
  for lg in $CDS_LOG_GROUPS; do
    try_delete "$lg" logs delete-log-group --log-group-name "$lg"
  done
else
  skip
fi

# ── Step 4: DSQL cluster ──────────────────────────────────────────────────────

# The clusters were selected and classified before the confirmation.
step "Deleting DSQL cluster (tagged starkeep:stackPrefix=${STACK_PREFIX})"
if [[ -z "$CLUSTERS" ]]; then
  skip
else
  while read -r STATE CID OWNER PROTECTED; do
    [[ -z "${CID:-}" ]] && continue

    if [[ "$STATE" == "other" ]]; then
      echo "  Skipping $CID — it belongs to deployment '$OWNER', not '$STACK_PREFIX'."
      continue
    fi

    if [[ "$STATE" == "untagged" ]]; then
      # No stackPrefix tag: predates the tag, so which deployment it belongs to
      # is unknown. Deletable only on the protection evidence described above.
      if [[ "$PROTECTED" != "False" && "$PROTECTED" != "false" ]]; then
        echo "  WARN: $CID carries no starkeep:stackPrefix tag, so it cannot be attributed"
        echo "        to '$STACK_PREFIX' and may belong to another deployment. Leaving it intact."
        echo "        If it IS this deployment's, tag it and re-run:"
        echo "          aws dsql tag-resource --resource-arn arn:aws:dsql:${REGION}:<account>:cluster/${CID} \\"
        echo "            --tags 'starkeep:stackPrefix=${STACK_PREFIX}' --region ${REGION}"
        continue
      fi
      echo "  $CID has no stackPrefix tag but deletion protection is off — treating it as a"
      echo "  disposable e2e cluster (a real deployment's cluster is always protected)."
    fi

    # Real user clusters enable deletion protection by design, which makes
    # delete-cluster fail. Removing the CDS stack is the whole point of this
    # script, so it can lift that protection — but never silently: only with
    # --force, or an explicit interactive y/N. Without consent the cluster is
    # left intact and we say exactly how to remove it.
    if [[ "$PROTECTED" == "True" || "$PROTECTED" == "true" ]]; then
      DO_DISABLE=false
      if [[ "$FORCE" == "true" ]]; then
        DO_DISABLE=true
      elif [[ "$YES" != "true" && -t 0 ]]; then
        read -r -p "  Cluster $CID has deletion protection enabled. Disable it and delete the cluster? [y/N] " ans
        [[ "$ans" == "y" || "$ans" == "Y" ]] && DO_DISABLE=true
      fi
      if [[ "$DO_DISABLE" != "true" ]]; then
        echo "  WARN: $CID has deletion protection enabled — leaving it intact."
        echo "        Re-run with --force (or answer 'y' at the prompt) to disable protection and delete it."
        continue
      fi
      echo "  Disabling deletion protection on ${CID}..."
      if ! aws_call dsql update-cluster --identifier "$CID" --no-deletion-protection-enabled \
          --region "$REGION" >/dev/null; then
        continue
      fi
      # update-cluster is asynchronous; wait for the cluster to settle back to
      # ACTIVE (protection cleared) before delete-cluster, or the delete races
      # the in-flight update and fails.
      aws dsql wait cluster-active --identifier "$CID" --region "$REGION" 2>/dev/null || true
    fi

    echo "  Deleting cluster: $CID"
    # A cluster that is already being deleted refuses another delete, which
    # is not a failure.
    rc=0
    aws_probe dsql delete-cluster --identifier "$CID" --region "$REGION" >/dev/null || rc=$?
    if [[ $rc -eq 0 ]]; then
      echo "  Delete initiated (DSQL deletion is asynchronous)."
    elif [[ $rc -eq 1 ]]; then
      echo "  Not found or already deleted."
    else
      delete_error="$AWS_ERROR"
      status=$(aws_probe dsql get-cluster --identifier "$CID" --region "$REGION" \
        --query 'status' --output text) || status=""
      if [[ "$status" == "DELETING" || "$status" == "DELETED" ]]; then
        echo "  Already being deleted."
      else
        record_failure "could not delete DSQL cluster $CID: $delete_error"
      fi
    fi
  done <<< "$CLUSTERS"
fi

# ── Step 4b: CloudFront (Part B: shared-file signed URLs) ─────────────────────
# The platform CloudFront distribution and its URL-signing material: the
# distribution itself, the S3-origin OAC, the shared-files and public-shares
# cache policies, the RSA public key + key group, the signed-out-redirect
# viewer-request function, and a custom domain the stack owned. Deleting a
# distribution requires disable → wait-until-Deployed → delete, which is slow
# (~5–15 min). This whole
# step is best-effort: any failure is logged and skipped so a hiccup never
# aborts the wider teardown (these resources are idle/cheap and can be cleaned
# up by hand). Done before the files bucket because the distribution's S3 origin
# references it. Idempotent — silently skips anything already gone (e.g. an
# install that failed before creating them).

step "Deleting CloudFront distribution + signing key material"
# The distribution and certificates were selected before the confirmation. Each
# failure below is recorded, and the script fails at the end.
python3 - "$STACK_PREFIX" "$DIST_IDS" "$CERT_ARNS" << 'PYEOF'
import json, os, subprocess, sys, time

prefix = sys.argv[1]
dist_ids = sys.argv[2].split()
cert_arns = sys.argv[3].split()


def record_failure(msg):
    msg = " ".join(msg.split())
    print(f"  ERROR {msg}", flush=True)
    with open(os.environ["TEARDOWN_FAILURES"], "a") as f:
        f.write(msg + "\n")

PUBKEY_COMMENT = f"{prefix} shared-file signing key"
KEYGROUP_COMMENT = f"{prefix} shared-file signers"
OAC_NAME = f"{prefix}-files-oac"
# Every custom cache policy the program creates. Names are account-global, so a
# policy left behind makes the next install of the prefix fail.
CACHE_NAMES = [f"{prefix}-shared-files-cache", f"{prefix}-public-shares-cache"]
REDIRECT_FN_NAME = f"{prefix}-signed-out-redirect"


def cf(*args):
    """Run an `aws cloudfront` subcommand, returning parsed JSON (or {})."""
    r = subprocess.run(["aws", "cloudfront", *args, "--output", "json"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return json.loads(r.stdout) if r.stdout.strip() else {}


def delete_with_etag(kind, list_cmd, list_key, match, id_of, get_cmd, delete_cmd):
    """Generic list→match→get-ETag→delete for the ETag-guarded CF resources
    (key group, public key, OAC, cache policy). `match(item)` picks ours and
    `id_of(item)` extracts its id (the list-item shapes differ: some wrap the
    resource, some are flat). Best-effort — an absent resource just skips.

    Retried, because "in use" here means "the distribution above has not
    finished going away yet", which resolves on its own within a minute or two.
    A single attempt leaks every one of these, and they are what makes the next
    install of the same prefix fail."""
    try:
        data = cf(list_cmd)
        items = (data.get(list_key) or {}).get("Items", []) or []
        found = next((it for it in items if match(it)), None)
        if not found:
            print(f"  {kind}: not found, skipping.")
            return
        rid = id_of(found)
    except Exception as e:  # noqa: BLE001 — best-effort teardown
        record_failure(f"{kind} lookup: {e}")
        return
    for attempt in range(6):
        try:
            got = cf(get_cmd, "--id", rid)
            cf(delete_cmd, "--id", rid, "--if-match", got["ETag"])
            print(f"  {kind}: deleted {rid}.")
            return
        except Exception as e:  # noqa: BLE001 — best-effort teardown
            if attempt == 5:
                record_failure(f"{kind} cleanup after 6 tries: {e}")
                return
            time.sleep(20)


# ---- Distribution: disable → wait Deployed → delete ---------------------------
dist_domain = None  # Its cloudfront.net name, which a custom domain's alias records target.


def delete_distribution(dist_id):
    global dist_domain
    try:
        dist_domain = cf("get-distribution", "--id", dist_id)["Distribution"].get("DomainName")
        print(f"  Distribution: {dist_id} (disable → wait → delete)")
        gc = cf("get-distribution-config", "--id", dist_id)
        etag, cfg = gc["ETag"], gc["DistributionConfig"]
        # Drop a custom domain in the same update. CloudFront refuses an alias
        # that another distribution holds (CNAMEAlreadyExists), so a delete
        # that fails below must not keep the next install off the domain.
        has_alias = (cfg.get("Aliases") or {}).get("Quantity", 0) > 0
        if cfg.get("Enabled") or has_alias:
            cfg["Enabled"] = False
            if has_alias:
                cfg["Aliases"] = {"Quantity": 0}
                # UpdateDistribution requires MinimumProtocolVersion even
                # here, and TLSv1 is the value the default certificate takes.
                cfg["ViewerCertificate"] = {"CloudFrontDefaultCertificate": True,
                                            "MinimumProtocolVersion": "TLSv1"}
            path = f"/tmp/cf-disable-{dist_id}.json"
            with open(path, "w") as f:
                json.dump(cfg, f)
            print("  Disabling distribution" + (" and detaching its custom domain…" if has_alias else "…"))
            cf("update-distribution", "--id", dist_id, "--if-match", etag,
               "--distribution-config", f"file://{path}")
        # Wait for BOTH: the deployment to settle *and* the config to actually
        # read as disabled. Polling Status alone is not enough — CloudFront
        # returns to "Deployed" while the disable is still taking effect, and a
        # delete issued in that window fails with DistributionNotDisabled.
        ready = False
        deadline = time.time() + 25 * 60
        while time.time() < deadline:
            gd = cf("get-distribution", "--id", dist_id)
            status = gd["Distribution"]["Status"]
            enabled = gd["Distribution"]["DistributionConfig"]["Enabled"]
            etag = gd["ETag"]
            if status == "Deployed" and not enabled:
                ready = True
                break
            print(f"  …status={status} enabled={enabled}; waiting 30s")
            time.sleep(30)
        if not ready:
            record_failure(f"distribution {dist_id} did not settle as disabled in 25m; delete it by hand")
        else:
            # And retry anyway. The observed failure (2026-08-24) had status
            # Deployed and the disable applied, and AWS still refused once; a
            # minute later the identical call succeeded. Everything downstream —
            # key group, public key, OAC, cache policy, the viewer-request
            # function — is undeletable while the distribution exists, so giving
            # up here leaks the entire CloudFront chain and the *next* install
            # of this prefix fails on duplicate names.
            for attempt in range(6):
                try:
                    gd = cf("get-distribution", "--id", dist_id)
                    cf("delete-distribution", "--id", dist_id, "--if-match", gd["ETag"])
                    print("  Distribution deleted.")
                    break
                except Exception as e:  # noqa: BLE001
                    if attempt == 5:
                        raise
                    print(f"  delete refused ({str(e).strip()[:80]}…); retrying in 30s")
                    time.sleep(30)
    except Exception as e:  # noqa: BLE001
        record_failure(f"distribution {dist_id} cleanup: {e}")


if not dist_ids:
    print("  Distribution: not found, skipping.")
for dist_id in dist_ids:
    delete_distribution(dist_id)

# ---- Dependents (only deletable once the distribution no longer references
# them; each best-effort, so a still-referenced resource just warns) ----------
delete_with_etag(
    "Key group", "list-key-groups", "KeyGroupList",
    lambda it: it.get("KeyGroup", {}).get("KeyGroupConfig", {}).get("Comment") == KEYGROUP_COMMENT,
    lambda it: it["KeyGroup"]["Id"],
    "get-key-group", "delete-key-group",
)
delete_with_etag(
    "Public key", "list-public-keys", "PublicKeyList",
    lambda it: it.get("Comment") == PUBKEY_COMMENT,
    lambda it: it["Id"],
    "get-public-key", "delete-public-key",
)
delete_with_etag(
    "Origin access control", "list-origin-access-controls", "OriginAccessControlList",
    lambda it: it.get("Name") == OAC_NAME,
    lambda it: it["Id"],
    "get-origin-access-control", "delete-origin-access-control",
)
for cache_name in CACHE_NAMES:
    delete_with_etag(
        f"Cache policy {cache_name}", "list-cache-policies", "CachePolicyList",
        lambda it, n=cache_name: it.get("CachePolicy", {}).get("CachePolicyConfig", {}).get("Name") == n,
        lambda it: it["CachePolicy"]["Id"],
        "get-cache-policy", "delete-cache-policy",
    )

# ---- The signed-out-redirect viewer-request function -------------------------
# Addressed by name rather than id, so it needs its own block rather than
# delete_with_etag. Leaving it behind is not a harmless leak: CloudFront
# function names are account-global and CreateFunction refuses a duplicate, so
# an orphan here breaks the NEXT install of this same prefix. Deletable only
# once the distribution above no longer references it.
for attempt in range(6):
    try:
        got = cf("describe-function", "--name", REDIRECT_FN_NAME)
    except Exception:  # noqa: BLE001 — absent is success
        print(f"  Function: {REDIRECT_FN_NAME} not found, skipping.")
        break
    try:
        cf("delete-function", "--name", REDIRECT_FN_NAME, "--if-match", got["ETag"])
        print(f"  Function: deleted {REDIRECT_FN_NAME}.")
        break
    except Exception as e:  # noqa: BLE001 — best-effort teardown
        # FunctionInUse until the distribution that references it is really
        # gone. Names are account-global and CreateFunction refuses a
        # duplicate, so an orphan here breaks the next install of this prefix.
        if attempt == 5:
            record_failure(f"function cleanup ({REDIRECT_FN_NAME}) after 6 tries: {e}")
            break
        time.sleep(20)

# ---- The custom domain's certificates and records ----------------------------
# Every certificate tagged with the prefix goes: the stack's (Route53 mode, no
# starkeep:customDomainMode tag) and the installer's (mode=external). For a
# stack certificate, first delete its validation record and the A alias record
# the stack wrote. External-mode records live at the operator's DNS provider.
# The distribution is gone by now, and ACM releases a certificate at once when
# its distribution is deleted, so a delete that still fails is recorded and
# fails the script at the end.


def aws_json(*args):
    r = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return json.loads(r.stdout) if r.stdout.strip() else {}


def acm(*args):
    return aws_json("acm", *args, "--region", "us-east-1")


def zone_for(domain):
    """The longest public Route53 zone name that equals or ends the domain."""
    best = None
    for z in aws_json("route53", "list-hosted-zones").get("HostedZones", []):
        if z.get("Config", {}).get("PrivateZone"):
            continue
        name = z["Name"].rstrip(".").lower()
        if (domain == name or domain.endswith("." + name)) and (not best or len(name) > len(best[1])):
            best = (z["Id"].split("/")[-1], name)
    return best


def delete_record(zone_id, name, rtype, keep):
    """Delete the record set `name`/`rtype` when `keep(record)` says it is ours."""
    fqdn = name.rstrip(".") + "."
    got = aws_json("route53", "list-resource-record-sets", "--hosted-zone-id", zone_id,
                   "--start-record-name", fqdn, "--start-record-type", rtype, "--max-items", "1")
    for rs in got.get("ResourceRecordSets", []):
        if rs["Name"].lower() != fqdn.lower() or rs["Type"] != rtype or not keep(rs):
            continue
        batch = json.dumps({"Changes": [{"Action": "DELETE", "ResourceRecordSet": rs}]})
        aws_json("route53", "change-resource-record-sets", "--hosted-zone-id", zone_id,
                 "--change-batch", batch)
        print(f"  Record: deleted {rtype} {fqdn}")


try:
    for arn in cert_arns:
        tags = {t["Key"]: t.get("Value") for t in
                acm("list-tags-for-certificate", "--certificate-arn", arn).get("Tags", [])}
        cert = acm("describe-certificate", "--certificate-arn", arn)["Certificate"]
        domain = cert["DomainName"].lower()
        zone = None if "starkeep:customDomainMode" in tags else zone_for(domain)
        if zone:
            for option in cert.get("DomainValidationOptions", []):
                rr = option.get("ResourceRecord")
                if rr:
                    delete_record(zone[0], rr["Name"], rr["Type"], lambda rs, v=rr["Value"]: any(
                        x.get("Value") == v for x in rs.get("ResourceRecords", [])))
            delete_record(zone[0], domain, "A", lambda rs: (
                rs.get("AliasTarget", {}).get("DNSName", "").rstrip(".").lower()
                == (dist_domain or "").lower()
                if dist_domain else
                rs.get("AliasTarget", {}).get("DNSName", "").rstrip(".").endswith(".cloudfront.net")))
        try:
            acm("delete-certificate", "--certificate-arn", arn)
            print(f"  Certificate: deleted {arn} ({domain})")
        except Exception as e:  # noqa: BLE001
            in_use = acm("describe-certificate", "--certificate-arn", arn)["Certificate"].get(
                "InUseBy", [])
            record_failure(f"certificate {arn} ({domain})"
                           + (f", which ACM reports in use by {', '.join(in_use)}" if in_use else "")
                           + f": {e}")
except Exception as e:  # noqa: BLE001
    record_failure(f"custom domain cleanup: {e}")
PYEOF

step "Deleting CloudFront signing SecureString: /${STACK_PREFIX}/app-creds/_cloudfront-signing"
try_delete "/${STACK_PREFIX}/app-creds/_cloudfront-signing" \
  ssm delete-parameter --name "/${STACK_PREFIX}/app-creds/_cloudfront-signing"

# ── Step 5: S3 files bucket ───────────────────────────────────────────────────

step "Emptying S3 files bucket: $FILES_BUCKET"
if exists s3api head-bucket --bucket "$FILES_BUCKET"; then
  try_quiet s3api delete-bucket-policy --bucket "$FILES_BUCKET"
  empty_bucket "$FILES_BUCKET" || record_failure "could not empty $FILES_BUCKET"
  try_delete "$FILES_BUCKET" s3api delete-bucket --bucket "$FILES_BUCKET" --region "$REGION"
fi

# ── Step 6: S3 billing bucket ─────────────────────────────────────────────────

step "Emptying S3 billing bucket: $BILLING_BUCKET"
if exists s3api head-bucket --bucket "$BILLING_BUCKET"; then
  empty_bucket "$BILLING_BUCKET" || record_failure "could not empty $BILLING_BUCKET"
  try_delete "$BILLING_BUCKET" s3api delete-bucket --bucket "$BILLING_BUCKET" --region "$REGION"
fi

# ── Step 7: CUR report ────────────────────────────────────────────────────────

step "Deleting CUR report: $CUR_REPORT"
CUR_COUNT=$(aws_call cur describe-report-definitions --region us-east-1 \
  --query "ReportDefinitions[?ReportName=='${CUR_REPORT}'] | length(@)" --output text) || true
if [[ "$CUR_COUNT" == "1" ]]; then
  try_delete "$CUR_REPORT" cur delete-report-definition --report-name "$CUR_REPORT" --region us-east-1
else
  skip
fi

# ── Step 8: cloud-data-server IAM role ────────────────────────────────────────

delete_role "$CDS_ROLE"

# ── Step 9: Strip stale cloud-data-server keys from config.json ───────────────
# The installer writes these keys into ~/.starkeep/config.json as it creates
# each resource. They all point at resources this script just destroyed, so a
# subsequent fresh install would otherwise start with dangling values. We only
# remove the keys the cloud-data-server install owns — bootstrap-level values
# (Cognito pool ids, account, permissions boundaries, managerRoleArn,
# pulumiStateBucket, nodeId, stackPrefix) survive cloud-data-server teardown
# and are left untouched. Skipped silently if config.json is absent.
#
# Only when the config describes this same prefix+region do we know its keys
# point at the resources we just destroyed (see CONFIG_MATCHES_TEARDOWN above).
# Otherwise it belongs to a different deployment — typically the operator's real
# one under the default $HOME/.starkeep — whose gateway, bucket and DSQL cluster
# are all still live, and blanking its keys would strand a working install.

if [[ "$CONFIG_MATCHES_TEARDOWN" != "true" ]]; then
  step "Leaving $CONFIG_FILE untouched (describes prefix '${CONFIG_STACK_PREFIX:-<none>}' / region '${CONFIG_REGION:-<none>}', not ${STACK_PREFIX}/${REGION})"
elif [[ -f "$CONFIG_FILE" ]]; then
  step "Clearing stale cloud-data-server keys from $CONFIG_FILE"
  python3 - "$CONFIG_FILE" << 'PYEOF'
import json, sys

path = sys.argv[1]
# Keys written by installCloudDataServer / cli-install-cloud-data-server as each
# resource is created. Keep this list in sync with the installer's config writes.
STALE = [
    "apiGatewayUrl",
    "publicBaseUrl",
    "cloudfrontDomain",
    # The domain's certificates and records are gone with the distribution,
    # so a reinstall starts with no domain, as after the uninstall CLI.
    "customDomain",
    "customDomainStatus",
    "customDomainAttempted",
    "customDomainKept",
    "apiGatewayId",
    "apiGatewayExecutionArn",
    "authorizerId",
    "s3Bucket",
    "auroraEndpoint",
]

with open(path) as f:
    config = json.load(f)

removed = [k for k in STALE if k in config]
for k in removed:
    config.pop(k, None)

if removed:
    with open(path, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")
    print("  Removed: " + ", ".join(removed))
else:
    print("  No stale keys present.")
PYEOF
else
  step "Clearing stale cloud-data-server keys from $CONFIG_FILE"
  skip
fi

finish_teardown "Cloud-data-server teardown"
