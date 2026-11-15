/**
 * scripts/teardown-cloud-data-server.sh must delete only the target
 * deployment's cloud-data-server and apps, report every failed call, and
 * delete nothing on --dry-run. The ambient config describes another
 * deployment, as ~/.starkeep does during a teardown of a test prefix.
 *
 * The script also removes what the install leaves outside Pulumi state: the
 * SecureStrings the installer writes under Manager creds, and the keys it
 * writes into ~/.starkeep/config.json. Neither list is derived from the
 * installer, so those checks read both sides.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudFrontSigningParameterName, delegationSigningParameterName } from "../src/app-creds";
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

const REPO_ROOT = join(__dirname, "..", "..", "..");
const script = readFileSync(join(REPO_ROOT, "scripts", "teardown-cloud-data-server.sh"), "utf8");
const installCli = readFileSync(
  join(REPO_ROOT, "packages", "admin-installer", "scripts", "cli-install-cloud-data-server.ts"),
  "utf8",
);

/** The keys in the script's STALE list. */
function staleKeys(): string[] {
  const block = /STALE = \[([\s\S]*?)\]/.exec(script)?.[1] ?? "";
  return [...block.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!);
}

const run = (extra: string[], account = mergeAccounts(live, target)) =>
  sandbox.run(
    "teardown-cloud-data-server.sh",
    ["--yes", ...extra, "--prefix", "sktest", "--region", REGION],
    account,
  );

