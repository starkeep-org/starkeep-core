/**
 * The app-private blob plane against a real cloud channel.
 *
 * `app-blob-plane.test.ts` asserts what each of the four operations does to one
 * node's database and object store, on a node with nowhere to sync to. This
 * file asserts the half that needs a second party: that a sync round applies an
 * app's rows and leaves its bytes in the cloud, that the fetch route is what
 * brings those bytes down, and that a drop's durability question is answered by
 * asking the cloud rather than by assuming.
 *
 * The fetch route is the reason this file exists. Section 4 of
 * `implementation-status-rendition-ownership-phase-2-2026-09-18.md` names it as
 * the one claim phase 2 made without landing a byte: every other assertion about
 * `POST /app-data/files/<subKey>/fetch` is about the decision it makes and the
 * outcome it reports, and the transfer itself was covered only by `acquireBlob`'s
 * own tests. A transfer needs a peer to transfer from, which is the Tier-1 shape
 * `app-removal-over-wire.test.ts` established.
 *
 * One fake cloud, one node. Convergence is driven with explicit `/sync/now`
 * rounds rather than the tick, in the manner `sync-over-wire.test.ts`
 * established and for the reason its `converge()` comment gives.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startLocalDataServer,
  startFakeCloud,
  fakeIdToken,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import {
  builtinAppCreds,
  installApp,
  putAppFile,
  testAppManifest,
  eventually,
  type InstalledApp,
} from "./helpers.js";

const GB = 1024 ** 3;

let cloud: FakeCloud;
let server: LocalDataServer;
let drive: InstalledApp;

/** Declares `files: { regenerable: true }` — Photos' shape. */
let derived: InstalledApp;
/** Declares `files: true` — the short spelling of "not re-derivable". */
let precious: InstalledApp;
/** Regenerable, and budgeted to nothing by the operator. */
let starved: InstalledApp;

interface ResidencyPage {
  budgetBytes: number | null;
  heldBytes: number;
  entries: Array<{
    subKey: string;
    sizeBytes: number;
    resident: boolean;
    lastOpenedAtMs: number | null;
  }>;
  nextCursor: string | null;
}

function manifestFor(
  id: string,
  files: unknown,
): Record<string, unknown> {
  return testAppManifest({
    id,
    name: id,
    infraRequirements: {
      appSpecificSyncable: {
        files,
        tables: [
          {
            name: "notes",
            columns: [{ name: "note_id", type: "text", primaryKey: true, notNull: true }],
          },
        ],
      },
    },
  });
}

const DERIVED = manifestFor("derived", { regenerable: true });
const PRECIOUS = manifestFor("precious", true);
const STARVED = manifestFor("starved", { regenerable: true });

/** One round on Drive plus each app channel, until two rounds report nothing. */
async function converge(apps: InstalledApp[], maxRounds = 30): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < maxRounds; i++) {
    const rounds = await Promise.all(
      [drive, ...apps].map(async (who) => {
        const res = await who.fetch("/sync/now", { method: "POST" });
        expect(res.status).toBe(200);
        return (await res.json()) as { applied: number; shipped: number };
      }),
    );
    if (rounds.some((r) => r.applied !== 0 || r.shipped !== 0)) {
      quiet = 0;
      continue;
    }
    quiet += 1;
    if (quiet >= 2) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`did not converge within ${maxRounds} rounds`);
}

async function residency(app: InstalledApp): Promise<ResidencyPage> {
  const res = await app.fetch("/app-data/residency");
  expect(res.status).toBe(200);
  return (await res.json()) as ResidencyPage;
}

async function entry(
  app: InstalledApp,
  subKey: string,
): Promise<ResidencyPage["entries"][number] | undefined> {
  return (await residency(app)).entries.find((e) => e.subKey === subKey);
}

/** The blob's bytes through the ordinary file route, or null when absent. */
async function bytesOf(app: InstalledApp, subKey: string): Promise<string | null> {
  const res = await app.fetch(`/app-data/files/${subKey}`);
  if (!res.ok) return null;
  const { url } = (await res.json()) as { url: string };
  const bytes = await fetch(url);
  if (bytes.status !== 200) return null;
  return bytes.text();
}

interface FetchOutcome {
  status: number;
  body: { landed: boolean; reason: string };
}

