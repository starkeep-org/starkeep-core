/**
 * Tests for GET /api/types — the union that backs the sidebar's filter chips.
 *
 * The rule the route encodes is that a type gets a chip when *either* side has
 * it, so a type that exists only in the cloud is still reachable from a device
 * that has none of its records. The count is the larger of the two sides, which
 * is a sizing hint rather than a total; the per-row badges carry the real
 * breakdown.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { listTypes, listCloudTypes, DriveNotInstalledError } = vi.hoisted(() => {
  class DriveNotInstalledError extends Error {
    constructor() {
      super("not installed");
      this.name = "DriveNotInstalledError";
    }
  }
  return { listTypes: vi.fn(), listCloudTypes: vi.fn(), DriveNotInstalledError };
});

vi.mock("../src/lib/drive-client", () => ({
  listTypes,
  listCloudTypes,
  DriveNotInstalledError,
}));

import { GET } from "../src/routes/types";

interface Chip {
  record_type: string;
  count: number;
}

async function chips(): Promise<Chip[]> {
  return ((await (await GET()).json()) as { types: Chip[] }).types;
}

beforeEach(() => {
  listTypes.mockReset();
  listCloudTypes.mockReset();
  listTypes.mockResolvedValue([]);
  listCloudTypes.mockResolvedValue([]);
});

describe("GET /api/types — the union", () => {
  it("gives a chip to a type only this device has", async () => {
    listTypes.mockResolvedValue([{ record_type: "image/png", count: 2 }]);

    expect(await chips()).toEqual([{ record_type: "image/png", count: 2 }]);
  });

  it("gives a chip to a type only the cloud has", async () => {
    listCloudTypes.mockResolvedValue([{ record_type: "document/pdf", count: 5 }]);

    expect(await chips()).toEqual([{ record_type: "document/pdf", count: 5 }]);
  });

  it("takes the larger count when both sides carry the type", async () => {
    listTypes.mockResolvedValue([{ record_type: "image/png", count: 2 }]);
    listCloudTypes.mockResolvedValue([{ record_type: "image/png", count: 7 }]);

    expect(await chips()).toEqual([{ record_type: "image/png", count: 7 }]);
  });

  it("keeps the local count when it is the larger one", async () => {
    listTypes.mockResolvedValue([{ record_type: "image/png", count: 9 }]);
    listCloudTypes.mockResolvedValue([{ record_type: "image/png", count: 1 }]);

    expect(await chips()).toEqual([{ record_type: "image/png", count: 9 }]);
  });

  it("orders the chips by count, largest first", async () => {
    listTypes.mockResolvedValue([
      { record_type: "text/plain", count: 1 },
      { record_type: "image/png", count: 4 },
    ]);
    listCloudTypes.mockResolvedValue([{ record_type: "document/pdf", count: 2 }]);

    expect((await chips()).map((c) => c.record_type)).toEqual([
      "image/png",
      "document/pdf",
      "text/plain",
    ]);
  });
});

describe("GET /api/types — the cloud half is best-effort", () => {
  it("reports the cloud available when both halves answered", async () => {
    const body = (await (await GET()).json()) as { cloud: { available: boolean } };

    expect(body.cloud.available).toBe(true);
  });

  it("still lists the local types when the cloud fails, and says why", async () => {
    listTypes.mockResolvedValue([{ record_type: "image/png", count: 2 }]);
    listCloudTypes.mockRejectedValue(new Error("cloud not configured"));

    const res = await GET();
    const body = (await res.json()) as { types: Chip[]; cloud: { available: boolean; error: string } };

    expect(res.status).toBe(200);
    expect(body.types).toEqual([{ record_type: "image/png", count: 2 }]);
    expect(body.cloud).toEqual({ available: false, error: "cloud not configured" });
  });
});

describe("GET /api/types — the local half is required", () => {
  it("answers 503 when Drive is not installed on this device", async () => {
    listTypes.mockRejectedValue(new DriveNotInstalledError());

    const res = await GET();

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("not installed");
  });

  it("answers 502 for any other local failure", async () => {
    listTypes.mockRejectedValue(new Error("local-data-server /data/types → 500"));

    const res = await GET();

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("500");
  });
});
