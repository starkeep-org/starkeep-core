/**
 * Co-edit guard as a standing test (mirrors scripts/check-temp-vs-boundary.ts):
 * every Action a temp/runtime policy grants must be Allowed by its matching
 * permissions boundary. IAM intersects policy with boundary, so a verb the
 * boundary doesn't allow is silently denied at runtime — this catches the
 * "extended the temp policy, forgot the boundary" failure mode at test time.
 */
import { describe, it, expect } from "vitest";
import {
  appPermissionsBoundaryStatements,
  foundationalPermissionsBoundaryStatements,
  installDdlBoundaryStatements,
  installInfraBoundaryStatements,
  type IamStatement,
} from "@starkeep/aws-bootstrap";
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
  Statement: Array<{
    Sid?: string;
    Effect: "Allow" | "Deny";
    Action?: string | string[];
  }>;
}

function toArray(x: string | string[] | undefined): string[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

function boundaryAllowedActions(boundary: IamStatement[]): Set<string> {
  const out = new Set<string>();
  for (const stmt of boundary) {
    if (stmt.Effect !== "Allow") continue;
    for (const action of toArray(stmt.Action)) out.add(action);
  }
  return out;
}

function actionMatches(allowed: string, wanted: string): boolean {
  if (allowed === wanted || allowed === "*") return true;
  return allowed.endsWith("*") && wanted.startsWith(allowed.slice(0, -1));
}

/** Actions the policy Allows that no boundary statement covers. */
function uncoveredActions(policyJson: string, boundary: IamStatement[]): string[] {
  const allowed = boundaryAllowedActions(boundary);
  const policy = JSON.parse(policyJson) as PolicyDocument;
  const missing: string[] = [];
  for (const stmt of policy.Statement) {
    if (stmt.Effect !== "Allow") continue;
    for (const action of toArray(stmt.Action)) {
      if (![...allowed].some((a) => actionMatches(a, action))) {
        missing.push(`${stmt.Sid ?? "(no sid)"}: ${action}`);
      }
    }
  }
  return missing;
}

describe("temp/runtime policies are subsumed by their boundaries", () => {
  it("temp-install-ddl ⊆ install-ddl boundary", () => {
    expect(
      uncoveredActions(buildTempInstallDdlPolicy(STACK_PREFIX), installDdlBoundaryStatements(STACK_PREFIX)),
    ).toEqual([]);
  });

  it("temp-install-infra ⊆ install-infra boundary", () => {
    expect(
      uncoveredActions(
        buildTempInstallInfraPolicy(STACK_PREFIX, APP_ID, ACCOUNT_ID, REGION),
        installInfraBoundaryStatements(STACK_PREFIX),
      ),
    ).toEqual([]);
  });

  it("temp-uninstall-infra ⊆ install-infra boundary", () => {
    expect(
      uncoveredActions(
        buildTempUninstallInfraPolicy(STACK_PREFIX, APP_ID, ACCOUNT_ID, REGION),
        installInfraBoundaryStatements(STACK_PREFIX),
      ),
    ).toEqual([]);
  });

  it("temp-install-cloud-data-server ⊆ foundational boundary", () => {
    expect(
      uncoveredActions(
        buildTempInstallCloudDataServerPolicy(STACK_PREFIX, ACCOUNT_ID, REGION),
        foundationalPermissionsBoundaryStatements(STACK_PREFIX),
      ),
    ).toEqual([]);
  });

  it("per-app runtime policy ⊆ per-app boundary", () => {
    expect(
      uncoveredActions(
        buildRuntimePolicy(STACK_PREFIX, APP_ID, ["image", "video"], true, true),
        appPermissionsBoundaryStatements(STACK_PREFIX),
      ),
    ).toEqual([]);
  });
});
