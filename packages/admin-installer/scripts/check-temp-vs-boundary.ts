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
} from "../../aws-bootstrap/src/bootstrap/index.js";
import type { IamStatement } from "../../aws-bootstrap/src/iam-utils.js";
import {
  buildTempInstallDdlPolicy,
  buildTempInstallInfraPolicy,
  buildTempUninstallInfraPolicy,
  buildTempInstallCloudDataServerPolicy,
  buildRuntimePolicy,
} from "../src/temp-policies";
import { uncoveredActions } from "../src/policy-subsumption";

const STACK_PREFIX = "starkeep";
const APP_ID = "exampleapp";
const ACCOUNT_ID = "111122223333";
const REGION = "us-east-1";

interface CheckResult {
  pairName: string;
  missing: Array<{ sid: string | undefined; action: string }>;
}

function checkPair(pairName: string, policyJson: string, boundary: IamStatement[]): CheckResult {
  return { pairName, missing: uncoveredActions(JSON.parse(policyJson), boundary) };
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
    "buildTempInstallCloudDataServerPolicy (custom domain) vs foundationalPermissionsBoundaryStatements",
    buildTempInstallCloudDataServerPolicy(STACK_PREFIX, ACCOUNT_ID, REGION, ["photos.example.com"]),
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
      console.error(
        `     Sid=${m.sid ?? "(none)"}: action "${m.action}" is not Allowed by the boundary`,
      );
    }
  }
}

if (failed) {
  console.error("\nOne or more temp policies grant actions outside their boundary's Allow set.");
  console.error("Either narrow the temp policy or extend the boundary — and update both together.");
  process.exit(1);
}
console.log("\nAll temp policies are subsumed by their boundaries.");
