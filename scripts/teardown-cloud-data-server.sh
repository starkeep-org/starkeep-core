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
# Usage:
#   ./teardown-cloud-data-server.sh [--yes|-y] [--force] --prefix <stack-prefix> --region <region>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Honor repo-root .env / .env.local (STARKEEP_DIR etc.) before defaulting below.
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
REGION="$FLAG_REGION"
if [[ -z "$REGION" ]]; then
  if [[ "$YES" != "true" && -t 0 ]]; then
    CONFIG_REGION="${CONFIG_USER_POOL_ID%%_*}"
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
echo "  DSQL cluster : (tagged starkeep:appId=cloud-data-server)$([[ "$FORCE" == "true" ]] && echo "  [--force: will disable deletion protection]")"
echo "  CloudFront   : distribution + OAC + cache policy + public key + key group (Part B)"
echo "  Signing key  : SSM /${STACK_PREFIX}/app-creds/_cloudfront-signing"
echo "  S3 buckets   : $FILES_BUCKET, $BILLING_BUCKET"
echo "  CUR report   : $CUR_REPORT"
echo "  IAM role     : $CDS_ROLE"
echo "  Pulumi locks : s3://${PULUMI_STATE_BUCKET}/.pulumi/locks/ (cleared, bucket kept)"
echo "  Config keys  : stale cloud-data-server keys stripped from $CONFIG_FILE"
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
    # Real user clusters enable deletion protection by design, which makes
    # delete-cluster fail. Removing the CDS stack is the whole point of this
    # script, so it can lift that protection — but never silently: only with
    # --force, or an explicit interactive y/N. Without consent the cluster is
    # left intact and we say exactly how to remove it.
    PROTECTED=$(aws dsql get-cluster --identifier "$CID" --region "$REGION" \
      --query 'deletionProtectionEnabled' --output text 2>/dev/null || echo "unknown")
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
      aws dsql update-cluster --identifier "$CID" --no-deletion-protection-enabled --region "$REGION" >/dev/null
      # update-cluster is asynchronous; wait for the cluster to settle back to
      # ACTIVE (protection cleared) before delete-cluster, or the delete races
      # the in-flight update and fails.
      aws dsql wait cluster-active --identifier "$CID" --region "$REGION" 2>/dev/null || true
    fi

    echo "  Deleting cluster: $CID"
    # Best-effort: a single cluster that refuses to delete (e.g. it is already
    # mid-delete) must NOT abort the whole teardown and leave the bootstrap
    # layer half-removed. Warn and move on.
    if aws dsql delete-cluster --identifier "$CID" --region "$REGION" 2>/tmp/dsql-del-err; then
      echo "  Delete initiated (DSQL deletion is asynchronous)."
    else
      echo "  WARN: could not delete $CID — leaving it. Reason:"
      sed 's/^/    /' /tmp/dsql-del-err
    fi
  done
  rm -f /tmp/dsql-del-err
fi

# ── Step 4b: CloudFront (Part B: shared-file signed URLs) ─────────────────────
# The platform CloudFront distribution and its URL-signing material: the
# distribution itself, the S3-origin OAC, the custom shared-files cache policy,
# and the RSA public key + key group. Deleting a distribution requires
# disable → wait-until-Deployed → delete, which is slow (~5–15 min). This whole
# step is best-effort: any failure is logged and skipped so a hiccup never
# aborts the wider teardown (these resources are idle/cheap and can be cleaned
# up by hand). Done before the files bucket because the distribution's S3 origin
# references it. Idempotent — silently skips anything already gone (e.g. an
# install that failed before creating them).

step "Deleting CloudFront distribution + signing key material"
python3 - "$STACK_PREFIX" << 'PYEOF'
import json, subprocess, sys, time

prefix = sys.argv[1]