async function fetchBlob(app: InstalledApp, subKey: string): Promise<FetchOutcome> {
  const res = await app.fetch(`/app-data/files/${subKey}/fetch`, { method: "POST" });
  return { status: res.status, body: (await res.json()) as FetchOutcome["body"] };
}

interface DropOutcome {
  status: number;
  body: { dropped: boolean; reason: string; confirmedReplicas?: number };
}

async function dropBlob(app: InstalledApp, subKey: string): Promise<DropOutcome> {
  const res = await app.fetch(`/app-data/files/${subKey}/blob`, { method: "DELETE" });
  return { status: res.status, body: (await res.json()) as DropOutcome["body"] };
}

beforeAll(async () => {
  cloud = await startFakeCloud();
  server = await startLocalDataServer({
    config: {
      apiGatewayUrl: cloud.url,
      // Effectively no tick: every exchange in this file is one the test asked
      // for, so a fetch is never racing a round nobody wrote down.
      pullIntervalMs: 600_000,
      pushDebounceMs: 50,
      retention: {
        platform: {
          rows: { "original:image": { prefetch: true, share: 1 } },
          fallback: { prefetch: true, share: 1 },
          budgetBytes: 10 * GB,
        },
        apps: {
          derived: { budgetBytes: GB },
          precious: { budgetBytes: GB },
          // The operator's "hold nothing of this app here". A fetch must
          // honour it — the `request` trigger sets `prefetch` aside and
          // nothing else.
          starved: { budgetBytes: 0 },
        },
        appFallback: { budgetBytes: GB },
      },
    },
    auth: { idToken: fakeIdToken() },
  });
  drive = await builtinAppCreds(server, "starkeep-drive");

  for (const manifest of [DERIVED, PRECIOUS, STARVED]) cloud.installApp(manifest);
  derived = await installApp(server, DERIVED);
  precious = await installApp(server, PRECIOUS);
  starved = await installApp(server, STARVED);
}, 90_000);

afterAll(async () => {
  await server?.stop();
  await cloud?.close();
});

describe("a round carries an app's rows and leaves its bytes where they are", () => {
  beforeAll(async () => {
    await cloud.setAppFile("derived", "from-cloud/rendition.bin", "bytes made elsewhere");
    await converge([derived]);
  }, 60_000);

  /**
   * The premise every later assertion rests on, and the behaviour phase 2
   * introduced: `APP_BLOB_ROW` is `prefetch: false`, so a round applies the row
   * and declines the transfer. Without this the fetch route would have nothing
   * to do, because the bytes would already be here.
   */
  it("applies the file row without pulling the blob", async () => {
    const found = await eventually(async () => {
      const e = await entry(derived, "from-cloud/rendition.bin");
      expect(e).toBeDefined();
      return e!;
    });
    expect(found.resident).toBe(false);
    expect(await bytesOf(derived, "from-cloud/rendition.bin")).toBeNull();
  }, 30_000);

  /**
   * The claim section 4 of the phase-2 status names as untested: bytes actually
   * land. Everything else asserted about this route is a decision or a reported
   * outcome; this is the transfer.
   */
  it("the fetch route lands the bytes for a row whose blob is absent", async () => {
    const outcome = await fetchBlob(derived, "from-cloud/rendition.bin");

    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ landed: true, reason: "landed" });
    expect(await bytesOf(derived, "from-cloud/rendition.bin")).toBe("bytes made elsewhere");
  }, 30_000);

  /**
   * The arrival is charged and ranked. A fetch is an open — the request is
   * somebody asking for the bytes — so ranking it never-opened would put what
   * was just asked for at the front of the queue to be given up again.
   */
  it("and charges them to the app's budget, ranked as just opened", async () => {
    const page = await residency(derived);
    const found = page.entries.find((e) => e.subKey === "from-cloud/rendition.bin")!;

    expect(found.resident).toBe(true);
    expect(page.heldBytes).toBeGreaterThanOrEqual(found.sizeBytes);
    expect(found.lastOpenedAtMs).not.toBeNull();
    expect(found.lastOpenedAtMs).toBeLessThanOrEqual(Date.now());
  });

  it("reports a second fetch as already here rather than transferring again", async () => {
    const outcome = await fetchBlob(derived, "from-cloud/rendition.bin");
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ landed: true, reason: "already-here" });
  });
});

