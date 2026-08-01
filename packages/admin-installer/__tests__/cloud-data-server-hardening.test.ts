/**
 * buildCloudDataServerProgram under Pulumi's runtime mocks — no cloud, no engine.
 * Asserts the data-protection hardening governed by ctx.ephemeral:
 *   - real installs (ephemeral=false) version + SSE-encrypt + block-public the
 *     files bucket, keep the destroy guard, and protect the DSQL cluster;
 *   - ephemeral e2e installs (ephemeral=true) skip all of that and make the
 *     bucket self-emptying so repeated teardown isn't wedged.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { buildCloudDataServerProgram } from "../src/builtin-programs/cloud-data-server-program";
import type { CloudDataServerProgramContext } from "../src/builtin-programs/cloud-data-server-program";
import { isEphemeralInstall, EPHEMERAL_FLAG } from "../src/builtin-installs";

interface CreatedResource {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

const created: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } {
      created.push({ type: args.type, name: args.name, inputs: args.inputs });
      const extra: Record<string, unknown> = {};
      // The API Gateway's apiEndpoint is a computed output the mock must supply,
      // or the CloudFront origin-domain derivation (apiEndpoint.replace(...))
      // gets undefined. Real Pulumi always resolves it.
      if (args.type.endsWith("apigatewayv2/api:Api")) {
        extra.apiEndpoint = "https://mockapi.execute-api.us-east-2.amazonaws.com";
      }
      // CloudFront distribution's domainName feeds publicBaseUrl.
      if (args.type.endsWith("cloudfront/distribution:Distribution")) {
        extra.domainName = `${args.name}.cloudfront.net`;
      }
      return { id: `${args.name}-id`, state: { ...args.inputs, arn: `arn:fake:${args.name}`, ...extra } };
    },
    call(args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "starkeep-test-project",
  "starkeep-test-stack",
  // Non-preview: computed outputs (e.g. auroraHostname from cluster.identifier,
  // which the mock doesn't supply) resolve to known values instead of staying
  // "unknown", so the output-resolution loop in run() settles instead of hanging.
  false,
);

// FileArchive(ctx.distZipPath) is resolved when the Lambda registers; a real
// directory is a valid archive source, so an empty temp dir keeps mocks happy.
const distZipPath = mkdtempSync(join(tmpdir(), "cds-dist-"));

function makeCtx(ephemeral: boolean): CloudDataServerProgramContext {
  return {
    stackPrefix: "starkeep",
    region: "us-east-2",
    accountId: "111122223333",
    appRoleArn: "arn:aws:iam::111122223333:role/starkeep-app-cloud-data-server-role",
    distZipPath,
    bundleHash: "abc123hash",
    userPoolId: "us-east-2_pool",
    userPoolClientId: "client123",
    ephemeral,
  };
}

async function run(ephemeral: boolean): Promise<void> {
  const outputs = await buildCloudDataServerProgram(makeCtx(ephemeral))();
  // Force resolution of every output so all resource registrations settle.
  for (const value of Object.values(outputs)) {
    if (pulumi.Output.isInstance(value)) {
      await new Promise((resolve) => (value as pulumi.Output<unknown>).apply(resolve));
    }
  }
}

const byTypeSuffix = (suffix: string): CreatedResource[] =>
  created.filter((r) => r.type.endsWith(suffix));

const filesBucket = (): CreatedResource =>
  byTypeSuffix("s3/bucketV2:BucketV2").find((r) => r.name === "starkeep-files")!;
const dsqlCluster = (): CreatedResource => byTypeSuffix("dsql/cluster:Cluster")[0];
const versioning = (): CreatedResource[] => byTypeSuffix("bucketVersioningV2:BucketVersioningV2");
const sse = (): CreatedResource[] =>
  byTypeSuffix("bucketServerSideEncryptionConfigurationV2:BucketServerSideEncryptionConfigurationV2");
const pab = (): CreatedResource[] => byTypeSuffix("bucketPublicAccessBlock:BucketPublicAccessBlock");
const objectLockConfig = (): CreatedResource[] =>
  byTypeSuffix("bucketObjectLockConfigurationV2:BucketObjectLockConfigurationV2");
const lifecycle = (): CreatedResource[] =>
  byTypeSuffix("bucketLifecycleConfigurationV2:BucketLifecycleConfigurationV2");
const intelligentTiering = (): CreatedResource[] =>
  byTypeSuffix("bucketIntelligentTieringConfiguration:BucketIntelligentTieringConfiguration");

beforeEach(() => {
  created.length = 0;
});

describe("isEphemeralInstall is fail-safe — a real install can't be marked ephemeral by accident", () => {
  it("is false for an empty argv (the real-user admin-web spawn passes no --ephemeral)", () => {
    expect(isEphemeralInstall([])).toBe(false);
  });

  it("is false for the real-user spawn's actual argv", () => {
    // Mirrors admin-web's fixed spawn args (route.ts) — no --ephemeral present.
    expect(isEphemeralInstall(["--non-interactive"])).toBe(false);
  });

  it("is true only when the explicit flag is present", () => {
    expect(isEphemeralInstall([EPHEMERAL_FLAG])).toBe(true);
    expect(isEphemeralInstall(["--non-interactive", EPHEMERAL_FLAG])).toBe(true);
  });

  it("is not triggered by look-alike tokens (no substring/env-style coercion)", () => {
    for (const tok of ["ephemeral", "--ephemeral=1", "--EPHEMERAL", "-ephemeral", "1", "true"]) {
      expect(isEphemeralInstall([tok]), tok).toBe(false);
    }
  });
});

describe("real installs (ephemeral=false) are hardened", () => {
  it("protects the DSQL cluster from deletion", async () => {
    await run(false);
    expect(dsqlCluster().inputs.deletionProtectionEnabled).toBe(true);
  });

  it("guards the files bucket against destroy-while-non-empty", async () => {
    await run(false);
    expect(filesBucket().inputs.forceDestroy).toBe(false);
  });

  it("enables versioning on the files bucket", async () => {
    await run(false);
    const v = versioning();
    expect(v).toHaveLength(1);
    expect((v[0].inputs.versioningConfiguration as { status: string }).status).toBe("Enabled");
  });

  it("asserts SSE-S3 (AES256) encryption at rest", async () => {
    await run(false);
    const e = sse();
    expect(e).toHaveLength(1);
    const rule = (e[0].inputs.rules as { applyServerSideEncryptionByDefault: { sseAlgorithm: string } }[])[0];
    expect(rule.applyServerSideEncryptionByDefault.sseAlgorithm).toBe("AES256");
  });

  it("blocks all public access to the files bucket", async () => {
    await run(false);
    const p = pab();
    expect(p).toHaveLength(1);
    expect(p[0].inputs).toMatchObject({
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
  });

  // Object Lock can only be enabled at bucket creation. A bucket that ships
  // without the flag can never get it without an AWS Support request, so this
  // assertion guards a genuinely irreversible property.
  it("enables Object Lock on the files bucket", async () => {
    await run(false);
    expect(filesBucket().inputs.objectLockEnabled).toBe(true);
  });

  // The flag alone makes nothing undeletable. A bucket-level default retention
  // would: compliance retention can be extended but never reduced, so every
  // object written under a bucket default becomes permanently undeletable —
  // which would make rendition supersession impossible. Retention belongs per
  // object, on `archive` intent only, and that is a separate, later item.
  it("configures no bucket-level default retention", async () => {
    await run(false);
    expect(objectLockConfig()).toHaveLength(0);
  });
});

describe("the archive lifecycle rule (media plan item 18)", () => {
  it("creates exactly one lifecycle rule", async () => {
    await run(false);
    const configs = lifecycle();
    expect(configs).toHaveLength(1);
    expect((configs[0]!.inputs.rules as unknown[])).toHaveLength(1);
  });

  // The conjunction is the whole safety argument. `intent=archive` alone would
  // freeze originals whose derived ladder does not exist yet — which is exactly
  // when the original is the only readable form of the record — and
  // `ladder=complete` alone would freeze things nobody asked to be slow.
  it("requires BOTH the intent tag and the ladder-complete tag", async () => {
    await run(false);
    const rule = (lifecycle()[0]!.inputs.rules as Array<Record<string, never>>)[0]!;
    const tags = (rule.filter as { and: { tags: Record<string, string> } }).and.tags;
    expect(tags["starkeep:intent"]).toBe("archive");
    expect(tags["starkeep:ladder"]).toBe("complete");
  });

  // Renditions are never tagged, so they cannot match this filter. Structural
  // ineligibility beats a rule that has to read a value the right way round.
  it("transitions only to Deep Archive, and only above the small-object floor", async () => {
    await run(false);
    const rule = (lifecycle()[0]!.inputs.rules as Array<Record<string, never>>)[0]!;
    const filter = rule.filter as { and: { objectSizeGreaterThan: number } };
    // Deep Archive bills a 40 KB per-object overhead and a 180-day minimum, so
    // below ~1 MB an archived object is both dearer and slower. Strictly worse.
    expect(filter.and.objectSizeGreaterThan).toBeGreaterThanOrEqual(1024 * 1024);
    const transitions = rule.transitions as Array<{ storageClass: string; days: number }>;
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.storageClass).toBe("DEEP_ARCHIVE");
    expect(transitions[0]!.days).toBeGreaterThan(0);
  });

  // The guarantee every `instant` write depends on. Intelligent-Tiering's
  // automatic tiers are all millisecond-latency; its ASYNCHRONOUS tiers
  // (ARCHIVE_ACCESS / DEEP_ARCHIVE_ACCESS) are not, and an object in one exists
  // and cannot be read. Enabling them would silently break `instant` for every
  // rendition in the library, with no code change anywhere to notice.
  //
  // Asserted as an absence, because the failure mode is somebody *adding* this
  // resource later to save money without realising what it costs.
  it("never configures Intelligent-Tiering's asynchronous archive tiers", async () => {
    await run(false);
    expect(intelligentTiering()).toHaveLength(0);
  });
});

describe("ephemeral e2e installs (ephemeral=true) skip hardening", () => {
  it("leaves the DSQL cluster unprotected so teardown can drop it", async () => {
    await run(true);
    expect(dsqlCluster().inputs.deletionProtectionEnabled).toBe(false);
  });

  it("makes the files bucket self-emptying on destroy", async () => {
    await run(true);
    expect(filesBucket().inputs.forceDestroy).toBe(true);
  });

  it("creates no versioning, SSE, or public-access-block resources", async () => {
    await run(true);
    expect(versioning()).toHaveLength(0);
    expect(sse()).toHaveLength(0);
    expect(pab()).toHaveLength(0);
  });

  // Object Lock requires versioning, and both would wedge repeated teardown —
  // hence it rides !ephemeral exactly like versioning does.
  it("leaves Object Lock off so the bucket can be torn down", async () => {
    await run(true);
    expect(filesBucket().inputs.objectLockEnabled).toBe(false);
    expect(objectLockConfig()).toHaveLength(0);
  });

  // A lifecycle rule on a disposable bucket would transition objects the
  // teardown then has to thaw before it can delete them.
  it("creates no lifecycle rule", async () => {
    await run(true);
    expect(lifecycle()).toHaveLength(0);
  });
});
