/**
 * One pass over every app-facing data route, through an app's own signing
 * proxy, on either surface.
 *
 * Server-level suites cover these routes against SQLite and a fake DSQL. They
 * do not cover them through an app's proxy on a deployed stack, and that is
 * where three bugs lived in one week: a shared-query route that crashed the
 * cloud data server's Lambda, a metadata route API Gateway could not route
 * because it decoded `%2F`, and a page whose burst of requests overran the
 * app's Lambda concurrency. Each route here is called once, the way an app's
 * page calls it, and its answer is checked for the shape the app reads.
 *
 * The caller supplies `send`, which reaches the proxy: Probe's tier-2 spec
 * sends to the local daemon, and the tier-3 journey sends through CloudFront
 * with a session cookie. The sweep makes its own records, rows and files, so
 * it reads nothing another step wrote, and it deletes the records it made at
 * the end.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

/** What the proxy answered: the status and the parsed JSON body. */
export interface SweepAnswer {
  status: number;
  body: unknown;
}

export interface RouteSweepTarget {
  /** Which surface the proxy fronts. Public links live in the cloud alone. */
  surface: "local" | "cloud";
  /**
   * Send one data-plane request through the app's proxy. `path` is the data
   * server's path, such as `/data/types`, with its query string.
   */
  send(method: string, path: string, json?: unknown): Promise<SweepAnswer>;
}

export interface RouteSweepApp {
  appId: string;
  /** A type the app may write, with metadata. */
  file: { type: string; contentType: string; bytes: () => Buffer };
  /** A valued label key the manifest declares. */
  labelKey: string;
  /** An app-syncable table, its primary-key column and one text column. */
  table: { name: string; keyColumn: string; valueColumn: string };
  /** Whether the manifest asks to publish public links (`publicSharing`). */
  publicSharing: boolean;
}

const q = (params: Record<string, string | number>) =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

