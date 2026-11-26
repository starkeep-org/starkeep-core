/**
 * `installCloudDataServerOp`: the config it needs, the build it runs first,
 * and the outputs it writes back to `config.json`.
 */
import { describe, expect, it } from "vitest";
import { installCloudDataServerOp } from "../../src/operations/install-cloud-data-server.js";
import type { CloudDataServerInstallOutputs } from "../../src/builtin-installs.js";
import { platformFingerprint, type PlatformDeployRecord } from "../../src/deployed-source.js";
import {
  INSTALLED_CONFIG,
  platformRepo,
  readConfigIn,
  starkeepDirWith,
  testContext,
  withCode,
} from "./helpers.js";

const BOOTSTRAPPED = {
  stackPrefix: "sktest",
  userPoolId: "us-east-1_abc",
  userPoolClientId: "admin-client",
  identityPoolId: "us-east-1:pool",
  deviceUserPoolClientId: "device-client",
  cognitoDomain: "sktest.auth.us-east-1.amazoncognito.com",
  deploymentName: "Home",
};

const OUTPUTS = {
  appRoleArn: "arn:role",
  auroraHostname: "new.dsql.us-east-1.on.aws",
  bucketName: "files",
  apiGatewayUrl: "https://new-gw.example",
  publicBaseUrl: "https://dnew.cloudfront.net",
  cloudfrontDomain: "dnew.cloudfront.net",
  apiGatewayId: "newgw",
  apiGatewayExecutionArn: "arn:aws:execute-api:us-east-1:999999999999:newgw",
  authorizerId: "a1",
  sessionAuthorizerId: "a2",
  originAuthorizerId: "a3",
  delegatedAuthorizerId: "a4",
  cloudAppsUserPoolClientId: "cloud-apps",
  mobileAppsUserPoolClientId: "mobile-apps",
} as unknown as CloudDataServerInstallOutputs;

function stubs(calls: string[], build = 0) {
  return {
    runCommand: async (spec: { args: readonly string[] }) => {
      calls.push(`run ${spec.args.join(" ")}`);
      return build;
    },
    ensurePulumiPassphrase: async () => {
      calls.push("passphrase");
      return "already-exists" as const;
    },
    installCloudDataServer: async (config: { ephemeral?: boolean; accountId: string }) => {
      calls.push(`install ephemeral=${config.ephemeral} account=${config.accountId}`);
      return OUTPUTS;
    },
  };
}

