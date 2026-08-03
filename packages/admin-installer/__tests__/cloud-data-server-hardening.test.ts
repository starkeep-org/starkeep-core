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

/**
 * Resource *options* — `protect` and friends — recorded separately.
 *
 * `setMocks` cannot see them: `MockResourceArgs` carries type, name, inputs,
 * provider and id, and nothing else. Options are the engine's business. A stack
 * transformation is the one hook that does see them, so protection is asserted
 * through that rather than not at all — and rather than through a test that
 * reads the source text and passes whenever the formatting is unchanged.
 */
const optionsByName = new Map<string, pulumi.ResourceOptions>();

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
  // Inside a stack, because `registerStackTransformation` needs a root resource
  // to attach to — and the transformation is the only hook that sees resource
  // *options*, which is where `protect` lives.
  await pulumi.runtime.runInPulumiStack(async () => {
    pulumi.runtime.registerStackTransformation((args) => {
      optionsByName.set(args.name, args.opts);
      return undefined;
    });
    await buildProgram(ephemeral);
    return {};
  });
}

async function buildProgram(ephemeral: boolean): Promise<void> {
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
const bucketNotification = (): CreatedResource[] =>
  byTypeSuffix("s3/bucketNotification:BucketNotification");
const lambdaPermissions = (): CreatedResource[] =>
  byTypeSuffix("lambda/permission:Permission");
const intelligentTiering = (): CreatedResource[] =>
  byTypeSuffix("bucketIntelligentTieringConfiguration:BucketIntelligentTieringConfiguration");

beforeEach(() => {
  created.length = 0;
  optionsByName.clear();
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

  it("protects the files bucket and the DSQL cluster from replacement", async () => {
    // The guard against the 2026-08-02 incident. `objectLockEnabled` is
    // ForceNew, so on a stack whose bucket predates it the provider answers
    // "replace" rather than "error" — and S3's global namespace forces the
    // delete to go first. Every user file survived only because DeleteBucket
    // returned BucketNotEmpty.
    //
    // `protect` turns that plan into a planning-time failure. It is asserted
    // here because it is a property of the *deployment*, not of any input, and
    // nothing else in this suite would notice it being dropped.
    await run(false);
    expect(optionsByName.get("starkeep-files")?.protect).toBe(true);
    expect(optionsByName.get("starkeep-db")?.protect).toBe(true);
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

describe("availability maintenance (media plan item 19b)", () => {
  // Without this subscription, `availability` reports whatever a record was
  // written as, forever — so an archived original still claims to be instantly
  // readable and the 409 protecting callers from a silent twelve-hour stall
  // never fires. The stored field would be decoration.
  it("subscribes the Lambda to the events that change readability", async () => {
    await run(false);
    const notifications = bucketNotification();
    expect(notifications).toHaveLength(1);
    // Two subscriptions: readability events on shared blobs, and the inventory
    // manifest landing. Separate entries rather than one broad filter, because
    // a filter covering both would deliver every shared-object creation too.
    const fns = notifications[0]!.inputs.lambdaFunctions as Array<{
      events: string[];
      filterPrefix?: string;
    }>;
    expect(fns).toHaveLength(2);
    const shared = fns.find((f) => f.filterPrefix === "shared/")!;
    expect(shared.events.sort()).toEqual([
      "s3:LifecycleTransition",
      "s3:ObjectRestore:Completed",
      "s3:ObjectRestore:Delete",
    ]);
  });

  // The one most easily forgotten. Without it an object reads as available
  // forever after a single restore — fine for a week, wrong for months, and
  // only discovered when someone opens it.
  it("subscribes to restore expiry, not just restore completion", async () => {
    await run(false);
    const fns = bucketNotification()[0]!.inputs.lambdaFunctions as Array<{
      events: string[];
      filterPrefix?: string;
    }>;
    expect(fns.find((f) => f.filterPrefix === "shared/")!.events).toContain(
      "s3:ObjectRestore:Delete",
    );
  });

  // A newly written object is instant, which is already the default for a key
  // with no stored row. Subscribing would write a row per upload to record
  // something nothing needed told.
  it("does not subscribe to object creation", async () => {
    await run(false);
    const fns = bucketNotification()[0]!.inputs.lambdaFunctions as Array<{
      events: string[];
      filterPrefix?: string;
    }>;
    // The inventory subscription does use ObjectCreated, but only under its own
    // reserved prefix — the shared-blob subscription must not.
    expect(fns.find((f) => f.filterPrefix === "shared/")!.events.join(",")).not.toContain(
      "ObjectCreated",
    );
  });

  // Without a backstop, an event that was never delivered leaves a record
  // wrong indefinitely — and the wrongness is invisible until somebody reads
  // it. Inventory rather than a HeadObject sweep because at ~$0.0025 per
  // million objects it is nearly free, where probing a 300k-object library
  // daily is 300k requests.
  it("configures a daily inventory as the backstop", async () => {
    await run(false);
    const inventories = byTypeSuffix("s3/inventory:Inventory");
    expect(inventories).toHaveLength(1);
    expect((inventories[0]!.inputs.schedule as { frequency: string }).frequency).toBe("Daily");
  });

  // Storage class alone would call an object in I-T's asynchronous archive
  // tier readable. It exists and cannot be read.
  it("asks for the access tier, not just the storage class", async () => {
    await run(false);
    const fields = byTypeSuffix("s3/inventory:Inventory")[0]!.inputs.optionalFields as string[];
    expect(fields).toContain("StorageClass");
    expect(fields).toContain("IntelligentTieringAccessTier");
  });

  // App-syncable files are not subject to archiving, so listing them would be
  // paying to enumerate rows nothing reads.
  it("inventories only shared blobs", async () => {
    await run(false);
    const filter = byTypeSuffix("s3/inventory:Inventory")[0]!.inputs.filter as { prefix: string };
    expect(filter.prefix).toBe("shared/");
  });

  // The report has to trigger its own ingestion, or it accumulates unread and
  // availability quietly has no backstop while appearing to have one.
  it("subscribes to the inventory manifest landing, keyed on the checksum file", async () => {
    await run(false);
    const fns = bucketNotification()[0]!.inputs.lambdaFunctions as Array<{
      events: string[];
      filterPrefix?: string;
      filterSuffix?: string;
    }>;
    const inventoryTrigger = fns.find((f) => f.filterPrefix?.includes("inventory"));
    expect(inventoryTrigger, "nothing ingests the inventory report").toBeTruthy();
    // S3 writes data files first and the checksum last, so keying on anything
    // else would ingest a partial report.
    expect(inventoryTrigger!.filterSuffix).toBe("manifest.checksum");
  });

  it("grants S3 permission to invoke the function, scoped to the bucket", async () => {
    await run(false);
    const perm = lambdaPermissions().find((p) => p.inputs.principal === "s3.amazonaws.com");
    expect(perm, "S3 cannot invoke the Lambda without an explicit permission").toBeTruthy();
    expect(perm!.inputs.action).toBe("lambda:InvokeFunction");
    // Scoped: any bucket in the account could otherwise invoke this function.
    expect(perm!.inputs.sourceArn).toBeTruthy();
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

  it("leaves ephemeral resources unprotected so the suite can tear them down", async () => {
    await run(true);
    expect(optionsByName.get("starkeep-files")?.protect).toBe(false);
    expect(optionsByName.get("starkeep-db")?.protect).toBe(false);
  });

  // A lifecycle rule on a disposable bucket would transition objects the
  // teardown then has to thaw before it can delete them.
  it("creates no lifecycle rule", async () => {
    await run(true);
    expect(lifecycle()).toHaveLength(0);
  });

  // The availability wiring is deliberately NOT skipped for ephemeral installs.
  // Neither a notification config nor an inventory config obstructs teardown
  // (both are deleted with the bucket), and skipping them meant the Tier-3
  // suite — the only test that performs a real install — never exercised the
  // IAM grants they need. That is precisely how an install reached a real
  // account missing s3:PutInventoryConfiguration.
  it("still creates the bucket notification, so the e2e install covers it", async () => {
    await run(true);
    expect(bucketNotification()).toHaveLength(1);
  });

  it("still creates the inventory, so the e2e install covers it", async () => {
    await run(true);
    expect(byTypeSuffix("s3/inventory:Inventory")).toHaveLength(1);
  });
});
