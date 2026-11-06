#!/usr/bin/env bash
# Updates an existing Starkeep bootstrap stack to the template this checkout
# renders.
#
# Renders the template from packages/aws-bootstrap and previews the update as a
# CloudFormation change set. Without --apply, the script deletes the change set
# and changes nothing. With --apply, it applies the previewed change set after
# confirmation. Every parameter the live stack already has keeps its previous
# value, so the update never touches AdminEmail and never replaces the first
# admin.
#
# The template bakes the deployment name into the invitation email as literal
# text, so the render takes the name from config.json. A name that differs
# from the one the stack was created with shows up as a change to UserPool.
#
# The change set refuses to apply when it replaces or removes a resource,
# unless --allow-replacement is passed.
#
# --verbose prints each changed property with a diff of its old and new value.
# A "Dynamic" change names a value CloudFormation resolves only during the
# update, such as another resource's ARN, and usually changes nothing.
#
# Usage: ./update-bootstrap.sh [--apply] [--yes|-y] [--allow-replacement] [--verbose|-v]
#          [--prefix <stack-prefix>] [--region <region>] [--deployment-name <name>]
#
# --prefix and --deployment-name default to config.json. --region defaults to
# the region of config.json's userPoolId. The AWS credentials come from the
# environment (AWS_PROFILE and the rest) and need CloudFormation and IAM admin
# in the deployment's account. The script stops when the caller's account
# differs from config.json's accountId.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$SCRIPT_DIR/load-env.sh"

STARKEEP_DIR="${STARKEEP_DIR:-$HOME/.starkeep}"
CONFIG_FILE="$STARKEEP_DIR/config.json"

# ── Parse flags ───────────────────────────────────────────────────────────────

APPLY=false
YES=false
ALLOW_REPLACEMENT=false
VERBOSE=false
STACK_PREFIX=""
REGION=""
DEPLOYMENT_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --yes|-y) YES=true; shift ;;
    --allow-replacement) ALLOW_REPLACEMENT=true; shift ;;
    --verbose|-v) VERBOSE=true; shift ;;
    --prefix) STACK_PREFIX="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --deployment-name) DEPLOYMENT_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── Load config ───────────────────────────────────────────────────────────────

config_value() {
  [[ -f "$CONFIG_FILE" ]] || return 0
  python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$CONFIG_FILE" "$1"
}

CONFIG_STACK_PREFIX=$(config_value stackPrefix)
CONFIG_ACCOUNT_ID=$(config_value accountId)
CONFIG_USER_POOL_ID=$(config_value userPoolId)

STACK_PREFIX="${STACK_PREFIX:-$CONFIG_STACK_PREFIX}"
DEPLOYMENT_NAME="${DEPLOYMENT_NAME:-$(config_value deploymentName)}"
if [[ -z "$REGION" && -n "$CONFIG_USER_POOL_ID" ]]; then
  REGION="${CONFIG_USER_POOL_ID%%_*}"
fi

if [[ -z "$STACK_PREFIX" || -z "$REGION" || -z "$DEPLOYMENT_NAME" ]]; then
  echo "Error: need a stack prefix, a region and a deployment name." >&2
  echo "$CONFIG_FILE does not supply all three; pass --prefix, --region and --deployment-name." >&2
  exit 1
fi

STACK_NAME="${STACK_PREFIX}-bootstrap"
export AWS_REGION="$REGION"

# ── Check the account ─────────────────────────────────────────────────────────

CALLER_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if [[ -n "$CONFIG_ACCOUNT_ID" && "$CONFIG_STACK_PREFIX" == "$STACK_PREFIX" && "$CALLER_ACCOUNT" != "$CONFIG_ACCOUNT_ID" ]]; then
  echo "Error: these credentials belong to account $CALLER_ACCOUNT, but $CONFIG_FILE names $CONFIG_ACCOUNT_ID." >&2
  echo "Set AWS_PROFILE to a profile for $CONFIG_ACCOUNT_ID." >&2
  exit 1
fi

echo "Stack:           $STACK_NAME"
echo "Account:         $CALLER_ACCOUNT"
echo "Region:          $REGION"
echo "Deployment name: $DEPLOYMENT_NAME"
echo ""

# ── Render the template ───────────────────────────────────────────────────────

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
TEMPLATE="$WORK_DIR/starkeep-bootstrap-template.yaml"

echo "Building @starkeep/aws-bootstrap..."
(cd "$REPO_DIR" && pnpm -F @starkeep/aws-bootstrap build >/dev/null)