describe("installCloudDataServerOp", () => {
  it("builds, installs, and writes the outputs to config.json", async () => {
    const dir = starkeepDirWith(BOOTSTRAPPED);
    const calls: string[] = [];
    const t = testContext(dir, stubs(calls) as never);
    const result = await installCloudDataServerOp(t.ctx, { ephemeral: true }, t.emit);
    expect(calls).toEqual([
      "run --filter @starkeep/builtin-cloud-data-server build",
      "passphrase",
      // No accountId in the config, so the caller's account from STS.
      "install ephemeral=true account=999999999999",
    ]);
    expect(t.lanes).toEqual(["us-east-1"]);
    expect(result.apiGatewayUrl).toBe("https://new-gw.example");
    const written = readConfigIn(dir);
    expect(written).toMatchObject({
      accountId: "999999999999",
      apiGatewayUrl: "https://new-gw.example",
      auroraEndpoint: "new.dsql.us-east-1.on.aws",
      s3Bucket: "files",
      delegatedAuthorizerId: "a4",
      cloudAppsUserPoolClientId: "cloud-apps",
    });
    expect(t.progress()).toContain("Install complete.");
  });

  it("installs hardened infrastructure unless the input asks for ephemeral", async () => {
    const calls: string[] = [];
    const t = testContext(
      starkeepDirWith({ ...BOOTSTRAPPED, accountId: "123456789012" }),
      stubs(calls) as never,
    );
    await installCloudDataServerOp(t.ctx, {}, t.emit);
    expect(calls).toContain("install ephemeral=false account=123456789012");
  });

  it("reports CONFIG_INCOMPLETE for a config without the device client or a deployment name", async () => {
    const { deviceUserPoolClientId: _d, ...noDevice } = BOOTSTRAPPED;
    let t = testContext(starkeepDirWith(noDevice), stubs([]) as never);
    await expect(installCloudDataServerOp(t.ctx, {}, t.emit)).rejects.toEqual(
      withCode("CONFIG_INCOMPLETE"),
    );
    t = testContext(
      starkeepDirWith({ ...BOOTSTRAPPED, deploymentName: "no<html>" }),
      stubs([]) as never,
    );
    await expect(installCloudDataServerOp(t.ctx, {}, t.emit)).rejects.toEqual(
      withCode("CONFIG_INCOMPLETE"),
    );
    t = testContext(starkeepDirWith(null), stubs([]) as never);
    await expect(installCloudDataServerOp(t.ctx, {}, t.emit)).rejects.toEqual(
      withCode("CONFIG_INCOMPLETE"),
    );
    // None of them asked for credentials.
    expect(t.lanes).toEqual([]);
  });

  it("reports NOT_SIGNED_IN before it builds anything", async () => {
    const calls: string[] = [];
    const t = testContext(starkeepDirWith(BOOTSTRAPPED), stubs(calls) as never, {
      signedIn: false,
    });
    await expect(installCloudDataServerOp(t.ctx, {}, t.emit)).rejects.toEqual(
      withCode("NOT_SIGNED_IN"),
    );
    expect(calls).toEqual([]);
  });

  it("reports BUNDLE_FAILED when the build fails, and installs nothing", async () => {
    const calls: string[] = [];
    const t = testContext(starkeepDirWith(BOOTSTRAPPED), stubs(calls, 1) as never);
    await expect(installCloudDataServerOp(t.ctx, {}, t.emit)).rejects.toEqual(
      withCode("BUNDLE_FAILED"),
    );
    expect(calls.some((c) => c.startsWith("install"))).toBe(false);
  });

  it("refuses a new domain while a failed attempt at another one waits, and changes nothing", async () => {
    const config = {
      ...INSTALLED_CONFIG,
      customDomain: "b.example.com",
      customDomainAttempted: "a.example.com",
    };
    const dir = starkeepDirWith(config);
    const calls: string[] = [];
    const t = testContext(dir, stubs(calls) as never);
    await expect(installCloudDataServerOp(t.ctx, {}, t.emit)).rejects.toEqual(withCode("REFUSED"));
    expect(calls.some((c) => c.startsWith("install"))).toBe(false);
    expect(readConfigIn(dir)).toEqual(config);
  });

  it("records the domain it attempts before the install, so a failure keeps it", async () => {
    const dir = starkeepDirWith({ ...INSTALLED_CONFIG, customDomain: "a.example.com" });
    const t = testContext(dir, {
      ...stubs([]),
      installCloudDataServer: async () => {
        throw new Error("pulumi up failed");
      },
    } as never);
    await expect(installCloudDataServerOp(t.ctx, {}, t.emit)).rejects.toThrow("pulumi up failed");
    expect(readConfigIn(dir).customDomainAttempted).toBe("a.example.com");
  });
});