function ok(answer: SweepAnswer, route: string): Record<string, unknown> {
  assert.ok(
    answer.status >= 200 && answer.status < 300,
    `${route} answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 300)}`,
  );
  assert.equal(typeof answer.body, "object", `${route} answered no JSON object`);
  return answer.body as Record<string, unknown>;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The headers a presigned PUT must carry: each one is inside the signature. */
function presignedPutHeaders(
  contentType: string,
  presign: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (typeof presign["checksumSha256"] === "string") {
    headers["x-amz-checksum-sha256"] = presign["checksumSha256"];
  }
  if (typeof presign["storageClass"] === "string") {
    headers["x-amz-storage-class"] = presign["storageClass"];
  }
  const tagging = presign["tagging"] as Record<string, string> | undefined;
  if (tagging && Object.keys(tagging).length > 0) {
    headers["x-amz-tagging"] = Object.entries(tagging)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
  }
  return headers;
}

/** PUT bytes to a presigned URL, which the data server signed for exactly these headers. */
async function putPresigned(
  presign: Record<string, unknown>,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  const url = presign["url"];
  assert.equal(typeof url, "string", "the presign answered no url");
  const res = await fetch(url as string, {
    method: "PUT",
    headers: presignedPutHeaders(contentType, presign),
    body: new Uint8Array(bytes),
  });
  assert.ok(res.ok, `the presigned PUT answered ${res.status}: ${await res.text()}`);
}

/**
 * Call every app-facing data route once. Answers the routes it checked, in
 * order, for the caller to log. Throws on the first route that answers wrong.
 */
export async function sweepAppRoutes(
  target: RouteSweepTarget,
  app: RouteSweepApp,
): Promise<string[]> {
  const checked: string[] = [];
  const route = (name: string) => {
    checked.push(name);
    return name;
  };
  const { send } = target;
  const run = randomUUID().slice(0, 8);
  const category = app.file.type.split("/")[0]!;

  // Two records of the app's own, through the presigned upload path.
  const makeRecord = async (n: number): Promise<string> => {
    const bytes = app.file.bytes();
    const contentHash = sha256Hex(bytes);
    const presign = ok(
      await send("POST", "/files/presign", {
        type: app.file.type,
        contentHash,
        contentType: app.file.contentType,
      }),
      route("POST /files/presign"),
    );
    await putPresigned(presign, bytes, app.file.contentType);
    const made = ok(
      await send("POST", "/data/records", {
        type: app.file.type,
        fileName: `sweep-${run}-${n}`,
        contentType: app.file.contentType,
        contentHash,
        sizeBytes: bytes.byteLength,
      }),
      route("POST /data/records"),
    );
    return (made["record"] as { id: string }).id;
  };
  const a = await makeRecord(1);
  const b = await makeRecord(2);
  assert.notEqual(a, b, "the two sweep records deduped into one; their bytes must differ");
  const both = JSON.stringify({ id: { in: [a, b] } });

  // The category's metadata table, a page of it and an aggregate.
  const rows = ok(
    await send("GET", `/data/metadata/${category}${q({ limit: 5 })}`),
    route("GET /data/metadata/:category"),
  );
  assert.ok(Array.isArray(rows["rows"]), "the metadata query answered no rows");
  const totals = ok(
    await send(
      "GET",
      `/data/metadata/${category}${q({ aggregate: JSON.stringify({ n: { fn: "count" } }) })}`,
    ),
    route("GET /data/metadata/:category?aggregate"),
  );
  assert.ok(Array.isArray(totals["groups"]), "the metadata aggregate answered no groups");

  // One record's metadata row, by category: the route a `%2F` broke.
  const one = ok(
    await send("GET", `/data/records/${a}/metadata/${category}`),
    route("GET /data/records/:id/metadata/:category"),
  );
  assert.ok("metadata" in one, "the record metadata route answered no metadata field");

  // Labels: a set of values, then counts per value.
  const tags = [`sweep-${run}-x`, `sweep-${run}-y`];
  ok(
    await send("POST", "/data/labels/values", {
      labels: [{ recordId: a, key: app.labelKey, values: tags }],
    }),
    route("POST /data/labels/values"),
  );
  const counts = ok(
    await send(
      "GET",
      `/data/labels${q({
        where: JSON.stringify({ app_id: app.appId, key: app.labelKey }),
        select: "value",
        aggregate: JSON.stringify({ n: { fn: "count" } }),
      })}`,
    ),
    route("GET /data/labels?where&select&aggregate"),
  );
  const groups = counts["groups"] as { value: string; n: number | string }[];
  for (const tag of tags) {
    assert.equal(Number(groups.find((g) => g.value === tag)?.n), 1, `no count for ${tag}`);
  }

  // Records: a count, an anti-join on the label, and two pages of one.
  const count = ok(
    await send(
      "GET",
      `/data/records${q({ where: both, aggregate: JSON.stringify({ n: { fn: "count" } }) })}`,
    ),
    route("GET /data/records?aggregate"),
  );
  assert.equal(Number((count["groups"] as { n: unknown }[])[0]?.n), 2);
  const untagged = ok(
    await send(
      "GET",
      `/data/records${q({ where: both, notLabel: `${app.appId}/${app.labelKey}` })}`,
    ),
    route("GET /data/records?notLabel"),
  );
  assert.deepEqual(
    (untagged["records"] as { id: string }[]).map((r) => r.id),
    [b],
  );
  const first = ok(
    await send("GET", `/data/records${q({ where: both, order: "created_at.asc", limit: 1 })}`),
    route("GET /data/records?limit"),
  );
  const cursor = first["nextCursor"];
  assert.equal(typeof cursor, "string", "one record of two answered no nextCursor");
  const second = ok(
    await send(
      "GET",
      `/data/records${q({ where: both, order: "created_at.asc", limit: 1, page_token: cursor as string })}`,
    ),
    route("GET /data/records?page_token"),
  );
  const paged = [
    ...(first["records"] as { id: string }[]),
    ...(second["records"] as { id: string }[]),
  ];
  assert.deepEqual(paged.map((r) => r.id).sort(), [a, b].sort());

  // A delete, the reconcile that finds it, and the restore that takes it back.
  const since = new Date(Date.now() - 60_000).toISOString();
  ok(await send("DELETE", `/data/records/${b}`), route("DELETE /data/records/:id"));
  const deleted = ok(
    await send("GET", `/data/records${q({ deleted: "only", updated_after: since, limit: 100 })}`),
    route("GET /data/records?deleted=only&updated_after"),
  );
  assert.ok(
    (deleted["records"] as { id: string }[]).some((r) => r.id === b),
    "the reconcile did not find the deleted record",
  );
  ok(await send("POST", `/data/records/${b}/restore`, {}), route("POST /data/records/:id/restore"));
  ok(await send("GET", `/data/records/${b}`), route("GET /data/records/:id"));

  // The trash window and the types the app reads.
  const trash = ok(await send("GET", "/data/trash"), route("GET /data/trash"));
  assert.ok("retention_days" in trash, "GET /data/trash answered no retention_days");
  const types = ok(await send("GET", "/data/types"), route("GET /data/types"));
  assert.ok(
    (types["types"] as { record_type: string }[]).some((t) => t.record_type === app.file.type),
    `GET /data/types did not list ${app.file.type}`,
  );

  // The app's own files: upload one, fetch it through the batch URL route.
  const fileBytes = Buffer.from(`route sweep ${run}\n`);
  const subKey = `sweep/${run}.txt`;
  const filePresign = ok(
    await send("POST", "/app-data/files/presign", {
      subKey,
      contentType: "text/plain",
      contentHash: sha256Hex(fileBytes),
    }),
    route("POST /app-data/files/presign"),
  );
  await putPresigned(filePresign, fileBytes, "text/plain");
  ok(
    await send("POST", `/app-data/files/${subKey}/record`, {
      contentHash: sha256Hex(fileBytes),
      mimeType: "text/plain",
      sizeBytes: fileBytes.byteLength,
      originalFilename: `${run}.txt`,
    }),
    route("POST /app-data/files/:subKey/record"),
  );
  const urls = ok(
    await send("POST", "/app-data/file-urls", { subKeys: [subKey] }),
    route("POST /app-data/file-urls"),
  )["urls"] as Record<string, string>;
  const served = await fetch(urls[subKey]!);
  assert.equal(await served.text(), fileBytes.toString(), "the batch URL served other bytes");
  ok(await send("DELETE", `/app-data/files/${subKey}`), route("DELETE /app-data/files/:subKey"));

  // Conditional row writes.
  const { name: table, keyColumn, valueColumn } = app.table;
  const key = `sweep-${run}`;
  const where = { [keyColumn]: key };
  const tablePath = `/app-data/db/${table}`;
  const seeded = ok(
    await send("POST", tablePath, {
      row: { [keyColumn]: key, [valueColumn]: "first" },
      ifAbsent: true,
    }),
    route("POST /app-data/db/:table ifAbsent"),
  );
  assert.equal(seeded["changes"], 1);
  const reseeded = ok(
    await send("POST", tablePath, {
      row: { [keyColumn]: key, [valueColumn]: "second" },
      ifAbsent: true,
    }),
    route("POST /app-data/db/:table ifAbsent, live"),
  );
  assert.equal(reseeded["skipped"], "live");
  const stampOf = async () => {
    const read = ok(
      await send(
        "GET",
        `${tablePath}${q({ where: JSON.stringify(where), select: `${valueColumn},updated_at` })}`,
      ),
      route("GET /app-data/db/:table?select"),
    );
    const row = (read["rows"] as Record<string, unknown>[])[0]!;
    return { value: row[valueColumn], stamp: String(row["updated_at"]) };
  };
  const read1 = await stampOf();
  assert.equal(read1.value, "first");
  ok(
    await send("PATCH", tablePath, { where, patch: { [valueColumn]: "changed" } }),
    route("PATCH /app-data/db/:table"),
  );
  const stale = await send("PATCH", tablePath, {
    where,
    patch: { [valueColumn]: "lost" },
    ifUpdatedAt: read1.stamp,
  });
  route("PATCH /app-data/db/:table ifUpdatedAt, stale");
  assert.equal(stale.status, 409, `a stale PATCH answered ${stale.status}`);
  assert.equal((stale.body as { skipped?: string }).skipped, "stale");
  const read2 = await stampOf();
  assert.equal(read2.value, "changed");
  const staleDelete = await send("DELETE", tablePath, { where, ifUpdatedAt: read1.stamp });
  route("DELETE /app-data/db/:table ifUpdatedAt, stale");
  assert.equal(staleDelete.status, 409, `a stale DELETE answered ${staleDelete.status}`);
  ok(
    await send("DELETE", tablePath, { where, ifUpdatedAt: read2.stamp }),
    route("DELETE /app-data/db/:table ifUpdatedAt"),
  );

  // Public links: an owner route on the cloud surface, and nowhere else.
  if (target.surface === "local") {
    const local = await send("GET", "/data/public-shares");
    route("GET /data/public-shares, local");
    assert.ok(local.status >= 400, `a computer with no cloud answered ${local.status}`);
  } else {
    const listed = ok(await send("GET", "/data/public-shares"), route("GET /data/public-shares"));
    assert.equal(listed["mayPublish"], app.publicSharing);
    if (app.publicSharing) {
      const made = ok(
        await send("POST", "/data/public-shares", {
          source: { kind: "record", recordId: a },
          title: `sweep ${run}`,
          lifetime: "7d",
        }),
        route("POST /data/public-shares"),
      );
      const share = made["publicShare"] as { id: string; linkToken: string };
      assert.equal(typeof share.linkToken, "string");
      const withShare = ok(
        await send("GET", "/data/public-shares"),
        route("GET /data/public-shares"),
      );
      assert.ok((withShare["publicShares"] as { id: string }[]).some((s) => s.id === share.id));
      ok(
        await send("DELETE", `/data/public-shares/${share.id}`),
        route("DELETE /data/public-shares/:id"),
      );
      const after = ok(await send("GET", "/data/public-shares"), route("GET /data/public-shares"));
      assert.ok(!(after["publicShares"] as { id: string }[]).some((s) => s.id === share.id));
    }
  }

  // Leave nothing behind but tombstones.
  ok(await send("DELETE", `/data/records/${a}`), route("DELETE /data/records/:id"));
  ok(await send("DELETE", `/data/records/${b}`), route("DELETE /data/records/:id"));
  return [...new Set(checked)];
}
