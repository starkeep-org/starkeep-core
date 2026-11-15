/**
 * scripts/teardown-bootstrap.sh must delete only the deployment it tears down.
 * The ambient config.json usually describes the operator's real deployment, so
 * a teardown of a test prefix must never touch that config's resources, above
 * all its Cognito pools.
 *
 * Each test runs the real script chain (bootstrap → cloud-data-server → apps)
 * against the fake `aws` CLI in ./helpers/fake-aws.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REGION,
  createSandbox,
  deployment,
  emptyAccount,
  identifiersOf,
  isReadCall,
  mergeAccounts,
  type Account,
  type Sandbox,
} from "./helpers/fake-aws";

const live = deployment("live");
const target = deployment("sktest");
const LIVE_USER_POOL = live.userPools[0].Id;
const LIVE_IDENTITY_POOL = live.identityPools[0].IdentityPoolId;
const TEST_USER_POOL = target.userPools[0].Id;
const TEST_IDENTITY_POOL = target.identityPools[0].IdentityPoolId;

let sandbox: Sandbox;
beforeEach(() => {
  // The ambient config describes the live deployment, as ~/.starkeep does.
  sandbox = createSandbox({
    stackPrefix: "live",
    userPoolId: LIVE_USER_POOL,
    identityPoolId: LIVE_IDENTITY_POOL,
  });
});
afterEach(() => sandbox.cleanup());

function runTeardown(prefix: string, account: Account, extra: string[] = []) {
  return sandbox.run(
    "teardown-bootstrap.sh",
    ["--yes", ...extra, "--prefix", prefix, "--region", REGION],
    account,
  );
}

const destructive = (calls: string[]) => calls.filter((c) => !isReadCall(c));

describe("teardown-bootstrap.sh", () => {
  it("deletes the target deployment and never changes the config's deployment", () => {
    const { status, output, calls, account } = runTeardown("sktest", mergeAccounts(live, target), [
      "--force",
    ]);
    expect(status, output).toBe(0);
    // Every resource of the target is gone, and every resource of the live
    // deployment survived.
    expect(identifiersOf(account).sort()).toEqual(identifiersOf(live).sort());
    for (const call of destructive(calls)) {
      for (const id of identifiersOf(live)) expect(call).not.toContain(id);
    }
    expect(output).toContain(`${LIVE_USER_POOL} still exists.`);
    expect(output).toContain(`${LIVE_IDENTITY_POOL} still exists.`);
    expect(output).toContain("Bootstrap teardown complete.");
  });

  it("lists every layer's resources on --dry-run and deletes nothing", () => {
    const before = mergeAccounts(live, target);
    // A certificate an earlier, failed run left: only the bootstrap's own
    // sweep deletes it.
    const leftoverCert = "arn:aws:acm:us-east-1:123456789012:certificate/sktest-leftover";
    before.certificates.push({
      CertificateArn: leftoverCert,
      DomainName: "old.sktest.example.com",
      Tags: { "starkeep:stackPrefix": "sktest" },
    });
    const { status, output, calls, account } = runTeardown("sktest", before, ["--dry-run"]);
    expect(status, output).toBe(0);
    for (const id of [
      TEST_USER_POOL,
      TEST_IDENTITY_POOL,
      "sktestcluster",
      "sktest-app-photos-web",
      // The bootstrap layer's own sweeps.
      "/sktest/app-creds/photos",
      "/sktest/platform/deployment-settings",
      leftoverCert,
    ]) {
      expect(output).toContain(id);
    }
    expect(output).toContain("Dry run of Bootstrap teardown: nothing was deleted.");
    expect(destructive(calls)).toEqual([]);
    expect(account).toEqual(before);
  });

  it("finds pools by prefix name and tag once the stack is gone", () => {
    const account = mergeAccounts(live, target);
    delete account.stacks["sktest-bootstrap"];
    // Same name, another deployment's tag: not this teardown's pool.
    account.userPools.push({
      Id: `${REGION}_OTHERpool`,
      Name: "sktest-auth",
      Tags: { StackPrefix: "other" },
      DeletionProtection: "INACTIVE",
    });
    const { status, output, calls } = runTeardown("sktest", account, ["--force"]);
    expect(status, output).toBe(0);
    expect(calls.filter((c) => /delete-(user|identity)-pool /.test(c))).toEqual([
      `cognito-identity delete-identity-pool --identity-pool-id ${TEST_IDENTITY_POOL} --region ${REGION}`,
      `cognito-idp delete-user-pool --user-pool-id ${TEST_USER_POOL} --region ${REGION}`,
    ]);
  });

  it("updates a user pool only to turn deletion protection off", () => {
    const account = mergeAccounts(live, target);
    account.userPools.push({
      Id: `${REGION}_PROTpool`,
      Name: "sktest-auth",
      Tags: { StackPrefix: "sktest" },
      DeletionProtection: "ACTIVE",
    });
    const { status, output, calls } = runTeardown("sktest", account, ["--force"]);
    expect(status, output).toBe(0);
    expect(calls.filter((c) => c.startsWith("cognito-idp update-user-pool"))).toEqual([
      `cognito-idp update-user-pool --user-pool-id ${REGION}_PROTpool --deletion-protection INACTIVE --region ${REGION}`,
    ]);
  });

  it("stops before deleting anything when a found pool is one the other deployment's config names", () => {
    const account = mergeAccounts(live, target);
    // A stack that points at the live pool, for example after a bad import.
    account.stacks["sktest-bootstrap"].IdentityPool = LIVE_IDENTITY_POOL;
    const { status, output, calls } = runTeardown("sktest", account, ["--force"]);
    expect(status).toBe(1);
    expect(output).toContain(`Cognito pool ${LIVE_IDENTITY_POOL} belongs to the deployment`);
    expect(destructive(calls)).toEqual([]);
  });

  it("fails when a config pool that existed at the start is gone at the end", () => {
    // A cloud-data-server teardown that removes the live identity pool stands
    // in for any step that reaches the other deployment.
    sandbox.stub(
      "teardown-cloud-data-server.sh",
      `#!/usr/bin/env bash\naws cognito-identity delete-identity-pool --identity-pool-id ${LIVE_IDENTITY_POOL} >/dev/null\n`,
    );
    const { status, output } = runTeardown("sktest", mergeAccounts(live, target), ["--force"]);
    expect(status, output).toBe(1);
    expect(output).toContain(
      `the identity pool ${LIVE_IDENTITY_POOL} that ${sandbox.configFile} names (prefix 'live') existed when this teardown started and is gone now.`,
    );
    expect(output).toContain(`${LIVE_USER_POOL} still exists.`);
  });

  it("does not blame the teardown for a config pool that was already gone", () => {
    const account = mergeAccounts(live, target);
    account.identityPools = account.identityPools.filter(
      (p) => p.IdentityPoolId !== LIVE_IDENTITY_POOL,
    );
    const { status, output } = runTeardown("sktest", account, ["--force"]);
    expect(status, output).toBe(0);
  });

  it("reports a pool it cannot delete and exits 1, but treats a missing pool as deleted", () => {
    const account = mergeAccounts(live, target);
    const domainError =
      "An error occurred (InvalidParameterException) when calling the DeleteUserPool " +
      "operation: User pool cannot be deleted. It has a domain configured that should be deleted first.";
    account.errors.push({
      match: `delete-user-pool --user-pool-id ${TEST_USER_POOL}`,
      error: domainError,
    });
    // The identity pool is already gone, which is not a failure.
    account.identityPools = account.identityPools.filter(
      (p) => p.IdentityPoolId !== TEST_IDENTITY_POOL,
    );
    const { status, output } = runTeardown("sktest", account, ["--force"]);
    expect(status, output).toBe(1);
    expect(output).toContain(`ERROR could not delete user pool ${TEST_USER_POOL}: ${domainError}`);
    expect(output).toContain(`identity pool ${TEST_IDENTITY_POOL}: not found or already deleted.`);
    // The script still runs its remaining steps before it fails.
    expect(output).toContain(`${LIVE_IDENTITY_POOL} still exists.`);
    const summary = output.slice(
      output.indexOf("Bootstrap teardown finished, but these steps failed:"),
    );
    expect(summary).toContain(TEST_USER_POOL);
    expect(summary).not.toContain(TEST_IDENTITY_POOL);
    expect(output).not.toContain("Bootstrap teardown complete.");
  });

  it("stops before the bootstrap layer when the cloud-data-server teardown fails", () => {
    const account = mergeAccounts(live, target);
    account.errors.push({
      match: "apigatewayv2 delete-api --api-id sktestapi",
      error:
        "An error occurred (TooManyRequestsException) when calling the DeleteApi operation: slow down",
    });
    const result = runTeardown("sktest", account, ["--force"]);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("could not delete API Gateway sktestapi");
    expect(result.account.stacks["sktest-bootstrap"]).toBeDefined();
    expect(result.account.userPools.map((p) => p.Id)).toContain(TEST_USER_POOL);
  });

  it("deletes the config's own deployment when the config describes the target", () => {
    const { status, output, account } = runTeardown("live", mergeAccounts(live, target), [
      "--force",
    ]);
    expect(status, output).toBe(0);
    expect(identifiersOf(account).sort()).toEqual(identifiersOf(target).sort());
    expect(output).toContain("Cloud config cleared");
  });

  describe("with STARKEEP_DIR set to the target's own config, as the e2e harness sets it", () => {
    // The harness and its printed cleanup command point STARKEEP_DIR at the
    // run's state dir, whose config describes the target. The operator's own
    // config still sits at $HOME/.starkeep and describes the live deployment.
    const runConfig = {
      stackPrefix: "sktest",
      userPoolId: TEST_USER_POOL,
      identityPoolId: TEST_IDENTITY_POOL,
    };
    const homeConfig = {
      stackPrefix: "live",
      userPoolId: LIVE_USER_POOL,
      identityPoolId: LIVE_IDENTITY_POOL,
    };
    let runSandbox: Sandbox;
    beforeEach(() => {
      runSandbox = createSandbox(runConfig, homeConfig);
    });
    afterEach(() => runSandbox.cleanup());
    const runAsHarness = (account: Account) =>
      runSandbox.run(
        "teardown-bootstrap.sh",
        ["--yes", "--force", "--prefix", "sktest", "--region", REGION],
        account,
      );

    it("stops before deleting anything when a found pool is one the home config names", () => {
      const account = mergeAccounts(live, target);
      account.stacks["sktest-bootstrap"].IdentityPool = LIVE_IDENTITY_POOL;
      const { status, output, calls } = runAsHarness(account);
      expect(status).toBe(1);
      expect(output).toContain(`Cognito pool ${LIVE_IDENTITY_POOL} belongs to the deployment`);
      expect(destructive(calls)).toEqual([]);
    });

    it("fails when a home-config pool that existed at the start is gone at the end", () => {
      runSandbox.stub(
        "teardown-cloud-data-server.sh",
        `#!/usr/bin/env bash\naws cognito-identity delete-identity-pool --identity-pool-id ${LIVE_IDENTITY_POOL} >/dev/null\n`,
      );
      const { status, output } = runAsHarness(mergeAccounts(live, target));
      expect(status, output).toBe(1);
      expect(output).toContain(
        `the identity pool ${LIVE_IDENTITY_POOL} that ${runSandbox.dir}/.starkeep/config.json names (prefix 'live') existed when this teardown started and is gone now.`,
      );
    });

    it("deletes the target, clears the run's config and leaves the home config's pools", () => {
      const { status, output, account } = runAsHarness(mergeAccounts(live, target));
      expect(status, output).toBe(0);
      expect(identifiersOf(account).sort()).toEqual(identifiersOf(live).sort());
      expect(output).toContain("Cloud config cleared");
      expect(output).toContain(`${LIVE_USER_POOL} still exists.`);
      expect(output).toContain(`${LIVE_IDENTITY_POOL} still exists.`);
    });
  });

  it("succeeds against an account that holds nothing of the target", () => {
    const { status, output } = runTeardown("sktest", mergeAccounts(live, emptyAccount()), [
      "--force",
    ]);
    expect(status, output).toBe(0);
  });
});