describe("installCloudDataServerOp's deployed record and backward-deploy guard", () => {
  function recordStore(initial: PlatformDeployRecord | null = null) {
    const store = { record: initial, writes: [] as PlatformDeployRecord[] };
    return {
      store,
      platformRecord: {
        read: async () => store.record,
        write: async (r: PlatformDeployRecord) => {
          store.writes.push(r);
          store.record = r;
        },
      },
    };
  }

  it("records the checkout's commit and platform fingerprint after a successful install", async () => {
    const repo = platformRepo();
    const head = repo.git("rev-parse", "HEAD");
    const { store, platformRecord } = recordStore();
    const t = testContext(starkeepDirWith(INSTALLED_CONFIG), {
      ...stubs([]),
      platformRecord,
      platformCheckout: repo.dir,
    } as never);
    await installCloudDataServerOp(t.ctx, {}, t.emit);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({
      commit: head,
      dirty: false,
      branch: "main",
      fingerprint: platformFingerprint(repo.dir),
    });
    expect(store.writes[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the commit it deployed, not one made while the deploy ran", async () => {
    const repo = platformRepo();
    const deployedHead = repo.git("rev-parse", "HEAD");
    const deployedFingerprint = platformFingerprint(repo.dir);
    const { store, platformRecord } = recordStore();
    const t = testContext(starkeepDirWith(INSTALLED_CONFIG), {
      ...stubs([]),
      installCloudDataServer: async () => {
        // The person commits during the ten-minute deploy.
        repo.commit("packages/admin-installer/later.ts", "later");
        return OUTPUTS;
      },
      platformRecord,
      platformCheckout: repo.dir,
    } as never);
    await installCloudDataServerOp(t.ctx, {}, t.emit);
    expect(repo.git("rev-parse", "HEAD")).not.toBe(deployedHead);
    expect(store.writes[0]).toMatchObject({
      commit: deployedHead,
      fingerprint: deployedFingerprint,
    });
  });

  it("writes no record when the install fails", async () => {
    const repo = platformRepo();
    const { store, platformRecord } = recordStore();
    const t = testContext(starkeepDirWith(INSTALLED_CONFIG), {
      ...stubs([]),
      installCloudDataServer: async () => {
        throw new Error("pulumi up failed");
      },
      platformRecord,
      platformCheckout: repo.dir,
    } as never);
    await expect(installCloudDataServerOp(t.ctx, {}, t.emit)).rejects.toThrow("pulumi up failed");
    expect(store.writes).toEqual([]);
  });

  it("reports DEPLOY_BACKWARD before it builds when the cloud runs a commit the checkout lacks", async () => {
    const repo = platformRepo();
    repo.git("checkout", "-q", "-b", "feature");
    const feature = repo.commit("packages/admin-installer/jobs.ts", "jobs");
    repo.git("checkout", "-q", "main");
    const deployed = {
      commit: feature,
      dirty: false,
      branch: "feature",
      fingerprint: "f",
      deployedAt: "",
    };
    const { store, platformRecord } = recordStore(deployed);
    const calls: string[] = [];
    const t = testContext(starkeepDirWith(INSTALLED_CONFIG), {
      ...stubs(calls),
      platformRecord,
      platformCheckout: repo.dir,
    } as never);
    const failure = installCloudDataServerOp(t.ctx, {}, t.emit);
    await expect(failure).rejects.toEqual(withCode("DEPLOY_BACKWARD"));
    await expect(failure).rejects.toThrow(/edit packages\/admin-installer\/jobs\.ts/);
    expect(calls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it("deploys anyway with allowBackward, says so, and records the new commit", async () => {
    const repo = platformRepo();
    repo.git("checkout", "-q", "-b", "feature");
    const feature = repo.commit("packages/admin-installer/jobs.ts", "jobs");
    repo.git("checkout", "-q", "main");
    const { store, platformRecord } = recordStore({
      commit: feature,
      dirty: false,
      branch: "feature",
      fingerprint: "f",
      deployedAt: "",
    });
    const calls: string[] = [];
    const t = testContext(starkeepDirWith(INSTALLED_CONFIG), {
      ...stubs(calls),
      platformRecord,
      platformCheckout: repo.dir,
    } as never);
    await installCloudDataServerOp(t.ctx, { allowBackward: true }, t.emit);
    expect(calls.some((c) => c.startsWith("install"))).toBe(true);
    expect(t.progress()).toContain("this deploy removes them (forced)");
    expect(store.record?.commit).toBe(repo.git("rev-parse", "HEAD"));
  });

  it("still succeeds when the record cannot be written, and warns", async () => {
    const repo = platformRepo();
    const t = testContext(starkeepDirWith(INSTALLED_CONFIG), {
      ...stubs([]),
      platformRecord: {
        read: async () => null,
        write: async () => {
          throw new Error("AccessDenied");
        },
      },
      platformCheckout: repo.dir,
    } as never);
    await installCloudDataServerOp(t.ctx, {}, t.emit);
    expect(t.progress()).toContain("Warning: could not record the deployed commit: AccessDenied");
  });
});
