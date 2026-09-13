/**
 * Tests for GET /api/records — the merge that gives every row its sync status.
 *
 * The merge is the whole of Drive's product claim: one list covering data that
 * lives on this device, in the cloud, or in both, with each row saying which.
 * Nothing else computes it, and the four statuses are decided here from two
 * independently fetched lists.
 *
 * The local-data-server client is mocked. What is under test is the merge, the
 * ordering, and the rule that the cloud half is best-effort while the local
 * half is required.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { listRecords, listCloudRecords, DriveNotInstalledError } = vi.hoisted(() => {
  // The route distinguishes "not installed" with `instanceof`, so the stand-in
  // must be the same class the route imports — hence it lives in the mock.
  class DriveNotInstalledError extends Error {
    constructor() {
      super("not installed");
      this.name = "DriveNotInstalledError";
    }
  }
  return { listRecords: vi.fn(), listCloudRecords: vi.fn(), DriveNotInstalledError };
});

vi.mock("../src/lib/drive-client", () => ({
  listRecords,
  listCloudRecords,
  DriveNotInstalledError,
}));

import { GET } from "../src/routes/records";

interface Row {
  id: string;
  sync_status: string;
  version?: number;
  updated_at?: string;
}

function local(id: string, over: Partial<Row> = {}) {
  return { id, version: 1, updated_at: "2026-01-01T00:00:00Z", type: "image/png", ...over };
}

function call(query = ""): Promise<Response> {
  return GET(new Request(`http://drive.local/api/records${query}`));
}

async function rows(res: Response): Promise<Row[]> {
  return ((await res.json()) as { records: Row[] }).records;
}

beforeEach(() => {
  listRecords.mockReset();
  listCloudRecords.mockReset();
  listRecords.mockResolvedValue([]);
  listCloudRecords.mockResolvedValue([]);
});

describe("GET /api/records — the sync-status merge", () => {
  it("marks a record the cloud has never seen local-only", async () => {
    listRecords.mockResolvedValue([local("a")]);

    expect(await rows(await call())).toEqual([expect.objectContaining({ id: "a", sync_status: "local-only" })]);
  });

  it("marks a record at the same version on both sides synced", async () => {
    listRecords.mockResolvedValue([local("a", { version: 3 })]);
    listCloudRecords.mockResolvedValue([local("a", { version: 3 })]);

    expect(await rows(await call())).toEqual([expect.objectContaining({ id: "a", sync_status: "synced" })]);
  });

  it("marks a record whose local version has advanced modified-locally", async () => {
    listRecords.mockResolvedValue([local("a", { version: 4 })]);
    listCloudRecords.mockResolvedValue([local("a", { version: 3 })]);

    expect(await rows(await call())).toEqual([
      expect.objectContaining({ id: "a", sync_status: "modified-locally" }),
    ]);
  });

  it("marks a record only the cloud has cloud-only", async () => {
    listCloudRecords.mockResolvedValue([local("cloudy")]);

    expect(await rows(await call())).toEqual([
      expect.objectContaining({ id: "cloudy", sync_status: "cloud-only" }),
    ]);
  });

  it("counts a local record behind the cloud as synced rather than modified", async () => {
    // Only the local copy having advanced means unpushed edits. The other
    // direction is the cloud being ahead, which is a pull this device has not
    // run — not a local modification.
    listRecords.mockResolvedValue([local("a", { version: 2 })]);
    listCloudRecords.mockResolvedValue([local("a", { version: 5 })]);

    expect((await rows(await call()))[0].sync_status).toBe("synced");
  });

  it("orders the merged list newest first", async () => {
    listRecords.mockResolvedValue([
      local("old", { updated_at: "2026-01-01T00:00:00Z" }),
      local("new", { updated_at: "2026-06-01T00:00:00Z" }),
    ]);
    listCloudRecords.mockResolvedValue([local("middle", { updated_at: "2026-03-01T00:00:00Z" })]);

    expect((await rows(await call())).map((r) => r.id)).toEqual(["new", "middle", "old"]);
  });
});

describe("GET /api/records — the type filter", () => {
  it("passes the requested type to both data planes", async () => {
    await call("?type=image%2Fpng");

    expect(listRecords).toHaveBeenCalledWith("image/png");
    expect(listCloudRecords).toHaveBeenCalledWith("image/png");
  });

  it("asks for everything when no type is requested", async () => {
    await call();

    expect(listRecords).toHaveBeenCalledWith(undefined);
    expect(listCloudRecords).toHaveBeenCalledWith(undefined);
  });
});

describe("GET /api/records — the cloud half is best-effort", () => {
  it("reports the cloud available when both halves answered", async () => {
    const body = (await (await call()).json()) as { cloud: { available: boolean } };

    expect(body.cloud.available).toBe(true);
  });

  it("still renders the local view when the cloud fails, and says why", async () => {
    listRecords.mockResolvedValue([local("a")]);
    listCloudRecords.mockRejectedValue(new Error("not signed in"));

    const res = await call();
    const body = (await res.json()) as { records: Row[]; cloud: { available: boolean; error: string } };

    expect(res.status).toBe(200);
    expect(body.records.map((r) => r.id)).toEqual(["a"]);
    expect(body.cloud).toEqual({ available: false, error: "not signed in" });
  });
});

describe("GET /api/records — the local half is required", () => {
  it("answers 503 when Drive is not installed on this device", async () => {
    listRecords.mockRejectedValue(new DriveNotInstalledError());

    const res = await call();

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("not installed");
  });

  it("answers 502 for any other local failure", async () => {
    listRecords.mockRejectedValue(new Error("local-data-server /data/records → 500"));

    const res = await call();

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("500");
  });
});
