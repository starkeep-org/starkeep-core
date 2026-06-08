# Stop reading runtime config from env in local-data-server

`apps/local-data-server/server.ts` reads 11 env vars at boot. `~/.starkeep/config.json` already exists and is loaded at line 298 — it should be the single source of truth. The current env path duplicates config, masks a real HLC correctness bug, and lets misconfigured deployments boot under placeholder defaults.

## The HLC `NODE_ID` bug (the load-bearing reason to do this)

`server.ts:67` reads `const NODE_ID = process.env.STARKEEP_NODE_ID || "starkeep-local";` and feeds it to the HLC clock at `server.ts:396` (`createHLCClock({ nodeId: NODE_ID, wallClockFunction: Date.now })`).

HLC's causal-ordering guarantee requires `nodeId` to be **unique per replica**. The default is a literal string. Any user running two local servers without setting the env var produces two HLC streams sharing a node identifier — and the Drive sync watermark map `{ [nodeId]: HLC }` (see `system-design.md`'s "Sync semantics for shared data") keys on it. Two physically distinct replicas become indistinguishable to the watermark logic, and HLC equality/ordering on `(wallTime, counter, nodeId)` can collide.

Fix:

- Generate `nodeId` once at first boot (e.g. `ulid()` or `randomUUID()`).
- Persist it in `~/.starkeep/config.json` alongside the existing cloud fields.
- No env read, no literal default.

The same shape applies on the cloud side: any cloud-data-server replica needs a stable `nodeId` derived from something identifying that replica, not a literal string.

## The other env reads

`server.ts:57-69`, `308`, `374-385`:

| Var | Default | Disposition |
|---|---|---|
| `STARKEEP_DIR` | `~/.starkeep` | Keep — chicken-and-egg with the config file's own location. |
| `STARKEEP_PORT` | `9820` | Keep (runtime/CLI concern), or move to config — caller's preference. |
| `STARKEEP_OWNER_ID` | `"starkeep-user"` | Removed by [[todo-shared-data-drop-owner-id-field]]; field is being dropped. |
| `STARKEEP_NODE_ID` | `"starkeep-local"` | Generated-once, persisted in config (see above). |
| `STARKEEP_PULL_INTERVAL_MS` | 30000 | Move to config. |
| `STARKEEP_PUSH_DEBOUNCE_MS` | 500 | Move to config. |
| `STARKEEP_CLOUD_URL` | — | Delete — redundant with `starkeepConfig.apiGatewayUrl`. |
| `STARKEEP_S3_BUCKET` / `_REGION` / `_KEY_PREFIX` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | — | Delete the env fallback — config already supplies the bucket and region; the access-key pair is a relic from before Cognito-broker creds were in use. |

## Scope

Out of scope: `STARKEEP_DIR`, `STARKEEP_PORT` (justified env-vars), and `STARKEEP_OWNER_ID` (handled by [[todo-shared-data-drop-owner-id-field]]).

In scope: items marked "move to config", "delete", or "generated-once" above. Code lives entirely in `apps/local-data-server/server.ts` plus whatever config schema updates `loadStarkeepConfig()` needs to gain.

## Connections

- [[todo-shared-data-drop-owner-id-field]] — finishes off `STARKEEP_OWNER_ID`.
- Cloud-side `nodeId` discipline mirrors this; if the cloud-data-server has the same hardcoded default, fix it together.
