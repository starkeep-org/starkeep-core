/**
 * Co-edit guard: for each (temp policy, boundary) pair, assert that every
 * Action the temp policy grants is also Allowed by the matching boundary's
 * statement list. This catches the failure mode where someone adds a new
 * verb to a temp policy without expanding its boundary — IAM intersects the
 * temp policy with the boundary, so an un-permitted verb is silently denied.
 *
 * Pure-data check; no AWS calls. Run via:
 *   pnpm -F @starkeep/admin-installer check:temp-vs-boundary
 *
 * Exits 1 on any mismatch with a per-pair report.
 */

import {
  appPermissionsBoundaryStatements,
  foundationalPermissionsBoundaryStatements,
  installDdlBoundaryStatements,
  installInfraBoundaryStatements,
} from "../../admin-core/src/bootstrap/index.js";
import type { IamStatement } from "../../admin-core/src/iam-utils.js";
import {
  buildTempInstallDdlPolicy,
  buildTempInstallInfraPolicy,
  buildTempUninstallInfraPolicy,
  buildTempInstallCloudDataServerPolicy,
  buildRuntimePolicy,
} from "../src/temp-policies";

const STACK_PREFIX = "starkeep";
const APP_ID = "exampleapp";
const ACCOUNT_ID = "111122223333";
const REGION = "us-east-1";

interface PolicyDocument {
  Version: string;
  Statement: Array<{
    Sid?: string;
    Effect: "Allow" | "Deny";
    Action?: string | string[];
    NotAction?: string | string[];
    Resource?: unknown;
    Condition?: unknown;
  }>;
}

function toArray(x: string | string[] | undefined): string[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

/** Collect every Allow Action across the boundary statements. */
function boundaryAllowedActions(boundary: IamStatement[]): Set<string> {
  const out = new Set<string>();
  for (const stmt of boundary) {
    if (stmt.Effect !== "Allow") continue;
    for (const action of toArray(stmt.Action)) out.add(action);
  }
  return out;
}

/** True if `granted` (with possible trailing wildcard) covers `wanted`. */
function actionMatches(allowed: string, wanted: string): boolean {
  if (allowed === wanted) return true;
  if (allowed === "*") return true;
  // Wildcard at end, e.g. "lambda:Get*" covers "lambda:GetFunction".
  if (allowed.endsWith("*")) {
    const prefix = allowed.slice(0, -1);
    if (wanted.startsWith(prefix)) return true;
  }
  return false;
}

function actionPermittedByBoundary(action: string, allowed: Set<string>): boolean {
  for (const a of allowed) {
    if (actionMatches(a, action)) return true;
  }
  return false;
}

interface CheckResult {
  pairName: string;
  missing: Array<{ sid: string | undefined; action: string }>;
}

function checkPair(
  pairName: string,
  policyJson: string,
  boundary: IamStatement[],
): CheckResult {
  const policy = JSON.parse(policyJson) as PolicyDocument;
  const allowed = boundaryAllowedActions(boundary);
  const missing: CheckResult["missing"] = [];

  for (const stmt of policy.Statement) {
    if (stmt.Effect !== "Allow") continue;
    for (const action of toArray(stmt.Action)) {
      if (!actionPermittedByBoundary(action, allowed)) {
        missing.push({ sid: stmt.Sid, action });
      }
    }
  }
  return { pairName, missing };
}

const pairs: CheckResult[] = [
  checkPair(
    "buildTempInstallDdlPolicy vs installDdlBoundaryStatements",
    buildTempInstallDdlPolicy(STACK_PREFIX),
    installDdlBoundaryStatements(STACK_PREFIX),
  ),
  checkPair(
    "buildTempInstallInfraPolicy vs installInfraBoundaryStatements",
    buildTempInstallInfraPolicy(STACK_PREFIX, APP_ID, ACCOUNT_ID, REGION),
    installInfraBoundaryStatements(STACK_PREFIX),
  ),
  checkPair(
    "buildTempUninstallInfraPolicy vs installInfraBoundaryStatements",
    buildTempUninstallInfraPolicy(STACK_PREFIX, APP_ID, ACCOUNT_ID, REGION),
    installInfraBoundaryStatements(STACK_PREFIX),
  ),
  checkPair(
    "buildTempInstallCloudDataServerPolicy vs foundationalPermissionsBoundaryStatements",
    buildTempInstallCloudDataServerPolicy(STACK_PREFIX, ACCOUNT_ID, REGION),
    foundationalPermissionsBoundaryStatements(STACK_PREFIX),
  ),
  checkPair(
    "buildRuntimePolicy vs appPermissionsBoundaryStatements",
    buildRuntimePolicy(STACK_PREFIX, APP_ID, ["image", "video"], true, true, true),
    appPermissionsBoundaryStatements(STACK_PREFIX),
  ),
];

let failed = false;
for (const result of pairs) {
  if (result.missing.length === 0) {
    console.log(`OK  ${result.pairName}`);
  } else {
    failed = true;
    console.error(`FAIL ${result.pairName}`);
    for (const m of result.missing) {
      console.error(`     Sid=${m.sid ?? "(none)"}: action "${m.action}" is not Allowed by the boundary`);
    }
  }
}

if (failed) {
  console.error("\nOne or more temp policies grant actions outside their boundary's Allow set.");
  console.error("Either narrow the temp policy or extend the boundary — and update both together.");
  process.exit(1);
}
console.log("\nAll temp policies are subsumed by their boundaries.");