STACK_PREFIX="$STACK_PREFIX" DEPLOYMENT_NAME="$DEPLOYMENT_NAME" BOOTSTRAP_DIST="$REPO_DIR/packages/aws-bootstrap/dist/index.js" \
  node --input-type=module -e '
    const { generateBootstrapTemplate } = await import(process.env.BOOTSTRAP_DIST);
    process.stdout.write(generateBootstrapTemplate({
      stackPrefix: process.env.STACK_PREFIX,
      deploymentName: process.env.DEPLOYMENT_NAME,
    }));
  ' >"$TEMPLATE"

TEMPLATE_BYTES=$(wc -c <"$TEMPLATE" | tr -d ' ')
if (( TEMPLATE_BYTES > 51200 )); then
  echo "Error: the template is $TEMPLATE_BYTES bytes, over CloudFormation's 51,200-byte inline limit." >&2
  exit 1
fi

# ── Preview ───────────────────────────────────────────────────────────────────

# Keep every parameter the live stack has. A parameter new to the template
# takes its default, which is empty for AdminEmail on a re-render.
EXISTING_KEYS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Parameters[].ParameterKey' --output text)
PARAMS=()
for key in $EXISTING_KEYS; do
  PARAMS+=("ParameterKey=$key,UsePreviousValue=true")
done

CHANGE_SET="update-bootstrap-$(date +%Y%m%d-%H%M%S)"
echo "Creating change set $CHANGE_SET..."
aws cloudformation create-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET" \
  --change-set-type UPDATE \
  --template-body "file://$TEMPLATE" \
  --parameters "${PARAMS[@]}" \
  --capabilities CAPABILITY_NAMED_IAM >/dev/null

delete_change_set() {
  aws cloudformation delete-change-set --stack-name "$STACK_NAME" --change-set-name "$CHANGE_SET" >/dev/null
}

if ! aws cloudformation wait change-set-create-complete \
  --stack-name "$STACK_NAME" --change-set-name "$CHANGE_SET" 2>/dev/null; then
  REASON=$(aws cloudformation describe-change-set --stack-name "$STACK_NAME" \
    --change-set-name "$CHANGE_SET" --query StatusReason --output text)
  delete_change_set
  if [[ "$REASON" == *"didn't contain changes"* || "$REASON" == *"No updates are to be performed"* ]]; then
    echo "The stack already matches this template. Nothing to do."
    exit 0
  fi
  echo "Error: the change set failed: $REASON" >&2
  exit 1
fi

echo ""
aws cloudformation describe-change-set --stack-name "$STACK_NAME" --change-set-name "$CHANGE_SET" \
  --query "Changes[].ResourceChange.{Action:Action,Resource:LogicalResourceId,Type:ResourceType,Replacement:Replacement,Scope:join(',',Scope)}" \
  --output table

if [[ "$VERBOSE" == "true" ]]; then
  # With property values the change set comes back in pages, which the CLI
  # does not follow for this command.
  PAGE=0
  TOKEN=""
  while :; do
    aws cloudformation describe-change-set --stack-name "$STACK_NAME" --change-set-name "$CHANGE_SET" \
      --include-property-values ${TOKEN:+--next-token "$TOKEN"} --output json >"$WORK_DIR/change-set-$PAGE.json"
    TOKEN=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('NextToken',''))" "$WORK_DIR/change-set-$PAGE.json")
    [[ -z "$TOKEN" ]] && break
    PAGE=$((PAGE + 1))
  done
  # Property values leave out every change CloudFormation resolves only during
  # the update, so the plain listing supplies those.
  aws cloudformation describe-change-set --stack-name "$STACK_NAME" --change-set-name "$CHANGE_SET" \
    --output json >"$WORK_DIR/change-set-plain.json"
  aws cloudformation get-template --stack-name "$STACK_NAME" --template-stage Original \
    --output json >"$WORK_DIR/live-template.json"

  COLOR=$([[ -t 1 ]] && echo 1 || echo 0) python3 -I - "$WORK_DIR/live-template.json" "$TEMPLATE" \
    "$WORK_DIR/change-set-plain.json" "$WORK_DIR"/change-set-[0-9]*.json <<'PY'
import difflib, json, os, sys

color = os.environ.get("COLOR") == "1"

def paint(line):
    if not color:
        return line
    if line.startswith("+") and not line.startswith("+++"):
        return f"\033[32m{line}\033[0m"
    if line.startswith("-") and not line.startswith("---"):
        return f"\033[31m{line}\033[0m"
    if line.startswith("@@"):
        return f"\033[36m{line}\033[0m"
    return line

