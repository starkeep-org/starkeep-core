/**
 * Tests for GET /api/trash and POST /api/trash/:id/restore.
 *
 * The rule the route encodes is that the scheduled deletion date is the whole
 * promise a Trash makes: an item that might be reclaimed tomorrow and one that will
 * still be there next year look identical without it. So the date is computed per
 * item from the library's configured window — and when this node cannot read the
 * winning settings file, it is `null` rather than a date derived from a default the
 * person may never have chosen.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { getTrashPolicy, listDeletedRecords, restoreRecord, DriveNotInstalledError } = vi.hoisted(
  () => {
    class DriveNotInstalledError extends Error {
      constructor() {
        super("not installed");
        this.name = "DriveNotInstalledError";
      }
    }
    return {
      getTrashPolicy: vi.fn(),
      listDeletedRecords: vi.fn(),
      restoreRecord: vi.fn(),
      DriveNotInstalledError,
    };
  },
);

vi.mock("../src/lib/drive-client", () => ({
  getTrashPolicy,
  listDeletedRecords,
  restoreRecord,
  DriveNotInstalledError,
}));

import { GET, RESTORE } from "../src/routes/trash";

interface Row {
  id: string;
  deleted_at?: string | null;
  deletes_at: string | null;
}

async function rows(): Promise<Row[]> {
  return ((await (await GET()).json()) as { records: Row[] }).records;
}

function deleted(id: string, deletedAt: string | null) {
  return {
    id,
    kind: "data",
    type: "image/jpeg",
    category: "image",
    origin_app_id: "photos",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: deletedAt ?? "2026-01-01T00:00:00.000Z",
    version: 2,
    content_hash: "h",
    object_storage_key: "k",
    mime_type: "image/jpeg",
    size_bytes: 1000,
    original_filename: `${id}.jpg`,
    parent_id: null,
    deleted_at: deletedAt,
  };
}

beforeEach(() => {
  getTrashPolicy.mockReset();
  listDeletedRecords.mockReset();
  restoreRecord.mockReset();
  getTrashPolicy.mockResolvedValue({
    retention_days: 30,
    default_retention_days: 30,
    knows_library_value: true,
  });
  listDeletedRecords.mockResolvedValue([]);
});

describe("the scheduled deletion date", () => {
  it("is the deletion plus the library's window", async () => {
    listDeletedRecords.mockResolvedValue([deleted("a", "2026-09-01T00:00:00.000Z")]);
    expect((await rows())[0]!.deletes_at).toBe("2026-10-01T00:00:00.000Z");
  });

  it("follows a window the person widened, rather than the platform default", async () => {
    getTrashPolicy.mockResolvedValue({
      retention_days: 365,
      default_retention_days: 30,
      knows_library_value: true,
    });
    listDeletedRecords.mockResolvedValue([deleted("a", "2026-09-01T00:00:00.000Z")]);
    expect((await rows())[0]!.deletes_at).toBe("2027-09-01T00:00:00.000Z");
  });

  it("is null when this node cannot read the library's window", async () => {
    // Stating a date derived from the default under a library whose owner chose a
    // year would be promising something the library does not hold to. The reaper is
    // in the dark for the same reason, and reaps nothing.
    getTrashPolicy.mockResolvedValue({
      retention_days: null,
      default_retention_days: 30,
      knows_library_value: false,
    });
    listDeletedRecords.mockResolvedValue([deleted("a", "2026-09-01T00:00:00.000Z")]);
    expect((await rows())[0]!.deletes_at).toBeNull();
  });

  it("is null for a row whose deletion time will not parse", async () => {
    listDeletedRecords.mockResolvedValue([deleted("a", "not-a-date")]);
    expect((await rows())[0]!.deletes_at).toBeNull();
  });
});

describe("the list", () => {
  it("is newest deletion first, which is the order a Trash is read in", async () => {
    listDeletedRecords.mockResolvedValue([
      deleted("old", "2026-01-01T00:00:00.000Z"),
      deleted("new", "2026-09-01T00:00:00.000Z"),
      deleted("mid", "2026-05-01T00:00:00.000Z"),
    ]);
    expect((await rows()).map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("answers 503 when Drive is not installed locally, and 502 otherwise", async () => {
    getTrashPolicy.mockRejectedValue(new DriveNotInstalledError());
    expect((await GET()).status).toBe(503);
    getTrashPolicy.mockRejectedValue(new Error("the data server is down"));
    expect((await GET()).status).toBe(502);
  });
});

describe("restore", () => {
  it("returns the ids the cascade brought back", async () => {
    restoreRecord.mockResolvedValue({ ids: ["a", "a-canonical"] });
    const res = await RESTORE("a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: true, ids: ["a", "a-canonical"] });
    expect(restoreRecord).toHaveBeenCalledWith("a");
  });

  it("surfaces a refusal rather than reporting a success", async () => {
    // The server answers 409 for a record that is not deleted, which means the view
    // is reading a stale page — and the person should be told.
    restoreRecord.mockRejectedValue(
      new Error("this record is not deleted, so there is nothing to restore"),
    );
    const res = await RESTORE("a");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("not deleted");
  });
});
