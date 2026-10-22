/**
 * Rows ahead of bytes: two watermarks per author, and the receiver owns both.
 *
 * Before this, a row could not leave a node until its file had reached the
 * peer, because the peer's coverage report described rows only and the
 * sender's next scan started above it — an upload that had not happened when
 * the row shipped was never owed again. Every row from an author therefore
 * waited for every earlier file from that author, on the slowest link in the
 * system. See `plan-sync-latency-fixes-2026-10-14.md`, section "Step 7 design:
 * Option C in detail".
 *
 * Now each receiver keeps a bytes watermark beside its rows watermark and
 * reports both. These tests pin the responder's walk, the requester's two
 * transfer passes, the compatibility rule for a peer that cannot report files,
 * and — end to end — the latency the change exists for.
 */

import { describe, expect, it } from "vitest";
import {
  createDataRecord,
  generateId,
  serializeHLC,
  type HLCTimestamp,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createFileSyncEngine } from "../src/file-sync-engine.js";
import {
  createInProcessSyncTransport,
  createMemoryByteCoverageStore,
} from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import { makeMockAppSource } from "./sync-test-harness/mock-app-source.js";
import type {
  ByteCoverageStore,
  ResidencyHooks,
  SyncExchangeRequest,
  SyncExchangeResponse,
  SyncStateStore,
  SyncTransport,
} from "../src/types.js";

type Side = Awaited<ReturnType<typeof buildSide>>;

const MB = 1024 * 1024;

async function sides(...nodeIds: string[]): Promise<Side[]> {
  let t = 0;
  const wallClock = () => t++;
  return Promise.all(
    nodeIds.map((nodeId, i) =>
      buildSide({ role: i === 0 ? "cloud" : "local", nodeId, wallClock, appId: "photos" }),
    ),
  );
}

/** A record whose file is in `side`'s storage, unless `withFile` is false. */
async function seedFile(
  side: Side,
  sizeBytes: number,
  options: { withFile?: boolean } = {},
): Promise<StarkeepId> {
  const id = generateId() as StarkeepId;
  const key = `shared/image/${id}`;
  if (options.withFile !== false) await side.storage.put(key, new Uint8Array(8));
  await side.db.put({
    ...createDataRecord(
      {
        type: "image/jpeg",
        originAppId: "photos",
        contentHash: `sha256:${id}`,
        objectStorageKey: key,
        mimeType: "image/jpeg",
        sizeBytes,
      },
      side.clock,
    ),
    id,
  });
  return id;
}

async function keyOf(side: Side, id: StarkeepId): Promise<string> {
  return (await side.db.get(id))!.objectStorageKey;
}

async function hlcOf(side: Side, id: StarkeepId): Promise<HLCTimestamp> {
  return (await side.db.get(id))!.updatedAt;
}

function responder(
  cloud: Side,
  extra: {
    byteCoverage?: ByteCoverageStore;
    declinesBlob?: (key: string) => Promise<boolean>;
    onFilesHeld?: (recordIds: readonly StarkeepId[]) => Promise<void>;
  } = {},
) {
  return createInProcessSyncTransport({
    databaseAdapter: cloud.db,
    clock: cloud.clock,
    objectStorage: cloud.storage,
    syncSharedRecords: true,
    ...extra,
  });
}

function engine(
  node: Side,
  cloud: Side,
  transport: SyncTransport,
  options: { syncState?: SyncStateStore; maxBytes?: number; residency?: ResidencyHooks } = {},
) {
  return createSyncEngine({
    localDatabaseAdapter: node.db,
    localObjectStorage: node.storage,
    remoteObjectStorage: cloud.storage,
    transport,
    clock: node.clock,
    syncState: options.syncState ?? createMemorySyncStateStore(),
    syncSharedRecords: true,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.residency ? { residency: options.residency } : {}),
  });
}

/** Counts storage checks, so a test can see how much a walk did. */
function countingHas(side: Side): { readonly count: () => number } {
  let calls = 0;
  const real = side.storage.has.bind(side.storage);
  side.storage.has = async (key: string) => {
    calls += 1;
    return real(key);
  };
  return { count: () => calls };
}

