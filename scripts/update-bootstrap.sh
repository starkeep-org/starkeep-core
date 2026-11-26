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
# The script runs `starkeep cloud bootstrap-update`, which does the work, and
# keeps its flags. It rebuilds @starkeep/aws-bootstrap first, so the render
# uses the template this checkout holds.
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

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

echo "Building @starkeep/aws-bootstrap..."
(cd "$REPO_DIR" && pnpm -F @starkeep/aws-bootstrap build >/dev/null)

exec node "$REPO_DIR/scripts/starkeep.mjs" cloud bootstrap-update "$@"