def lines(value):
    if value is None:
        return []
    try:
        value = json.dumps(json.loads(value), indent=2, sort_keys=True)
    except (TypeError, ValueError):
        pass
    return value.splitlines()

def print_diff(before, after, indent):
    for line in difflib.unified_diff(before, after, "before", "after", n=3, lineterm=""):
        print(indent + paint(line))

def logical_id(change):
    return change["ResourceChange"]["LogicalResourceId"]

live_path, template_path, plain_path, *page_paths = sys.argv[1:]
with_values = {logical_id(c): c for p in page_paths for c in json.load(open(p))["Changes"]}
changes = [with_values.get(logical_id(c), c) for c in json.load(open(plain_path))["Changes"]]
truncated = False
for change in changes:
    rc = change["ResourceChange"]
    print(f"\n== {rc['LogicalResourceId']} ({rc['ResourceType']}): {rc['Action']}, replacement {rc.get('Replacement', 'n/a')}")
    seen = set()
    for detail in rc.get("Details", []):
        target = detail["Target"]
        path = target.get("Path") or target.get("Name") or target.get("Attribute")
        key = (path, detail.get("Evaluation"), target.get("BeforeValue"), target.get("AfterValue"))
        if key in seen:
            continue
        seen.add(key)
        cause = detail.get("CausingEntity") or detail.get("ChangeSource", "")
        print(f"  {path}: {target.get('AttributeChangeType', 'Modify')}, {detail.get('Evaluation')}, "
              f"recreation {target.get('RequiresRecreation')}, caused by {cause}")
        if logical_id(change) not in with_values:
            print("    (CloudFormation resolves this value during the update and lists no before or after)")
            continue
        before, after = lines(target.get("BeforeValue")), lines(target.get("AfterValue"))
        if any(v and v[0].startswith("(Truncated-Signature)") for v in (before, after)):
            truncated = True
            print("    (CloudFormation truncated this value; the template diff below shows the change)")
            continue
        if before == after:
            if before:
                print("    (value unchanged in the preview; CloudFormation resolves it during the update)")
            continue
        print_diff(before, after, "    ")

# The deployed template's source against the new one. CloudFormation leaves
# values it truncated out of the change set, but this diff always shows them.
# The deployed template can hold "?" where the source has a non-ASCII
# character, so both sides drop those characters to "?" before the diff.
def ascii_lines(text):
    return "".join(ch if ord(ch) < 128 else "?" for ch in text).splitlines()

live = json.load(open(live_path))["TemplateBody"]
if not isinstance(live, str):
    live = json.dumps(live, indent=2)
print("\n== Template diff (deployed → new)" + ("" if truncated else ", for reference"))
print_diff(ascii_lines(live), ascii_lines(open(template_path).read()), "  ")
PY
fi

RISKY=$(aws cloudformation describe-change-set --stack-name "$STACK_NAME" --change-set-name "$CHANGE_SET" \
  --query "length(Changes[?ResourceChange.Action=='Remove' || ResourceChange.Replacement=='True' || ResourceChange.Replacement=='Conditional'])" \
  --output text)

if [[ "$RISKY" != "0" && "$ALLOW_REPLACEMENT" != "true" ]]; then
  delete_change_set
  echo "" >&2
  echo "Error: the change set removes or replaces $RISKY resource(s). Nothing was applied." >&2
  echo "Review the table above, then rerun with --allow-replacement if the change is intended." >&2
  exit 1
fi

if [[ "$APPLY" != "true" ]]; then
  delete_change_set
  echo ""
  echo "Preview only: deleted the change set. Nothing was applied."
  echo "Rerun with --apply to apply this update."
  exit 0
fi

if [[ "$YES" != "true" ]]; then
  read -r -p "Apply this change set to $STACK_NAME? [y/N] " ANSWER
  if [[ "$ANSWER" != "y" && "$ANSWER" != "Y" ]]; then
    delete_change_set
    echo "Deleted the change set. Nothing was applied."
    exit 0
  fi
fi

# ── Apply ─────────────────────────────────────────────────────────────────────

echo "Applying $CHANGE_SET..."
aws cloudformation execute-change-set --stack-name "$STACK_NAME" --change-set-name "$CHANGE_SET"
if ! aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME"; then
  STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query 'Stacks[0].StackStatus' --output text)
  echo "Error: the update ended in $STATUS. CloudFormation rolls a failed update back to the previous template." >&2
  echo "The stack's events name the failing resource:" >&2
  echo "  aws cloudformation describe-stack-events --stack-name $STACK_NAME --region $REGION --max-items 20" >&2
  exit 1
fi

echo "The stack reached UPDATE_COMPLETE."
