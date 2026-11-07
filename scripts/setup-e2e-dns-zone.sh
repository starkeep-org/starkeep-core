#!/usr/bin/env bash
# Sets up the DNS zone the custom-domain e2e suite runs in, or removes it.
#
# The suite (e2e-aws-custom-domain) attaches real custom domains to a test
# stack, so it needs a public Route53 zone of its own: a subdomain of a domain
# you control, such as e2e.example.com. Every record a run writes lands in this
# zone, and the zone your domain already uses receives none of them.
#
# Setup, which you run once:
#   1. Refuses a bare registrable domain such as example.com, so the script
#      never takes over a whole domain.
#   2. Creates the public hosted zone <zone> in the account of the ambient AWS
#      credentials, or reuses an existing zone of that name that holds only its
#      NS and SOA records.
#   3. Delegates the zone. When the parent zone sits in the same account, the
#      script shows the one NS record it will add there, asks first, and adds it
#      with CREATE, which fails if any record exists at the name. Otherwise it
#      prints the four name servers to add as an NS record at your DNS provider.
#   4. Waits until public DNS answers for the zone, then prints the line to put
#      in the repository's .env.
#
# Removal: --delete <zone> refuses while the zone holds any record besides its
# NS and SOA records, removes the parent's NS record when the parent sits in the
# account, and deletes the zone. A parent elsewhere keeps its NS record until
# you remove it at your provider.
#
# The zone costs $0.50 a month. The suite itself never creates or deletes the
# zone or its delegation.
#
# Usage: ./setup-e2e-dns-zone.sh [--yes|-y] <zone>
#        ./setup-e2e-dns-zone.sh --delete [--yes|-y] <zone>
#
# The AWS credentials come from the environment (AWS_PROFILE and the rest) and
# must be for the account the test stack runs in: the installer looks for the
# zone in that account only.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/load-env.sh"

# ── Parse flags ───────────────────────────────────────────────────────────────

DELETE=false
YES=false
ZONE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete) DELETE=true; shift ;;
    --yes|-y) YES=true; shift ;;
    -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *)
      [[ -z "$ZONE" ]] || { echo "Name one zone." >&2; exit 1; }
      ZONE="$1"; shift ;;
  esac
done

[[ -n "$ZONE" ]] || { echo "Usage: $0 [--delete] [--yes] <zone>" >&2; exit 1; }
ZONE=$(printf '%s' "$ZONE" | tr '[:upper:]' '[:lower:]')
ZONE="${ZONE%.}"

confirm() {
  [[ "$YES" == true ]] && return 0
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == y || "$answer" == Y ]]
}

# ── Check the name ────────────────────────────────────────────────────────────