describe("teardown-cloud-data-server.sh", () => {
  it("deletes the target's resources and never changes the other deployment's", () => {
    const { status, output, calls, account } = run(["--force"]);
    expect(status, output).toBe(0);
    expect(account.lambdas.filter((l) => l.startsWith("sktest-"))).toEqual([]);
    expect(account.logGroups.filter((l) => l.includes("sktest-"))).toEqual([]);
    expect(account.apis.map((a) => a.ApiId)).not.toContain("sktestapi");
    expect(account.dsqlClusters.map((c) => c.identifier)).not.toContain("sktestcluster");
    expect(account.distributions.map((d) => d.Id)).not.toContain("ESKTEST");
    expect(account.certificates.map((c) => c.CertificateArn)).not.toContain(
      target.certificates[0].CertificateArn,
    );
    expect(account.buckets).not.toContain(`sktest-files-123456789012-${REGION}`);
    expect(account.curReports).not.toContain("sktest-billing");

    const after = identifiersOf(account);
    for (const id of identifiersOf(live)) expect(after).toContain(id);
    for (const call of calls.filter((c) => !isReadCall(c))) {
      for (const id of identifiersOf(live)) expect(call).not.toContain(id);
    }
  });

  it("deletes every signing SecureString the install writes", () => {
    const { status, output, account } = run(["--force"]);
    expect(status, output).toBe(0);
    for (const name of [
      cloudFrontSigningParameterName("sktest"),
      delegationSigningParameterName("sktest"),
    ]) {
      expect(target.ssmParameters, name).toContain(name);
      expect(account.ssmParameters, name).not.toContain(name);
    }
  });

  it("reports a failed delete of the delegation signing key", () => {
    const name = delegationSigningParameterName("sktest");
    const account = mergeAccounts(live, target);
    account.errors.push({
      match: `ssm delete-parameter --name ${name}`,
      error:
        "An error occurred (AccessDeniedException) when calling the DeleteParameter operation: denied",
    });
    const { status, output } = run(["--force"], account);
    expect(status, output).toBe(1);
    expect(output).toContain(`could not delete ${name}: An error occurred (AccessDeniedException)`);
  });

  it("strips every authorizer id the install writes into config.json", () => {
    // The authorizers die with the gateway, so a kept id points at nothing.
    const written = [...installCli.matchAll(/^\s*([A-Za-z]*[aA]uthorizerId): outputs\./gm)].map(
      (m) => m[1]!,
    );
    expect(written.length).toBeGreaterThan(0);
    const stale = staleKeys();
    for (const key of written) expect(stale, key).toContain(key);
  });

  it("retries a throttled cluster lookup and finishes", () => {
    const account = mergeAccounts(live, target);
    account.errors.push({
      match: "dsql list-clusters",
      error:
        "An error occurred (ThrottlingException) when calling the ListClusters operation: Rate exceeded",
      times: 2,
    });
    const { status, output, account: after } = run(["--force"], account);
    expect(status, output).toBe(0);
    expect(output).toContain("aws dsql list-clusters was throttled; retrying in 5s.");
    expect(output).not.toContain("ERROR");
    expect(after.dsqlClusters.map((c) => c.identifier)).not.toContain("sktestcluster");
  });

  it("retries throttled CloudFront and S3 calls and finishes", () => {
    const account = mergeAccounts(live, target);
    account.errors.push(
      {
        match: "cloudfront list-key-groups",
        error:
          "An error occurred (Throttling) when calling the ListKeyGroups operation: Rate exceeded",
        times: 2,
      },
      {
        match: `s3api list-objects-v2 --bucket sktest-files-`,
        error:
          "An error occurred (SlowDown) when calling the ListObjectsV2 operation: Please reduce your request rate.",
        times: 2,
      },
    );
    const { status, output, account: after } = run(["--force"], account);
    expect(status, output).toBe(0);
    expect(output).toContain("aws cloudfront list-key-groups was throttled; retrying in 5s.");
    expect(output).toContain("aws s3api list-objects-v2 was throttled; retrying in 5s.");
    expect(output).not.toContain("ERROR");
    expect(after.buckets).not.toContain(`sktest-files-123456789012-${REGION}`);
  });

  it("reports a failed lookup of the redirect function rather than skipping it", () => {
    const account = mergeAccounts(live, target);
    account.errors.push({
      match: "cloudfront describe-function",
      error: "An error occurred (AccessDenied) when calling the DescribeFunction operation: denied",
    });
    const { status, output } = run(["--force"], account);
    expect(status, output).toBe(1);
    expect(output).not.toContain("sktest-signed-out-redirect not found");
    expect(output).toContain(
      "function lookup (sktest-signed-out-redirect): An error occurred (AccessDenied)",
    );
  });

  it("keeps a protected cluster without --force, and that is not a failure", () => {
    const { status, output, account } = run([]);
    expect(status, output).toBe(0);
    expect(output).toContain("sktestcluster (protected: kept unless --force");
    expect(account.dsqlClusters.map((c) => c.identifier)).toContain("sktestcluster");
  });

  it("lists the resolved resources on --dry-run, including the apps, and deletes nothing", () => {
    const before = mergeAccounts(live, target);
    const { status, output, calls, account } = run(["--dry-run", "--force"], before);
    expect(status, output).toBe(0);
    for (const id of [
      "sktestapi",
      "sktest-app-cloud-data-server-api",
      "sktestcluster (protected: --force lifts the protection)",
      "livecluster (skipped: belongs to deployment 'live')",
      "ESKTEST",
      target.certificates[0].CertificateArn,
      // From teardown-cloud-apps.sh --dry-run.
      "sktest-app-photos-web",
    ]) {
      expect(output).toContain(id);
    }
    expect(output).toContain("Dry run of Cloud-data-server teardown: nothing was deleted.");
    expect(calls.filter((c) => !isReadCall(c))).toEqual([]);
    expect(account).toEqual(before);
  });

  it("reports a failed delete, still deletes the rest, and exits 1", () => {
    const account = mergeAccounts(live, target);
    account.errors.push({
      match: "dsql delete-cluster --identifier sktestcluster",
      error:
        "An error occurred (InternalServerException) when calling the DeleteCluster operation: boom",
    });
    const result = run(["--force"], account);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      "could not delete DSQL cluster sktestcluster: An error occurred (InternalServerException)",
    );
    expect(result.output).toContain("Cloud-data-server teardown finished, but these steps failed:");
    expect(result.account.buckets).not.toContain(`sktest-files-123456789012-${REGION}`);
  });

  it("fails when a lookup fails, rather than reporting nothing to delete", () => {
    const account = mergeAccounts(live, target);
    account.errors.push({
      match: "dsql list-clusters",
      error:
        "An error occurred (AccessDeniedException) when calling the ListClusters operation: denied",
    });
    const { status, output } = run(["--force"], account);
    expect(status, output).toBe(1);
    expect(output).toContain("aws dsql list-clusters: An error occurred (AccessDeniedException)");
  });

  it("treats resources that are already gone as deleted", () => {
    const { status, output } = run(["--force"], mergeAccounts(live));
    expect(status, output).toBe(0);
    expect(output).toContain("Cloud-data-server teardown complete.");
  });
});