describe("the responder's bytes watermark", () => {
  it("stops at the first missing file, and passes it once the file arrives", async () => {
    const [cloud] = await sides("C");
    const a = await seedFile(cloud!, 10);
    const b = await seedFile(cloud!, 10, { withFile: false });
    const c = await seedFile(cloud!, 10);
    const transport = responder(cloud!);

    const first = await transport.exchange({ watermarks: {}, limit: 0 });
    expect(first.responderByteWatermarks?.["C"]).toEqual(await hlcOf(cloud!, a));
    // Rows are covered regardless.
    expect(first.responderWatermarks["C"]).toEqual(await hlcOf(cloud!, c));

    await cloud!.storage.put(await keyOf(cloud!, b), new Uint8Array(8));
    const second = await transport.exchange({ watermarks: {}, limit: 0 });
    expect(second.responderByteWatermarks?.["C"]).toEqual(await hlcOf(cloud!, c));
  });

  it("spreads a first walk over a large library across exchanges", async () => {
    const [cloud] = await sides("C");
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 300; i += 1) ids.push(await seedFile(cloud!, 10));
    const has = countingHas(cloud!);
    const transport = responder(cloud!);

    const first = await transport.exchange({ watermarks: {}, limit: 0 });
    // 256 checks per exchange, so the first walk stops short of the top.
    expect(has.count()).toBeLessThanOrEqual(256);
    expect(first.responderByteWatermarks?.["C"]).toEqual(await hlcOf(cloud!, ids[255]!));

    const second = await transport.exchange({ watermarks: {}, limit: 0 });
    expect(second.responderByteWatermarks?.["C"]).toEqual(await hlcOf(cloud!, ids[299]!));

    // Steady state checks nothing: everything is below the stored value.
    const before = has.count();
    await transport.exchange({ watermarks: {}, limit: 0 });
    expect(has.count()).toBe(before);
  });

  it("starts from the stored value, so a new transport over the same store re-checks nothing", async () => {
    const [cloud] = await sides("C");
    for (let i = 0; i < 20; i += 1) await seedFile(cloud!, 10);
    const store = createMemoryByteCoverageStore();
    await responder(cloud!, { byteCoverage: store }).exchange({ watermarks: {}, limit: 0 });

    const has = countingHas(cloud!);
    await responder(cloud!, { byteCoverage: store }).exchange({ watermarks: {}, limit: 0 });
    expect(has.count()).toBe(0);
  });

  it("lowers a stored value above the rows it still holds", async () => {
    const [cloud] = await sides("C");
    const kept = await seedFile(cloud!, 10);
    const lost = await seedFile(cloud!, 10);
    const store = createMemoryByteCoverageStore({ C: await hlcOf(cloud!, lost) });
    (cloud!.db as unknown as { store: Map<string, unknown> }).store.delete(lost);

    const response = await responder(cloud!, { byteCoverage: store }).exchange({
      watermarks: {},
      limit: 0,
    });
    expect(response.responderByteWatermarks?.["C"]).toEqual(await hlcOf(cloud!, kept));
  });

  it("counts a file it declines as held", async () => {
    const [cloud] = await sides("C");
    const declined = await seedFile(cloud!, 10, { withFile: false });
    const declinedKey = await keyOf(cloud!, declined);
    const after = await seedFile(cloud!, 10);

    const response = await responder(cloud!, {
      declinesBlob: async (key) => key === declinedKey,
    }).exchange({ watermarks: {}, limit: 0 });
    expect(response.responderByteWatermarks?.["C"]).toEqual(await hlcOf(cloud!, after));
  });

  it("omits its bytes watermark when it cannot load the stored value", async () => {
    const [cloud] = await sides("C");
    await seedFile(cloud!, 10);
    const response = await responder(cloud!, {
      byteCoverage: {
        load: async () => {
          throw new Error("[test] table missing");
        },
        save: async () => {},
      },
    }).exchange({ watermarks: {}, limit: 0 });
    expect(response.responderByteWatermarks).toBeUndefined();
  });

  it("still reports when it cannot save", async () => {
    const [cloud] = await sides("C");
    const id = await seedFile(cloud!, 10);
    const response = await responder(cloud!, {
      byteCoverage: {
        load: async () => ({}),
        save: async () => {
          throw new Error("[test] write conflict");
        },
      },
    }).exchange({ watermarks: {}, limit: 0 });
    expect(response.responderByteWatermarks?.["C"]).toEqual(await hlcOf(cloud!, id));
  });

  it("reports its rows watermark as its bytes watermark on a channel that carries no files", async () => {
    const [cloud] = await sides("C");
    const app = makeMockAppSource("notes", [{ name: "test_rows", pkColumns: ["id"] }]);
    const ts = cloud!.clock.now();
    await app.applier.apply({
      timestamp: ts,
      appId: "notes",
      table: "test_rows",
      op: "insert",
      where: { id: "n1" },
      row: { id: "n1", value: "v", updated_at: serializeHLC(ts), deleted_at: null },
    });
    const response = await createInProcessSyncTransport({
      databaseAdapter: cloud!.db,
      clock: cloud!.clock,
      objectStorage: cloud!.storage,
      syncSharedRecords: false,
      appSyncableSource: { namespaces: app.namespaces, applier: app.applier },
      byteCoverage: {
        load: async () => {
          throw new Error("[test] a file-less channel must not need a store");
        },
        save: async () => {},
      },
    }).exchange({ watermarks: {}, limit: 0 });
    expect(response.responderByteWatermarks).toEqual(response.responderWatermarks);
  });
});