DIST_COMMENT = f"{prefix} platform CDN"
PUBKEY_COMMENT = f"{prefix} shared-file signing key"
KEYGROUP_COMMENT = f"{prefix} shared-file signers"
OAC_NAME = f"{prefix}-files-oac"
CACHE_NAME = f"{prefix}-shared-files-cache"


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
    resource, some are flat). Best-effort — a still-referenced or absent
    resource just warns/skips."""
    try:
        data = cf(list_cmd)
        items = (data.get(list_key) or {}).get("Items", []) or []
        found = next((it for it in items if match(it)), None)
        if not found:
            print(f"  {kind}: not found, skipping.")
            return
        rid = id_of(found)
        got = cf(get_cmd, "--id", rid)
        cf(delete_cmd, "--id", rid, "--if-match", got["ETag"])
        print(f"  {kind}: deleted {rid}.")
    except Exception as e:  # noqa: BLE001 — best-effort teardown
        print(f"  WARN {kind} cleanup: {e}")


# ---- Distribution: find by comment → disable → wait Deployed → delete --------
try:
    data = cf("list-distributions")
    items = (data.get("DistributionList") or {}).get("Items", []) or []
    dist = next((d for d in items if d.get("Comment") == DIST_COMMENT), None)
    if not dist:
        print("  Distribution: not found, skipping.")
    else:
        dist_id = dist["Id"]
        print(f"  Distribution: {dist_id} (disable → wait → delete)")
        gc = cf("get-distribution-config", "--id", dist_id)
        etag, cfg = gc["ETag"], gc["DistributionConfig"]
        if cfg.get("Enabled"):
            cfg["Enabled"] = False
            path = f"/tmp/cf-disable-{dist_id}.json"
            with open(path, "w") as f:
                json.dump(cfg, f)
            print("  Disabling distribution…")
            cf("update-distribution", "--id", dist_id, "--if-match", etag,
               "--distribution-config", f"file://{path}")
        deployed = False
        deadline = time.time() + 25 * 60
        while time.time() < deadline:
            gd = cf("get-distribution", "--id", dist_id)
            status = gd["Distribution"]["Status"]
            etag = gd["ETag"]
            if status == "Deployed":
                deployed = True
                break
            print(f"  …status={status}; waiting 30s")
            time.sleep(30)
        if not deployed:
            print("  Distribution did not reach Deployed in 25m; leave for manual cleanup.")
        else:
            print("  Deleting distribution…")
            cf("delete-distribution", "--id", dist_id, "--if-match", etag)
            print("  Distribution deleted.")
except Exception as e:  # noqa: BLE001
    print(f"  WARN distribution cleanup: {e}")

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
delete_with_etag(
    "Cache policy", "list-cache-policies", "CachePolicyList",
    lambda it: it.get("CachePolicy", {}).get("CachePolicyConfig", {}).get("Name") == CACHE_NAME,
    lambda it: it["CachePolicy"]["Id"],
    "get-cache-policy", "delete-cache-policy",
)
PYEOF

step "Deleting CloudFront signing SecureString: /${STACK_PREFIX}/app-creds/_cloudfront-signing"
aws ssm delete-parameter --name "/${STACK_PREFIX}/app-creds/_cloudfront-signing" 2>/dev/null \
  && echo "  Deleted." || echo "  Not found, skipping."

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

# ── Step 9: Strip stale cloud-data-server keys from config.json ───────────────
# The installer writes these keys into ~/.starkeep/config.json as it creates
# each resource. They all point at resources this script just destroyed, so a
# subsequent fresh install would otherwise start with dangling values. We only
# remove the keys the cloud-data-server install owns — bootstrap-level values
# (Cognito pool ids, account, permissions boundaries, managerRoleArn,
# pulumiStateBucket, nodeId, stackPrefix) survive cloud-data-server teardown
# and are left untouched. Skipped silently if config.json is absent.

step "Clearing stale cloud-data-server keys from $CONFIG_FILE"
if [[ -f "$CONFIG_FILE" ]]; then
  python3 - "$CONFIG_FILE" << 'PYEOF'
import json, sys

path = sys.argv[1]
# Keys written by installCloudDataServer / cli-install-cloud-data-server as each
# resource is created. Keep this list in sync with the installer's config writes.
STALE = [
    "apiGatewayUrl",
    "publicBaseUrl",
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
  skip
fi

echo ""
echo "Cloud-data-server teardown complete."
