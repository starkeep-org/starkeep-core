/**
 * Co-edit guard as a standing test (runs the same matcher as
 * scripts/check-temp-vs-boundary.ts):
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
import { uncoveredActions } from "../src/policy-subsumption";

const STACK_PREFIX = "starkeep";
const APP_ID = "exampleapp";
const ACCOUNT_ID = "111122223333";
const REGION = "us-east-1";

/** Actions the policy Allows that no boundary statement covers. */
function uncovered(policyJson: string, boundary: IamStatement[]): string[] {
  return uncoveredActions(JSON.parse(policyJson), boundary).map(
    (m) => `${m.sid ?? "(no sid)"}: ${m.action}`,
  );
}

describe("temp/runtime policies are subsumed by their boundaries", () => {
  it("temp-install-ddl ⊆ install-ddl boundary", () => {
    expect(
      uncovered(
        buildTempInstallDdlPolicy(STACK_PREFIX),
        installDdlBoundaryStatements(STACK_PREFIX),
      ),
    ).toEqual([]);
  });

  it("temp-install-infra ⊆ install-infra boundary", () => {
    expect(
      uncovered(
        buildTempInstallInfraPolicy(STACK_PREFIX, APP_ID, ACCOUNT_ID, REGION),
        installInfraBoundaryStatements(STACK_PREFIX),
      ),
    ).toEqual([]);
  });

  it("temp-uninstall-infra ⊆ install-infra boundary", () => {
    expect(
      uncovered(
        buildTempUninstallInfraPolicy(STACK_PREFIX, APP_ID, ACCOUNT_ID, REGION),
        installInfraBoundaryStatements(STACK_PREFIX),
      ),
    ).toEqual([]);
  });

  it("temp-install-cloud-data-server ⊆ foundational boundary", () => {
    expect(
      uncovered(
        buildTempInstallCloudDataServerPolicy(STACK_PREFIX, ACCOUNT_ID, REGION),
        foundationalPermissionsBoundaryStatements(STACK_PREFIX),
      ),
    ).toEqual([]);
  });

  it("temp-install-cloud-data-server with a custom domain ⊆ foundational boundary", () => {
    expect(
      uncovered(
        buildTempInstallCloudDataServerPolicy(STACK_PREFIX, ACCOUNT_ID, REGION, [
          "photos.example.com",
        ]),
        foundationalPermissionsBoundaryStatements(STACK_PREFIX),
      ),
    ).toEqual([]);
  });

  it("per-app runtime policy ⊆ per-app boundary", () => {
    expect(
      uncovered(
        buildRuntimePolicy(STACK_PREFIX, APP_ID, ["image", "video"], true, true),
        appPermissionsBoundaryStatements(STACK_PREFIX),
      ),
    ).toEqual([]);
  });
});