describe("pushing rows ahead of files", () => {
  it("asks a new peer for its bytes watermark once, then pushes", async () => {
    const [cloud, phone] = await sides("C", "P");
    await seedFile(phone!, 10);
    const base = responder(cloud!);
    const probes: SyncExchangeRequest[] = [];
    const transport: SyncTransport = {
      async exchange(request) {
        if (request.limit === 0) probes.push(request);
        return base.exchange(request);
      },
    };
    const node = engine(phone!, cloud!, transport);

    await node.exchange();
    await seedFile(phone!, 10);
    await node.exchange();

    expect(probes).toHaveLength(1);
    expect((await cloud!.db.query({})).records).toHaveLength(2);
  });

  it("pushes nothing to a peer that does not report a bytes watermark, and still pulls", async () => {
    const [cloud, phone] = await sides("C", "P");
    const ours = await seedFile(phone!, 10);
    const theirs = await seedFile(cloud!, 10);
    const base = responder(cloud!);
    // A cloud data server from before the bytes watermark existed.
    const old: SyncTransport = {
      async exchange(request): Promise<SyncExchangeResponse> {
        const { responderByteWatermarks: _dropped, ...response } = await base.exchange(request);
        return response;
      },
    };
    const syncState = createMemorySyncStateStore();
    const result = await engine(phone!, cloud!, old, { syncState }).exchange();

    // Shipping rows to it would leave their uploads owed with nothing
    // remembering them, so nothing ships, and the round says so.
    expect(await cloud!.db.get(ours)).toBeNull();
    expect(result.shipped).toBe(0);
    expect(result.blocked).toBe(true);
    // Pulling does not depend on the peer tracking files.
    expect(await phone!.db.get(theirs)).not.toBeNull();
    expect(await phone!.storage.has(await keyOf(cloud!, theirs))).toBe(true);
    expect(await syncState.getPeerByteWatermarks()).toBeNull();
  });

  it("ships a no-cloud record's row and label but never its file", async () => {
    const [cloud, phone] = await sides("C", "P");
    const id = await seedFile(phone!, 10);
    await phone!.db.upsertLabels([
      {
        recordId: id,
        appId: "starkeep",
        key: "no-cloud",
        value: "",
        recordType: "image/jpeg",
        hlc: phone!.clock.now(),
      },
    ]);
    const node = engine(phone!, cloud!, responder(cloud!, { declinesBlob: async () => true }));

    const result = await node.sync();

    expect(await cloud!.db.get(id)).not.toBeNull();
    expect(await cloud!.db.getLabel(id, "starkeep", "no-cloud", "")).not.toBeNull();
    expect(await cloud!.storage.has(await keyOf(phone!, id))).toBe(false);
    // Declining is not a failure on either side.
    expect(result.complete).toBe(true);
  });

  it("uploads a file the peer still lacks without re-shipping its row", async () => {
    const [cloud, phone] = await sides("C", "P");
    const id = await seedFile(phone!, 10);
    const key = await keyOf(phone!, id);
    let failing = true;
    const realPut = cloud!.storage.putStream.bind(cloud!.storage);
    cloud!.storage.putStream = async (k: string, ...rest: unknown[]) => {
      if (failing && k === key) throw new Error("[test] link down");
      return (realPut as (...a: unknown[]) => Promise<void>)(k, ...rest);
    };
    const node = engine(phone!, cloud!, responder(cloud!));

    const first = await node.exchange();
    expect(first.shipped).toBe(1);
    expect(first.uploaded).toBe(0);

    failing = false;
    const second = await node.exchange();
    expect(second.shipped).toBe(0);
    expect(second.uploaded).toBe(1);
    expect(await cloud!.storage.has(key)).toBe(true);
  });

  it("reports the records whose files the walk has just passed, each once", async () => {
    // The responder never sees an upload, only its own walk finding the file
    // later. The cloud re-decides archiving from this report, because the
    // decision it took when the row applied found no bytes.
    const [cloud, phone] = await sides("C", "P");
    const first = await seedFile(phone!, 10);
    const second = await seedFile(phone!, 10);
    const firstKey = await keyOf(phone!, first);
    let failing = true;
    const realPut = cloud!.storage.putStream.bind(cloud!.storage);
    cloud!.storage.putStream = async (k: string, ...rest: unknown[]) => {
      if (failing && k === firstKey) throw new Error("[test] link down");
      return (realPut as (...a: unknown[]) => Promise<void>)(k, ...rest);
    };
    const held: StarkeepId[] = [];
    const node = engine(
      phone!,
      cloud!,
      responder(cloud!, {
        onFilesHeld: async (ids) => {
          held.push(...ids);
        },
      }),
    );

    await node.exchange();
    await node.exchange();
    // The second file is in the cloud, but the watermark stops at the first.
    expect(await cloud!.storage.has(await keyOf(phone!, second))).toBe(true);
    expect(held).toEqual([]);

    failing = false;
    await node.exchange(); // uploads the first file
    await node.exchange(); // the walk finds both
    await node.exchange(); // and reports neither again
    expect([...held].sort()).toEqual([first, second].sort());
  });
});

