import {
  listTypes,
  listCloudTypes,
  DriveNotInstalledError,
} from "../../../src/lib/drive-client";

export async function GET() {
  try {
    const [local, cloudResult] = await Promise.all([
      listTypes(),
      // Best-effort: any cloud failure just means no cloud-only chips.
      listCloudTypes()
        .then((types) => ({ types, error: null as string | null }))
        .catch((err: unknown) => ({
          types: [] as Awaited<ReturnType<typeof listCloudTypes>>,
          error: err instanceof Error ? err.message : String(err),
        })),
    ]);

    // Union of local and cloud types so a type that only exists in the cloud
    // (or only locally) still gets a filter chip. Count shown is the max of the
    // two sides — enough to size the chip; the per-record badges carry the
    // real local/cloud/synced breakdown.
    const counts = new Map<string, number>();
    for (const t of local) counts.set(t.record_type, t.count);
    for (const t of cloudResult.types) {
      counts.set(t.record_type, Math.max(counts.get(t.record_type) ?? 0, t.count));
    }

    const types = Array.from(counts.entries())
      .map(([record_type, count]) => ({ record_type, count }))
      .sort((a, b) => b.count - a.count);

    return Response.json({
      types,
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
