/**
 * scripts/teardown-cloud-apps.sh must delete only the target deployment's apps,
 * report every failed call, and delete nothing on --dry-run. The ambient
 * config describes another deployment, as ~/.starkeep does during a teardown
 * of a test prefix.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REGION,
  createSandbox,
  deployment,
  identifiersOf,
  isReadCall,
  mergeAccounts,
  type Sandbox,
} from "./helpers/fake-aws";

const live = deployment("live");
const target = deployment("sktest");

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox({
    stackPrefix: "live",
    userPoolId: live.userPools[0].Id,
    identityPoolId: live.identityPools[0].IdentityPoolId,
  });
});
afterEach(() => sandbox.cleanup());

const run = (extra: string[], account = mergeAccounts(live, target)) =>
  sandbox.run(
    "teardown-cloud-apps.sh",
    ["--yes", ...extra, "--prefix", "sktest", "--region", REGION],
    account,
  );

describe("teardown-cloud-apps.sh", () => {
  it("deletes the target's apps and never changes the other deployment's resources", () => {
    const { status, output, calls, account } = run([]);
    expect(status, output).toBe(0);
    expect(account.lambdas).not.toContain("sktest-app-photos-web");
    expect(account.logGroups).not.toContain("/aws/lambda/sktest-app-photos-web");
    expect(account.roles.map((r) => r.RoleName)).not.toContain("sktest-app-photos-role");
    // The cloud-data-server's own Lambda belongs to teardown-cloud-data-server.sh.
    expect(account.lambdas).toContain("sktest-app-cloud-data-server-api");

    const after = identifiersOf(account);
    for (const id of identifiersOf(live)) expect(after).toContain(id);
    for (const call of calls.filter((c) => !isReadCall(c))) {
      for (const id of identifiersOf(live)) expect(call).not.toContain(id);
    }
  });

  it("lists the apps on --dry-run and deletes nothing", () => {
    const before = mergeAccounts(live, target);
    const { status, output, calls, account } = run(["--dry-run"], before);
    expect(status, output).toBe(0);
    expect(output).toContain("sktest-app-photos-web");
    expect(output).toContain("Dry run of App teardown: nothing was deleted.");
    expect(calls.filter((c) => !isReadCall(c))).toEqual([]);
    expect(account).toEqual(before);
  });

  it("reports a failed delete, still deletes the rest, and exits 1", () => {
    const account = mergeAccounts(live, target);
    account.errors.push({
      match: "lambda delete-function --function-name sktest-app-photos-web",
      error:
        "An error occurred (AccessDeniedException) when calling the DeleteFunction operation: denied",
    });
    const result = run([], account);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      "could not delete Lambda sktest-app-photos-web: An error occurred (AccessDeniedException)",
    );
    expect(result.output).toContain("App teardown finished, but these steps failed:");
    expect(result.account.roles.map((r) => r.RoleName)).not.toContain("sktest-app-photos-role");
  });

  it("fails when a lookup fails, rather than reporting nothing to delete", () => {
    const account = mergeAccounts(live, target);
    account.errors.push({
      match: "lambda list-functions",
      error:
        "An error occurred (AccessDeniedException) when calling the ListFunctions operation: denied",
    });
    const { status, output } = run(["--dry-run"], account);
    expect(status, output).toBe(1);
    expect(output).toContain(
      "aws lambda list-functions: An error occurred (AccessDeniedException)",
    );
    expect(output).toContain("Dry run of App teardown is incomplete.");
  });
});