if ! [[ "$ZONE" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "Error: $ZONE is not a valid DNS name." >&2
  exit 1
fi

# A registrable domain is one label under a public suffix. Without a public
# suffix list the check covers the common shapes: any name of two labels, and
# a name of three labels under a well-known two-label suffix such as co.uk.
# It guards against a slip, not against every suffix in the world.
LABELS=$(awk -F. '{print NF}' <<<"$ZONE")
PARENT="${ZONE#*.}"
TWO_LABEL_SUFFIXES=" co.uk org.uk ac.uk gov.uk me.uk com.au net.au org.au co.nz co.jp co.za com.br com.cn co.in co.kr com.mx com.tr com.sg "
if (( LABELS < 3 )) || { (( LABELS == 3 )) && [[ "$TWO_LABEL_SUFFIXES" == *" $PARENT "* ]]; }; then
  echo "Error: $ZONE is a whole registrable domain. Name a subdomain of it, such as e2e.$ZONE." >&2
  exit 1
fi

# ── Look up the account's zones ───────────────────────────────────────────────

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ZONES_JSON=$(aws route53 list-hosted-zones --output json)

# The public zone named exactly $ZONE, as "<id>", or "" for none. More than one
# zone of that name is ambiguous, and the installer would pick one at random.
ZONE_ID=$(python3 -I -c '
import json, sys
zones = [z for z in json.loads(sys.argv[1])["HostedZones"]
         if not z.get("Config", {}).get("PrivateZone")
         and z["Name"].rstrip(".").lower() == sys.argv[2]]
if len(zones) > 1:
    sys.exit("Error: the account holds %d public zones named %s; keep one." % (len(zones), sys.argv[2]))
print(zones[0]["Id"].split("/")[-1] if zones else "")
' "$ZONES_JSON" "$ZONE")

# The longest public zone in the account that ends $ZONE, other than $ZONE
# itself, as "<id> <name>", or "" when the parent lives elsewhere.
read -r PARENT_ID PARENT_NAME < <(python3 -I -c '
import json, sys
zone = sys.argv[2]
best = None
for z in json.loads(sys.argv[1])["HostedZones"]:
    if z.get("Config", {}).get("PrivateZone"):
        continue
    name = z["Name"].rstrip(".").lower()
    if zone.endswith("." + name) and (best is None or len(name) > len(best[1])):
        best = (z["Id"].split("/")[-1], name)
print(" ".join(best) if best else "")
' "$ZONES_JSON" "$ZONE") || true

# Every record set in a zone except the apex NS and SOA, one per line.
other_records() {
  aws route53 list-resource-record-sets --hosted-zone-id "$1" --output json | python3 -I -c '
import json, sys
zone = sys.argv[1]
for rs in json.load(sys.stdin)["ResourceRecordSets"]:
    if rs["Name"].rstrip(".").lower() == zone and rs["Type"] in ("NS", "SOA"):
        continue
    print("  %s %s" % (rs["Type"], rs["Name"]))
' "$ZONE"
}

# The parent's NS record set at $ZONE as JSON, or "" for none.
parent_ns_record() {
  aws route53 list-resource-record-sets --hosted-zone-id "$PARENT_ID" \
    --start-record-name "$ZONE." --start-record-type NS --max-items 1 --output json | python3 -I -c '
import json, sys
for rs in json.load(sys.stdin)["ResourceRecordSets"]:
    if rs["Name"].rstrip(".").lower() == sys.argv[1] and rs["Type"] == "NS":
        print(json.dumps(rs))
' "$ZONE"
}

echo "Account: $ACCOUNT"
echo "Zone:    $ZONE"
if [[ -n "$PARENT_ID" ]]; then
  echo "Parent:  $PARENT_NAME ($PARENT_ID), in this account"
else
  echo "Parent:  not in this account"
fi
echo ""

# ── --delete ──────────────────────────────────────────────────────────────────

if [[ "$DELETE" == true ]]; then
  if [[ -z "$ZONE_ID" ]]; then
    echo "The account holds no public zone named $ZONE. Nothing to delete."
    exit 0
  fi
  LEFT=$(other_records "$ZONE_ID")
  if [[ -n "$LEFT" ]]; then
    echo "Error: $ZONE still holds records besides its NS and SOA records:" >&2
    echo "$LEFT" >&2
    echo "A test run may still be using the zone. Remove the records, then run this again." >&2
    exit 1
  fi
  confirm "Delete the zone $ZONE ($ZONE_ID) and its delegation?" || { echo "Nothing changed."; exit 0; }

  if [[ -n "$PARENT_ID" ]]; then
    RECORD=$(parent_ns_record)
    if [[ -n "$RECORD" ]]; then
      BATCH=$(python3 -I -c 'import json,sys; print(json.dumps({"Changes":[{"Action":"DELETE","ResourceRecordSet":json.loads(sys.argv[1])}]}))' "$RECORD")
      aws route53 change-resource-record-sets --hosted-zone-id "$PARENT_ID" --change-batch "$BATCH" >/dev/null
      echo "Deleted the NS record $ZONE from $PARENT_NAME."
    fi
  fi
  aws route53 delete-hosted-zone --id "$ZONE_ID" >/dev/null
  echo "Deleted the zone $ZONE."
  if [[ -z "$PARENT_ID" ]]; then
    echo "Remove the NS record for $ZONE at your DNS provider."
  fi
  exit 0
fi

# ── Create or reuse the zone ──────────────────────────────────────────────────

if [[ -n "$ZONE_ID" ]]; then
  LEFT=$(other_records "$ZONE_ID")
  if [[ -n "$LEFT" ]]; then
    echo "Error: the zone $ZONE ($ZONE_ID) already holds records besides its NS and SOA records:" >&2
    echo "$LEFT" >&2
    echo "The suite needs a zone of its own. Name another zone, or empty this one first." >&2
    exit 1
  fi
  echo "Reusing the empty zone $ZONE ($ZONE_ID)."
else
  confirm "Create the public hosted zone $ZONE in account $ACCOUNT (\$0.50 a month)?" \
    || { echo "Nothing changed."; exit 0; }
  ZONE_ID=$(aws route53 create-hosted-zone --name "$ZONE" \
    --caller-reference "starkeep-e2e-$(date +%s)" \
    --hosted-zone-config "Comment=Starkeep custom-domain e2e test zone,PrivateZone=false" \
    --query 'HostedZone.Id' --output text)
  ZONE_ID="${ZONE_ID##*/}"
  echo "Created the zone $ZONE ($ZONE_ID)."
fi

NAME_SERVERS=$(aws route53 get-hosted-zone --id "$ZONE_ID" \
  --query 'DelegationSet.NameServers' --output text | tr '\t' '\n' | sort)

# ── Delegate ──────────────────────────────────────────────────────────────────

if [[ -n "$PARENT_ID" ]]; then
  EXISTING=$(parent_ns_record)
  WANT=$(python3 -I -c '
import json, sys
print(json.dumps({"Name": sys.argv[1] + ".", "Type": "NS", "TTL": 300,
                  "ResourceRecords": [{"Value": n + "."} for n in sys.argv[2].split()]}))
' "$ZONE" "$NAME_SERVERS")
  if [[ -n "$EXISTING" ]]; then
    SAME=$(python3 -I -c '
import json, sys
a, b = json.loads(sys.argv[1]), json.loads(sys.argv[2])
norm = lambda rs: sorted(v["Value"].rstrip(".").lower() for v in rs.get("ResourceRecords", []))
print("yes" if norm(a) == norm(b) else "no")
' "$EXISTING" "$WANT")
    if [[ "$SAME" != yes ]]; then
      echo "Error: $PARENT_NAME already has an NS record at $ZONE that names other name servers." >&2
      echo "Remove it, or name another zone." >&2
      exit 1
    fi
    echo "$PARENT_NAME already delegates $ZONE to this zone."
  else
    echo "This adds one record to $PARENT_NAME ($PARENT_ID):"
    echo "  $ZONE. 300 NS"
    sed 's/^/    /' <<<"$NAME_SERVERS"
    confirm "Add it?" || { echo "The zone exists but is not delegated. Run this again to delegate it."; exit 0; }
    BATCH=$(python3 -I -c 'import json,sys; print(json.dumps({"Changes":[{"Action":"CREATE","ResourceRecordSet":json.loads(sys.argv[1])}]}))' "$WANT")
    aws route53 change-resource-record-sets --hosted-zone-id "$PARENT_ID" --change-batch "$BATCH" >/dev/null
    echo "Added the NS record."
  fi
else
  echo "Add one NS record for $ZONE at the DNS provider of its parent domain, naming:"
  sed 's/^/  /' <<<"$NAME_SERVERS"
  echo ""
  echo "Waiting for public DNS to answer for $ZONE. Press Ctrl-C to stop; running this"
  echo "again picks up where it left off."
fi

# ── Wait for the delegation ───────────────────────────────────────────────────

delegated() {
  local published
  published=$(dig +short NS "$ZONE" @1.1.1.1 2>/dev/null | sed 's/\.$//' | tr '[:upper:]' '[:lower:]' | sort)
  [[ -n "$published" ]] && comm -12 <(echo "$published") <(tr '[:upper:]' '[:lower:]' <<<"$NAME_SERVERS" | sort) | grep -q .
}

for _ in $(seq 1 120); do
  if delegated; then
    echo ""
    echo "Public DNS delegates $ZONE to this zone. Add this line to the repository's .env:"
    echo ""
    echo "  STARKEEP_AWS_CUSTOM_DOMAIN_ZONE=$ZONE"
    exit 0
  fi
  sleep 15
done

echo "Error: public DNS still does not delegate $ZONE after 30 minutes." >&2
echo "Check the NS record at the parent, then run this again." >&2
exit 1