describe("giving bytes up here and asking for them back", () => {
  /**
   * The round trip the whole plane exists for: an app reclaims disk on one
   * machine, the file survives everywhere including here, and the bytes come
   * back on request.
   */
  it("drops a locally-written blob and fetches it back from the cloud", async () => {
    await putAppFile(derived, "round-trip.bin", "written here, kept there");
    await converge([derived]);
    expect(await cloud.hasBlob("apps/derived/syncable/round-trip.bin")).toBe(true);

    const dropped = await dropBlob(derived, "round-trip.bin");
    expect(dropped.status).toBe(200);
    expect(dropped.body).toMatchObject({ dropped: true, reason: "dropped" });
    expect(await bytesOf(derived, "round-trip.bin")).toBeNull();

    const back = await fetchBlob(derived, "round-trip.bin");
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ landed: true, reason: "landed" });
    expect(await bytesOf(derived, "round-trip.bin")).toBe("written here, kept there");
  }, 60_000);

  /**
   * The rule the `request` trigger does *not* set aside.
   *
   * `prefetch` is the one rule a request overrides; the budget still binds. An
   * operator who has budgeted an app to nothing on this node has said something
   * about this node, and a fetch is not entitled to overrule it — so the route
   * answers `declined` rather than landing the bytes.
   */
  it("declines a fetch into a namespace the operator has budgeted to nothing", async () => {
    await cloud.setAppFile("starved", "wanted.bin", "bytes this node may not hold");
    await converge([starved]);
    await eventually(async () => {
      expect(await entry(starved, "wanted.bin")).toBeDefined();
    });

    const outcome = await fetchBlob(starved, "wanted.bin");
    // 200, not 503: nothing failed. The node answered the question.
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ landed: false, reason: "declined" });
    expect(await bytesOf(starved, "wanted.bin")).toBeNull();
  }, 60_000);
});

describe("the durability question a drop asks the cloud", () => {
  /**
   * The case the phase-2 status doc lists as outstanding: a non-regenerable
   * app's drop where a peer *does* hold the bytes. The refusal with zero probes
   * is the easy direction and is covered on a node with no cloud; this is the
   * direction that needs a peer to confirm.
   */
  it("allows a non-regenerable app to drop a blob the cloud confirms it holds", async () => {
    await putAppFile(precious, "safe-elsewhere.bin", "the cloud has this too");
    await converge([precious]);
    expect(await cloud.hasBlob("apps/precious/syncable/safe-elsewhere.bin")).toBe(true);

    const dropped = await dropBlob(precious, "safe-elsewhere.bin");
    expect(dropped.status).toBe(200);
    expect(dropped.body).toMatchObject({ dropped: true, reason: "dropped" });
    expect(dropped.body.confirmedReplicas).toBeGreaterThanOrEqual(1);
    expect(await bytesOf(precious, "safe-elsewhere.bin")).toBeNull();
  }, 60_000);

  /**
   * The same app, the same node, and a blob the cloud has never seen. The
   * refusal is about the evidence rather than about the app: bytes that have
   * not been shipped yet are the last copy, and this is the moment the app most
   * wants to be told no.
   */
  it("refuses a drop of bytes that have not reached the cloud yet", async () => {
    await putAppFile(precious, "not-shipped-yet.bin", "only here");

    const dropped = await dropBlob(precious, "not-shipped-yet.bin");
    expect(dropped.status).toBe(409);
    expect(dropped.body).toMatchObject({ dropped: false, reason: "not-durable" });
    expect(dropped.body.confirmedReplicas).toBe(0);
    expect(await bytesOf(precious, "not-shipped-yet.bin")).toBe("only here");
  }, 30_000);

  /**
   * And the answer changes once the bytes are up.
   *
   * This is what makes 409 the right status for the refusal above: the request
   * was well-formed and the caller was entitled to make it — the node simply
   * could not see a second copy yet, and after a round it can.
   */
  it("and allows the same drop after the round that ships them", async () => {
    await converge([precious]);

    const dropped = await dropBlob(precious, "not-shipped-yet.bin");
    expect(dropped.status).toBe(200);
    expect(dropped.body).toMatchObject({ dropped: true, reason: "dropped" });
  }, 60_000);
});
