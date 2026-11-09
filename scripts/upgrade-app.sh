#!/usr/bin/env bash
# Reapply an installed app's manifest to the local data server.
#
# An app's manifest reaches its install exactly once, at install time. Change a
# column type, add an index, add a table or a label key, narrow a grant, and the
# installed app keeps the manifest it was installed with — because `installLocal`
# gates its schema steps on a completed-step ledger. The only action that *does*
# apply a manifest change is Uninstall, which drops the app's syncable tables.
#
# This is the non-destructive route. It POSTs the app's on-disk manifest to
# `/admin/apps/install`, which reapplies every schema step: it creates tables
# and indexes that do not exist, rewrites the access grants, the label keys and
# the namespace row the query parser validates against, and refreshes the stored
# manifest. Every step is idempotent. No row is touched, and the app's HMAC
# secret, its install date and its data all survive.
#
# It is not a migration. Both installers create tables `IF NOT EXISTS`, so a
# column whose declared type changed keeps its physical type. On SQLite that is
# usually invisible — `boolean` and `integer` are both INTEGER, `timestamp` and
# `text` are both TEXT — but a change that crosses storage classes needs a drop,
# and this script cannot apply it.
#
# Usage:
#   scripts/upgrade-app.sh --diff memo        # what is stale, no writes
#   scripts/upgrade-app.sh memo               # apply, and report what moved
#   scripts/upgrade-app.sh --diff             # every installed app
#   STARKEEP_PORT=9821 scripts/upgrade-app.sh photos
#
# An app reapplies the manifest in the folder it was installed from, which the
# registry pins. An app installed before the registry pinned folders resolves
# the way admin-web resolves it (`scanApps` in
# packages/admin-installer/src/app-discovery.ts): an `appParentDirs` entry in
# ~/.starkeep/config.json that holds a `starkeep.manifest.json` is one app, and
# any other entry is scanned one level deep, skipping node_modules and
# dot-folders. Two folders with one id are refused, and the reapply pins the
# folder it used. The data server must be running —
# `/admin/apps/install` is localhost-only and takes no HMAC, and going through
# it rather than writing SQLite directly is what makes the server pick up the
# change: it rescans the sync supervisor and refreshes the size-class keys.
set -euo pipefail

PORT="${STARKEEP_PORT:-9820}"
BASE="http://127.0.0.1:${PORT}"
DIFF_ONLY=0
APPS=()

for arg in "$@"; do
  case "$arg" in
    --diff) DIFF_ONLY=1 ;;
    -h|--help) sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) APPS+=("$arg") ;;
  esac
done

if ! curl -sS --max-time 5 "${BASE}/health" >/dev/null 2>&1; then
  echo "local data server is not answering on ${BASE} — start it first" >&2
  exit 1
fi

BASE="$BASE" DIFF_ONLY="$DIFF_ONLY" APPS="${APPS[*]-}" python - <<'PY'
import json, os, sqlite3, sys, urllib.error, urllib.request
from pathlib import Path

BASE = os.environ["BASE"]
DIFF_ONLY = os.environ["DIFF_ONLY"] == "1"
WANTED = [a for a in os.environ.get("APPS", "").split() if a]

STARKEEP_DIR = Path(os.environ.get("STARKEEP_DIR", Path.home() / ".starkeep"))
DB_PATH = STARKEEP_DIR / "data.db"
CONFIG_PATH = STARKEEP_DIR / "config.json"


def registry_rows():
    """The registry's own rows, read-only. The server holds this DB open."""
    if not DB_PATH.is_file():
        sys.exit(f"no registry database at {DB_PATH}")
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        return list(db.execute("SELECT app_id, manifest, source_dir FROM shared_app_registry"))
    finally:
        db.close()


def stored_manifests():
    return {app_id: json.loads(raw) if raw else None for app_id, raw, _ in registry_rows()}


def read_manifest(app_dir):
    manifest_path = app_dir / "starkeep.manifest.json"
    if not (app_dir.is_dir() and manifest_path.is_file()):
        return None
    try:
        return manifest_path, json.loads(manifest_path.read_text())
    except ValueError:
        return None


# Every scanned folder for each id. Like app-scan, folder order picks no
# winner: an unpinned id that two folders hold is refused below.
scanned = {}
try:
    parents = [
        Path(os.path.expanduser(d))
        for d in json.loads(CONFIG_PATH.read_text()).get("appParentDirs", [])
        if isinstance(d, str) and d
    ]
except (OSError, ValueError):
    parents = []
