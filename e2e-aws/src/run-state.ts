/**
 * Per-prefix run state for the Tier-3 runner, kept under `e2e-aws/.run/<prefix>/`
 * (gitignored). The directory doubles as STARKEEP_DIR for the install CLIs and
 * the booted LDS: they read AND rewrite `$STARKEEP_DIR/config.json` and the
 * registry `$STARKEEP_DIR/data.db`, so giving them a dedicated shared dir is what
 * keeps a test run from clobbering the operator's live ~/.starkeep.
 *
 * `admin.json` holds the generated Cognito test-admin password (0600). It is
 * deliberately not a managed secret: the user it unlocks only exists in the
 * disposable test stack.
 *
 * The dir holds two KINDS of state, and the difference matters:
 *
 *   - **Cross-run state** — `config.json` and `admin.json`. These tie to a
 *     kept-up cloud stack (its outputs; the password of a Cognito user that
 *     still exists), so they must survive between runs.
 *   - **Per-run local node state** — the registry `data.db`, `auth.json`,
 *     `cloud-credentials.json`, `objects/`, `app-creds/`, `app-local/`. These
 *     must be FRESH every run; see `resetLocalNodeState`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface RunPaths {
  /** <baseDir>/.run/<prefix> — also the STARKEEP_DIR for spawned CLIs and the LDS. */
  dataDir: string;
  configPath: string;
  adminPath: string;
}

/**
 * Where a run keeps its state.
 *
 * `baseDir` defaults to this package, which is right for core's own run. A
 * journey driven from another repository must pass its own directory: the dir
 * holds that run's Cognito admin password and its registry database, and
 * writing those into a checkout the caller does not own would put one
 * repository's cloud credentials inside another's working tree.
 */
export function runPaths(stackPrefix: string, baseDir: string = PACKAGE_ROOT): RunPaths {
  const dataDir = join(baseDir, ".run", stackPrefix);
  return {
    dataDir,
    configPath: join(dataDir, "config.json"),
    adminPath: join(dataDir, "admin.json"),
  };
}

/** Mirrors the StarkeepConfig the install CLIs read from config.json. */
export interface TestStackConfig {
  stackPrefix: string;
  accountId?: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  permissionsBoundaryArn?: string;
  foundationalPermissionsBoundaryArn?: string;
  userDataOwnerPermissionsBoundaryArn?: string;
  managerRoleArn?: string;
  pulumiStateBucket?: string;
  apiGatewayUrl?: string;
  /** Browser-facing base URL — the CloudFront distribution domain. */
  publicBaseUrl?: string;
  apiGatewayId?: string;
  apiGatewayExecutionArn?: string;
  authorizerId?: string;
  s3Bucket?: string;
  auroraEndpoint?: string;
  appParentDirs?: string[];
  nodeId?: string;
}

export function readConfig(paths: RunPaths): TestStackConfig | undefined {
  if (!existsSync(paths.configPath)) return undefined;
  return JSON.parse(readFileSync(paths.configPath, "utf-8")) as TestStackConfig;
}

export function writeConfig(paths: RunPaths, config: TestStackConfig): void {
  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(paths.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Per-run local node state that must NOT survive between runs. `config.json`
 * and `admin.json` are deliberately left alone — they tie to the kept-up cloud
 * stack (see the module header).
 *
 * Two independent reasons this has to happen, both learned the hard way:
 *
 *   - **Stale schema.** There is no migration system, by design: the local
 *     schema bootstrap is fresh-start and states the precondition outright
 *     ("the local-data-server's STARKEEP_DIR is fresh" — see
 *     storage-sqlite/src/schema/bootstrap.ts). Because the DDL is
 *     `CREATE TABLE IF NOT EXISTS`, a `data.db` written before a column was
 *     added can never gain it; boot then dies on the first index that
 *     references the new column. Reusing the dir across runs quietly violated
 *     that precondition, so ANY local schema change broke the next run.
 *
 *   - **Stale auth.** The local-data-server WRITES `auth.json` itself when the
 *     `/auth/tokens` handoff lands. Left behind, the next run boots already
 *     authenticated ("Stored auth found") and its sync supervisor starts before
 *     the handoff — defeating the boot step's whole point, which is that the
 *     handoff is what starts sync. The later `shipped > 0` then passes for the
 *     wrong reason.
 *
 *   - **Stale app-local state.** `app-local/<appId>/` holds what an app knows
 *     about *this node* rather than about the library: Photos keeps its sweep
 *     cursor and its per-record derivation verdicts there. Record ids are new
 *     every run, so a cursor left behind points into a library that no longer
 *     exists and the sweep resumes past the record the run is about to create.
 *     The platform never creates or cleans this tree, so the runner must.
 */
export function resetLocalNodeState(paths: RunPaths): void {
  const perRun = [
    "data.db",
    "data.db-wal",
    "data.db-shm",
    "auth.json",
    "cloud-credentials.json",
    "cloud-config.json",
    "objects",
    "app-creds",
    "app-local",
  ];
  for (const entry of perRun) {
    rmSync(join(paths.dataDir, entry), { recursive: true, force: true });
  }
}

export interface AdminCredentials {
  email: string;
  password: string;
}

export function readAdminCredentials(paths: RunPaths): AdminCredentials | undefined {
  if (!existsSync(paths.adminPath)) return undefined;
  return JSON.parse(readFileSync(paths.adminPath, "utf-8")) as AdminCredentials;
}

export function writeAdminCredentials(paths: RunPaths, creds: AdminCredentials): void {
  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(paths.adminPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/** A password satisfying the bootstrap pool's policy (only length ≥ 8). */
export function generatePassword(): string {
  return `Sk3!${randomBytes(18).toString("base64url")}`;
}