describe("pulling rows ahead of files", () => {
  it("does not loop or report a fault over a file no reachable node holds yet", async () => {
    const [cloud, desktop] = await sides("C", "D");
    // A phone's row reached the cloud; its file has not.
    const pending = await seedFile(cloud!, 10, { withFile: false });
    const node = engine(desktop!, cloud!, responder(cloud!));

    const result = await node.sync({ maxRounds: 20 });

    expect(await desktop!.db.get(pending)).not.toBeNull();
    expect(result.complete).toBe(true);
    expect(result.stalled).toBe(false);
    expect(result.rounds).toBeLessThan(5);
  });

  it("starts its bytes watermark from its rows watermark, so an upgrade fetches nothing old again", async () => {
    const [cloud, desktop] = await sides("C", "D");
    const old = await seedFile(cloud!, 10);
    const syncState = createMemorySyncStateStore();
    // The node synced `old` before the split, then lost or declined its file:
    // the old single watermark already covers it.
    await syncState.setWatermarks({ C: await hlcOf(cloud!, old) });
    await desktop!.db.put((await cloud!.db.get(old))!);
    const fresh = await seedFile(cloud!, 10);

    await engine(desktop!, cloud!, responder(cloud!), { syncState }).exchange();

    expect(await desktop!.storage.has(await keyOf(cloud!, old))).toBe(false);
    expect(await desktop!.storage.has(await keyOf(cloud!, fresh))).toBe(true);
    expect((await syncState.getByteWatermarks())?.["C"]).toEqual(await hlcOf(cloud!, fresh));
  });
});

