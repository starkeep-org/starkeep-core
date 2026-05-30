import { NextRequest } from "next/server";
import {
  listRecords,
  listCloudRecords,
  DriveNotInstalledError,
  type DriveRecord,
} from "../../../src/lib/drive-client";

export type SyncStatus =
  | "local-only"
  | "synced"
  | "modified-locally"
  | "cloud-only";

export interface MergedRecord extends Partial<DriveRecord> {
  id: string;
  sync_status: SyncStatus;
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") ?? undefined;
  try {
    // Local is required; cloud is best-effort so the view still renders when
    // the cloud is unconfigured or signed out.
    const [local, cloudResult] = await Promise.all([
      listRecords(type),
      // Cloud is best-effort: any failure (unconfigured, signed out, an older
      // local-data-server without the /cloud proxy, network) degrades to a
      // local-only view rather than failing the whole request.
      listCloudRecords(type)
        .then((records) => ({ records, error: null as string | null }))
        .catch((err: unknown) => ({
          records: [] as Awaited<ReturnType<typeof listCloudRecords>>,
          error: err instanceof Error ? err.message : String(err),
        })),
    ]);

    const cloudById = new Map(cloudResult.records.map((r) => [r.id, r]));
    const merged: MergedRecord[] = [];

    for (const r of local) {
      const cloudRec = cloudById.get(r.id);
      let sync_status: SyncStatus;
      if (!cloudRec) {
        sync_status = "local-only";
      } else if (
        typeof r.version === "number" &&
        typeof cloudRec.version === "number" &&
        r.version > cloudRec.version
      ) {
        // Same record on both sides, but the local copy has advanced past what
        // the cloud has seen — there are edits that haven't pushed yet.
        sync_status = "modified-locally";
      } else {
        sync_status = "synced";
      }
      merged.push({ ...r, sync_status });
      cloudById.delete(r.id);
    }
    // Whatever remains in the cloud map exists only in the cloud.
    for (const r of cloudById.values()) {
      merged.push({ ...r, sync_status: "cloud-only" });
    }

    merged.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

    return Response.json({
      records: merged,
      cloud: { available: cloudResult.error === null, error: cloudResult.error },
    });
  } catch (err) {
    const status = err instanceof DriveNotInstalledError ? 503 : 502;
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status },
    );
  }
}
