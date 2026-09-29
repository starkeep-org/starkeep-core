/**
 * The proof "Free up space" runs before a node deletes its own copy of a file.
 *
 * **Every case that asserts a refusal guards against data loss.** A version of
 * `assessDurability` that answered "durable" for everything would pass every
 * happy-path test in the residency suites and delete a person's only copy. So
 * each way a replica can fail to prove itself has its own case here.
 *
 * On a phone or a desktop the one probe is the cloud, and the rule is one
 * confirmed replica: a store-verified whole-object SHA-256 that matches the
 * record's content hash.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { assessDurability, type ReplicaProbe } from "../src/durability.js";

const bytesFor = (n: number, fill = n % 256) => Buffer.alloc(n, fill);
const hashOf = (b: Buffer) => createHash("sha256").update(b as unknown as Uint8Array).digest("hex");
const b64Of = (b: Buffer) => createHash("sha256").update(b as unknown as Uint8Array).digest("base64");

const data = bytesFor(64);
const hash = hashOf(data);
const key = `shared/image/${hash.slice(0, 2)}/${hash}`;
const query = { objectStorageKey: key, contentHash: hash, sizeBytes: data.length };

async function probe(
  setup: (s: MockObjectStorageAdapter) => Promise<void> | void,
  nodeId = "cloud",
): Promise<ReplicaProbe> {
  const storage = new MockObjectStorageAdapter();
  await storage.init();
  await setup(storage);
  return { nodeId, storage };
}

describe("assessDurability", () => {
  it("confirms a replica whose stored checksum matches the record", async () => {
    const verdict = await assessDurability(query, [
      await probe((s) => s.put(key, data, { checksumSha256: b64Of(data) })),
    ]);
    expect(verdict).toMatchObject({ durable: true, confirmedReplicas: 1, instantReplicas: 1 });
    expect(verdict.replicas[0]!.state).toBe("confirmed");
  });

  // A store that verified nothing at write time cannot be treated as though it
  // had. This is also what a multipart object's composite checksum reads as.
  it("refuses a replica that is present with no checksum to check", async () => {
    const verdict = await assessDurability(query, [await probe((s) => s.put(key, data))]);
    expect(verdict).toMatchObject({ durable: false, confirmedReplicas: 0, unverifiedReplicas: 1 });
    expect(verdict.corruptionSuspected).toBe(false);
  });

  // S3's stored SHA-256 for a multipart upload, which is not the object's.
  it("refuses a replica whose checksum is a multipart composite", async () => {
    const real = await probe((s) => s.put(key, data, { checksumSha256: b64Of(data) }));
    const store = real.storage as MockObjectStorageAdapter;
    const composite: ReplicaProbe = {
      nodeId: "cloud",
      storage: {
        stat: async (k: string) => {
          const facts = await store.stat(k);
          return facts && { ...facts, checksumSha256: `${b64Of(data)}-3` };
        },
      } as unknown as MockObjectStorageAdapter,
    };
    const verdict = await assessDurability(query, [composite]);
    expect(verdict.durable).toBe(false);
    expect(verdict.replicas[0]!.state).toBe("present-unverified");
  });

  it("refuses, and reports corruption, when a replica's checksum disagrees", async () => {
    const wrong = bytesFor(64, 7);
    const verdict = await assessDurability(query, [
      await probe((s) => s.put(key, wrong, { checksumSha256: b64Of(wrong) })),
    ]);
    expect(verdict).toMatchObject({ durable: false, corruptionSuspected: true });
    expect(verdict.replicas[0]!.state).toBe("checksum-mismatch");
  });

  it("refuses, and reports corruption, when a replica is the wrong size", async () => {
    const verdict = await assessDurability(query, [await probe((s) => s.put(key, bytesFor(8)))]);
    expect(verdict).toMatchObject({ durable: false, corruptionSuspected: true });
    expect(verdict.replicas[0]!.state).toBe("size-mismatch");
  });

  it("refuses when the replica is absent", async () => {
    const verdict = await assessDurability(query, [await probe(() => {})]);
    expect(verdict.durable).toBe(false);
    expect(verdict.replicas[0]!.state).toBe("absent");
  });

  // "I couldn't tell" must read as neither "it isn't there" nor "it's fine".
  it("treats a failing probe as no evidence at all", async () => {
    const broken: ReplicaProbe = {
      nodeId: "cloud",
      storage: {
        ...new MockObjectStorageAdapter(),
        stat: async () => {
          throw new Error("network down");
        },
      } as unknown as MockObjectStorageAdapter,
    };
    const verdict = await assessDurability(query, [broken]);
    expect(verdict).toMatchObject({ durable: false, corruptionSuspected: false });
    expect(verdict.replicas[0]!.state).toBe("probe-failed");
  });

  it("refuses with no probe at all", async () => {
    expect((await assessDurability(query, [])).durable).toBe(false);
  });

  // Durable and readable are different questions: a deep-archive copy is safe
  // and takes twelve hours to read.
  it("counts an archived replica as held but not as instantly readable", async () => {
    const cold = await probe(async (s) => {
      await s.put(key, data, { checksumSha256: b64Of(data) });
      s.setAvailability(key, { state: "archived", tier: "DEEP_ARCHIVE", expectedLatencyHours: 12 });
    });
    const verdict = await assessDurability(query, [cold]);
    expect(verdict).toMatchObject({ durable: true, confirmedReplicas: 1, instantReplicas: 0 });
  });

  it("needs only one confirmed replica among several probes", async () => {
    const verdict = await assessDurability(query, [
      await probe(() => {}, "empty"),
      await probe((s) => s.put(key, data, { checksumSha256: b64Of(data) }), "cloud"),
    ]);
    expect(verdict).toMatchObject({ durable: true, confirmedReplicas: 1 });
  });
});