describe("a phone's video and a desktop, end to end", () => {
  it("shows the desktop every row and thumbnail while the video is still uploading", async () => {
    const [cloud, phone, desktop] = await sides("C", "P", "D");
    const video = await seedFile(phone!, 200 * MB);
    const photos = [await seedFile(phone!, 2 * MB), await seedFile(phone!, 2 * MB)];
    const thumbs = [await seedFile(phone!, 40_000), await seedFile(phone!, 40_000)];
    const videoKey = await keyOf(phone!, video);

    let videoLinkUp = false;
    const realPut = cloud!.storage.putStream.bind(cloud!.storage);
    cloud!.storage.putStream = async (k: string, ...rest: unknown[]) => {
      if (!videoLinkUp && k === videoKey) throw new Error("[test] the video is still uploading");
      return (realPut as (...a: unknown[]) => Promise<void>)(k, ...rest);
    };

    // One cloud, one stored bytes watermark, two clients.
    const transport = responder(cloud!);
    const phoneSync = engine(phone!, cloud!, transport, { maxBytes: 10 * MB });
    const desktopState = createMemorySyncStateStore();
    const desktopSync = engine(desktop!, cloud!, transport, { syncState: desktopState });

    await phoneSync.sync({ maxRounds: 10 });
    const desktopRound = await desktopSync.sync({ maxRounds: 10 });

    // Every row is on the desktop already: the video holds back nothing.
    for (const id of [video, ...photos, ...thumbs]) {
      expect(await desktop!.db.get(id), id).not.toBeNull();
    }
    // The thumbnails and photos overtook the video on both legs.
    for (const id of [...photos, ...thumbs]) {
      expect(await desktop!.storage.has(await keyOf(phone!, id)), id).toBe(true);
    }
    expect(await desktop!.storage.has(videoKey)).toBe(false);
    // Waiting for another node's upload is not a fault on the desktop.
    expect(desktopRound.stalled).toBe(false);
    expect(desktopRound.complete).toBe(true);
    // The desktop's bytes watermark stops before the video, keeping it owed.
    expect((await desktopState.getByteWatermarks())?.["P"]).toBeUndefined();

    // The upload finishes; the next syncs on each side bring it across.
    videoLinkUp = true;
    await phoneSync.sync({ maxRounds: 10 });
    await desktopSync.sync({ maxRounds: 10 });
    expect(await desktop!.storage.has(videoKey)).toBe(true);
    expect((await desktopState.getByteWatermarks())?.["P"]).toEqual(
      await hlcOf(phone!, thumbs[1]!),
    );
  });
});

describe("transferFileOutcome", () => {
  it("tells bytes that moved from bytes already there, and from a missing source", async () => {
    const files = createFileSyncEngine();
    const source = new MockObjectStorageAdapter();
    const destination = new MockObjectStorageAdapter();
    await source.init();
    await destination.init();
    await source.put("k", new Uint8Array([1, 2, 3]));
    const manifest = { fileHash: "k", objectStorageKey: "k", sizeBytes: 3 };

    expect(await files.transferFileOutcome(manifest, source, destination)).toBe("transferred");
    expect(await files.transferFileOutcome(manifest, source, destination)).toBe("present");
    expect(
      await files.transferFileOutcome(
        { ...manifest, objectStorageKey: "missing" },
        source,
        destination,
      ),
    ).toBe("failed");
  });
});

// "Is my library backed up?" Rows no longer wait for their files, so matching
// row counts say nothing about bytes, and `verify()` counts the files the
// peer is still owed against its bytes watermark.
describe("verify() and owed files", () => {
  /** A cloud whose storage refuses every upload while `down()` is true. */
  function flakyCloud(cloud: Side) {
    let failing = true;
    const realPut = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (k: string, ...rest: unknown[]) => {
      if (failing) throw new Error("[test] link down");
      return (realPut as (...a: unknown[]) => Promise<void>)(k, ...rest);
    };
    return { restore: () => (failing = false) };
  }

  it("counts files whose rows shipped and whose uploads have not, and none once the walk passes them", async () => {
    const [cloud, phone] = await sides("C", "P");
    for (let i = 0; i < 3; i += 1) await seedFile(phone!, 10);
    const link = flakyCloud(cloud!);
    const node = engine(phone!, cloud!, responder(cloud!));

    const first = await node.exchange();
    expect(first.shipped).toBe(3);
    expect(first.uploaded).toBe(0);
    const before = await node.verify();
    expect(before.supported).toBe(true);
    expect(before.divergentBuckets).toBe(0);
    expect(before.pendingUpload).toBe(0);
    expect(before.filesOwed).toBe(3);
    expect(before.filesOwedCapped).toBe(false);

    link.restore();
    await node.exchange();
    // verify()'s own exchange walks the peer's watermark past the uploads.
    const after = await node.verify();
    expect(after.filesOwed).toBe(0);
  });

  it("does not count a file this node does not hold", async () => {
    const [cloud, phone] = await sides("C", "P");
    await seedFile(phone!, 10, { withFile: false });
    flakyCloud(cloud!);
    const node = engine(phone!, cloud!, responder(cloud!));
    await node.exchange();
    expect((await node.verify()).filesOwed).toBe(0);
  });
});