for parent in parents:
    if not parent.is_dir():
        continue
    if (parent / "starkeep.manifest.json").is_file():
        candidates = [parent]
    else:
        candidates = [
            d for d in sorted(parent.iterdir())
            if d.name != "node_modules" and not d.name.startswith(".")
        ]
    for app_dir in candidates:
        found = read_manifest(app_dir)
        if found is None:
            continue
        key = found[1].get("id") or app_dir.name
        if all(p.parent.resolve() != app_dir.resolve() for p, _ in scanned.get(key, [])):
            scanned.setdefault(key, []).append(found)

before = stored_manifests()
pins = {app_id: pin for app_id, _, pin in registry_rows() if pin}
targets = WANTED or sorted(before)

missing = [a for a in targets if a not in before]
if missing:
    sys.exit(
        f"not installed: {', '.join(missing)}\n"
        "this reapplies an existing install; install it from admin-web first"
    )
# An installed app's pinned folder, else its one scanned folder.
on_disk = {}
problems = []
for app_id in targets:
    if app_id in pins:
        found = read_manifest(Path(os.path.expanduser(pins[app_id])))
        if found is None:
            problems.append(f"{app_id}: its pinned folder {pins[app_id]} holds no manifest")
        elif found[1].get("id") != app_id:
            # Reapplying would install that other app, pinned to this folder.
            problems.append(
                f"{app_id}: its pinned folder {pins[app_id]} now holds app {found[1].get('id')!r}"
            )
        else:
            on_disk[app_id] = found
        continue
    copies = scanned.get(app_id, [])
    if len(copies) == 1:
        on_disk[app_id] = copies[0]
    elif copies:
        folders = ", ".join(str(p.parent) for p, _ in copies)
        problems.append(f"{app_id}: two folders hold it ({folders})")
    else:
        problems.append(f"{app_id}: no manifest found in appParentDirs in {CONFIG_PATH}")
if problems:
    sys.exit("\n".join(problems))


def leaves(value, path=""):
    """Flatten to {path: value}. Lists compare whole; a list of one changed
    element reports as one difference rather than as a rewritten array."""
    if isinstance(value, dict):
        out = {}
        for key, child in value.items():
            out.update(leaves(child, f"{path}.{key}"))
        return out
    if isinstance(value, list) and all(isinstance(v, dict) for v in value) and value:
        out = {}
        for i, child in enumerate(value):
            out.update(leaves(child, f"{path}[{i}]"))
        return out
    return {path: value}


def differences(old_doc, new_doc):
    a, b = leaves(old_doc or {}), leaves(new_doc or {})
    for key in sorted(set(a) | set(b)):
        old, new = a.get(key, "<absent>"), b.get(key, "<absent>")
        if old != new:
            yield key.lstrip("."), old, new


def report(diffs, indent="  "):
    for key, old, new in diffs:
        print(f"{indent}{key}")
        print(f"{indent}    was : {json.dumps(old)[:200]}")
        print(f"{indent}    now : {json.dumps(new)[:200]}")


if DIFF_ONLY:
    # Raw file against the stored (validated, defaulted) row, so every field the
    # schema defaults shows up as a difference. Noisy and honest; the accurate
    # comparison is the one the apply path prints, which has both sides in the
    # same form.
    for app_id in targets:
        manifest_path, manifest = on_disk[app_id]
        print(f"=== {app_id}  ({manifest_path})")
        diffs = list(differences(before[app_id], manifest))
        if not diffs:
            print("  identical")
        report(diffs)
    print()
    print("Fields the schema defaults appear here as differences. Re-run without")
    print("--diff to apply, which prints the stored row before against after.")
    sys.exit(0)

exit_code = 0
applied = []
for app_id in targets:
    manifest_path, manifest = on_disk[app_id]
    request = urllib.request.Request(
        f"{BASE}/admin/apps/install",
        data=json.dumps(
            {"manifest": manifest, "sourceDir": str(manifest_path.parent)}
        ).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as resp:
            json.load(resp)
        applied.append(app_id)
    except urllib.error.HTTPError as err:
        print(f"FAILED {app_id}: {err.code} {err.read().decode()[:500]}", file=sys.stderr)
        exit_code = 1

after = stored_manifests()
for app_id in applied:
    print(f"=== {app_id}  ({on_disk[app_id][0]})")
    diffs = list(differences(before[app_id], after[app_id]))
    if not diffs:
        print("  already current — schema steps reapplied, nothing in the manifest moved")
    report(diffs)

if applied:
    print()
    print("A declared column type that crosses a storage class is NOT applied by")
    print("this script: both installers create tables IF NOT EXISTS. On SQLite")
    print("boolean/integer and timestamp/text share one physical type, so those")
    print("are declaration-only and did move.")

sys.exit(exit_code)
PY
