// AI-734: drive the real S3ObjectStorageAdapter, built from packages/storage-s3,
// against a running AWS Emulator, and record every operation's outcome.
//
// Runs under plain Node 22+ (no tsx): the adapter is imported from its tsup
// build, packages/storage-s3/dist/index.js, by relative path. The package's own
// `workspace:*` dependency on @starkeep/storage-adapter rules out installing it
// into this standalone directory. The adapter's @aws-sdk imports resolve from
// packages/storage-s3/node_modules, i.e. the SDK versions the repo ships.
//
// The adapter is constructed with bucketName, region and keyPrefix only, so its
// S3Client takes credentials from the default chain (the emulator's credentials
// file) and its endpoint from AWS_ENDPOINT_URL; run.sh sets both.
//
// The spike's own @aws-sdk/client-s3 is used for setup (CreateBucket) and to read
// back what the adapter cannot report (object tags). It never stands in for an
// adapter method.
//
// Prints one JSON document on stdout for report.mjs.

import { createHash, randomBytes } from "node:crypto";
import {
  S3Client,
  CreateBucketCommand,
  GetObjectTaggingCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3ObjectStorageAdapter } from "../../../packages/storage-s3/dist/index.js";
import {
  compositeSha256Checksum,
  sha256HexToBase64,
} from "../../../packages/storage-adapter/dist/index.js";
import { guardEnvironment, describeError, Recorder } from "./lib.mjs";

const endpoint = guardEnvironment();
const region = "us-east-1";
const bucket = `spike-s3-ssm-${Date.now()}-${randomBytes(3).toString("hex")}`;
const keyPrefix = "spike-prefix/";
const rec = new Recorder("s3");

const setup = new S3Client({ endpoint, region, forcePathStyle: true });

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256B64 = (bytes) => createHash("sha256").update(bytes).digest("base64");
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const webStream = (bytes) =>
  new ReadableStream({
    start(c) {
      // Two chunks, so the adapter really streams rather than receiving one buffer.
      const mid = Math.floor(bytes.length / 2);
      c.enqueue(bytes.subarray(0, mid));
      c.enqueue(bytes.subarray(mid));
      c.close();
    },
  });
const readAll = async (stream) => Buffer.from(await new Response(stream).arrayBuffer());
// The same encoding the adapter uses for x-amz-tagging (encodeTagging in adapter.ts):
// the uploader has to send byte-identical header values to the ones that were signed.
const encodeTagging = (tags) =>
  Object.entries(tags)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

/** A presigned URL without its credential and signature, for the report. */
function showUrl(url) {
  const u = new URL(url);
  return `${u.origin}${u.pathname} SignedHeaders=${u.searchParams.get("X-Amz-SignedHeaders")}`;
}

async function tagsOf(key) {
  const res = await setup.send(
    new GetObjectTaggingCommand({ Bucket: bucket, Key: `${keyPrefix}${key}` }),
  );
  return Object.fromEntries((res.TagSet ?? []).map((t) => [t.Key, t.Value]));
}

function expectEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return a === e ? null : `${label}: got ${a}, AWS gives ${e}`;
}

/** A call AWS refuses: ok if it throws, "differs" if the emulator lets it through. */
async function refused(op, fn, awsSays) {
  return rec.op(
    op,
    async () => {
      try {
        const value = await fn();
        return { accepted: true, value };
      } catch (err) {
        return { accepted: false, error: describeError(err) };
      }
    },
    (r) => (r.accepted ? `accepted; AWS refuses with ${awsSays}` : null),
    (r) => `refused: ${r.error}`,
  );
}

/** Fetch a presigned URL; resolves to status, headers that matter and body. */
async function fetchUrl(url, init = {}) {
  const res = await fetch(url, init);
  const body = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    etag: res.headers.get("etag"),
    checksumSha256: res.headers.get("x-amz-checksum-sha256"),
    body,
    errorCode: res.ok ? null : (/<Code>([^<]+)<\/Code>/.exec(body.toString())?.[1] ?? null),
    errorMessage: res.ok
      ? null
      : (/<Message>([^<]+)<\/Message>/.exec(body.toString())?.[1] ?? null),
  };
}

const showFetch = (r) =>
  r.status < 300
    ? `HTTP ${r.status}`
    : `HTTP ${r.status} ${r.errorCode ?? ""}: ${r.errorMessage ?? r.body.toString().slice(0, 120)}`;

// Anything that throws outside rec.op (a presign used only as input to a later
// row, say) ends the run, but the rows recorded so far are still emitted.
try {
  await rec.op("setup: CreateBucket (spike client)", () =>
    setup.send(new CreateBucketCommand({ Bucket: bucket })).then(() => bucket),
  );

  const adapter = new S3ObjectStorageAdapter({ bucketName: bucket, region, keyPrefix });

  // ---- lifecycle ------------------------------------------------------------------
  await rec.op("init", () => adapter.init());
  await rec.op(
    "healthCheck",
    () => adapter.healthCheck(),
    (ok) => expectEqual("healthCheck", ok, true),
  );
  const missingBucket = new S3ObjectStorageAdapter({
    bucketName: `${bucket}-missing`,
    region,
    keyPrefix,
  });
  await rec.op(
    "healthCheck (bucket does not exist)",
    () => missingBucket.healthCheck(),
    (ok) => expectEqual("healthCheck", ok, false),
  );
  await missingBucket.close();

  // healthCheck created the adapter's S3Client. Observe CompleteMultipartUpload's
  // response (the adapter returns void) with a pass-through middleware on that same
  // client; it changes nothing about the request.
  const observed = {};
  adapter.client.middlewareStack.add(
    (next, context) => async (args) => {
      const out = await next(args);
      observed[context.commandName] = out.output;
      return out;
    },
    { step: "initialize", name: "spikeObserveOutput" },
  );

  // ---- put / putStream ----------------------------------------------------------
  const putBytes = randomBytes(64 * 1024);
  const putKey = "objects/put.bin";
  await rec.op("put (contentType, metadata, checksumSha256 set)", () =>
    adapter.put(putKey, putBytes, {
      contentType: "application/octet-stream",
      metadata: { origin: "spike" },
      checksumSha256: sha256B64(putBytes),
    }),
  );
  await rec.op("put (no checksum: adapter computes SHA-256)", () =>
    adapter.put("objects/put-computed.bin", putBytes),
  );
  await refused(
    "put (checksumSha256 does not match body)",
    () =>
      adapter.put("objects/put-bad.bin", putBytes, { checksumSha256: sha256B64(Buffer.from("x")) }),
    "400 BadDigest",
  );

  const streamBytes = randomBytes(200 * 1024);
  await rec.op("putStream (sizeBytes + expectedSha256Hex)", () =>
    adapter.putStream("objects/stream-known.bin", webStream(streamBytes), {
      contentType: "video/mp4",
      sizeBytes: streamBytes.length,
      expectedSha256Hex: sha256Hex(streamBytes),
    }),
  );
  await rec.op("putStream (sizeBytes, no hash: SDK trailing SHA-256)", () =>
    adapter.putStream("objects/stream-trailer.bin", webStream(streamBytes), {
      sizeBytes: streamBytes.length,
    }),
  );
  await rec.op("putStream (unknown length: spool, then put)", () =>
    adapter.putStream("objects/stream-spooled.bin", webStream(streamBytes), {
      expectedSha256Hex: sha256Hex(streamBytes),
    }),
  );
  await refused(
    "putStream (sizeBytes + wrong expectedSha256Hex)",
    () =>
      adapter.putStream("objects/stream-bad.bin", webStream(streamBytes), {
        sizeBytes: streamBytes.length,
        expectedSha256Hex: sha256Hex(Buffer.from("x")),
      }),
    "400 BadDigest",
  );

  // ---- reads ----------------------------------------------------------------------
  await rec.op(
    "get",
    () => adapter.get(putKey),
    (r) =>
      !r
        ? "returned null"
        : !sameBytes(r.data, putBytes)
          ? "bytes differ"
          : expectEqual("contentType", r.contentType, "application/octet-stream"),
  );
  await rec.op(
    "get (missing key)",
    () => adapter.get("objects/nope.bin"),
    (r) => expectEqual("get", r, null),
  );
  await rec.op(
    "getStream (range bytes=10-19)",
    async () => readAll(await adapter.getStream(putKey, { start: 10, end: 19 })),
    (b) =>
      sameBytes(b, putBytes.subarray(10, 20)) ? null : `got ${b.length} bytes, not bytes 10-19`,
  );
  await rec.op(
    "getStream (open-ended range bytes=65530-)",
    async () => readAll(await adapter.getStream(putKey, { start: 65530 })),
    (b) =>
      sameBytes(b, putBytes.subarray(65530)) ? null : `got ${b.length} bytes, not the last 6`,
  );
  await rec.op(
    "getStream (whole object, streamed upload)",
    async () => readAll(await adapter.getStream("objects/stream-trailer.bin")),
    (b) => (sameBytes(b, streamBytes) ? null : `got ${b.length} bytes that differ`),
  );
  await rec.op(
    "has",
    () => adapter.has(putKey),
    (r) => expectEqual("has", r, true),
  );
  await rec.op(
    "has (missing key)",
    () => adapter.has("objects/nope.bin"),
    (r) => expectEqual("has", r, false),
  );
  await rec.op(
    "stat (put object)",
    () => adapter.stat(putKey),
    (f) =>
      expectEqual(
        "stat",
        f && {
          sizeBytes: f.sizeBytes,
          checksumSha256: f.checksumSha256,
          storageClass: f.storageClass,
          availability: f.availability,
          contentType: f.contentType,
          metadata: f.metadata,
        },
        {
          sizeBytes: putBytes.length,
          checksumSha256: sha256B64(putBytes),
          storageClass: "STANDARD",
          availability: { state: "instant" },
          contentType: "application/octet-stream",
          metadata: { origin: "spike" },
        },
      ),
  );
  for (const key of ["objects/stream-trailer.bin", "objects/stream-spooled.bin"]) {
    await rec.op(
      `stat (${key.split("/")[1]}: whole-object checksum stored)`,
      () => adapter.stat(key),
      (f) => expectEqual("checksumSha256", f?.checksumSha256, sha256B64(streamBytes)),
    );
  }
  await rec.op(
    "stat (missing key)",
    () => adapter.stat("objects/nope.bin"),
    (r) => expectEqual("stat", r, null),
  );

  // ---- tags -------------------------------------------------------------------------
  const tags = { "starkeep:intent": "keep", app: "spike" };
  await rec.op(
    "setTags (+ GetObjectTagging read-back)",
    async () => {
      await adapter.setTags(putKey, tags);
      return tagsOf(putKey);
    },
    (t) => expectEqual("tags", t, tags),
  );

  // ---- list ---------------------------------------------------------------------
  for (const n of [1, 2, 3]) await adapter.put(`list/item-${n}.txt`, Buffer.from(`item ${n}`));
  const page1 = await rec.op(
    "list (prefix list/, limit 2)",
    () => adapter.list("list/", { limit: 2 }),
    (r) =>
      expectEqual(
        "page 1",
        { keys: r.keys, hasMore: r.hasMore, cursor: typeof r.nextCursor },
        { keys: ["list/item-1.txt", "list/item-2.txt"], hasMore: true, cursor: "string" },
      ),
  );
  await rec.op(
    "list (page 2 via cursor)",
    () => adapter.list("list/", { limit: 2, cursor: page1?.nextCursor ?? undefined }),
    (r) =>
      expectEqual(
        "page 2",
        { keys: r.keys, hasMore: r.hasMore, nextCursor: r.nextCursor },
        { keys: ["list/item-3.txt"], hasMore: false, nextCursor: null },
      ),
  );

  // ---- delete -------------------------------------------------------------------
  await rec.op(
    "delete (+ has afterwards)",
    async () => {
      await adapter.delete("list/item-3.txt");
      return adapter.has("list/item-3.txt");
    },
    (present) => expectEqual("has after delete", present, false),
  );
  await rec.op("delete (missing key: S3 answers 204)", () => adapter.delete("objects/never.bin"));

  // ---- presigned GET ----------------------------------------------------------------
  const getUrl = await rec.op(
    "getSignedUrl",
    () => adapter.getSignedUrl(putKey),
    () => null,
    showUrl,
  );
  if (getUrl) {
    await rec.op(
      "presigned GET (fetch)",
      () => fetchUrl(getUrl),
      (r) =>
        r.status !== 200 ? showFetch(r) : sameBytes(r.body, putBytes) ? null : "bytes differ",
      showFetch,
    );
  }
  const shortUrl = await adapter.getSignedUrl(putKey, { expiresIn: 1 });
  await new Promise((r) => setTimeout(r, 2100));
  await rec.op(
    "presigned GET, expired (expiresIn 1, fetched after 2 s)",
    () => fetchUrl(shortUrl),
    (r) =>
      r.status === 403 ? null : `HTTP ${r.status}; AWS refuses with 403 AccessDenied (expired)`,
    showFetch,
  );

  // ---- presigned PUT --------------------------------------------------------------
  const signedPutBytes = randomBytes(32 * 1024);
  const putTags = { "starkeep:intent": "keep" };
  const signedPutKey = "objects/signed-put.bin";
  const signedHeaders = (bytes, storageClass) => ({
    "content-type": "image/jpeg",
    "x-amz-checksum-sha256": sha256B64(bytes),
    "x-amz-storage-class": storageClass,
    "x-amz-tagging": encodeTagging(putTags),
  });
  const signedPut = (key, bytes, storageClass) =>
    adapter.getSignedPutUrl(key, {
      contentType: "image/jpeg",
      checksumSha256: sha256B64(bytes),
      storageClass,
      tagging: putTags,
    });

  const putUrl = await rec.op(
    "getSignedPutUrl (checksum, storage class, tagging)",
    () => signedPut(signedPutKey, signedPutBytes, "INTELLIGENT_TIERING"),
    () => null,
    showUrl,
  );
  if (putUrl) {
    await rec.op(
      "presigned PUT (fetch with the signed headers)",
      () =>
        fetchUrl(putUrl, {
          method: "PUT",
          headers: signedHeaders(signedPutBytes, "INTELLIGENT_TIERING"),
          body: signedPutBytes,
        }),
      (r) => (r.status === 200 ? null : showFetch(r)),
      (r) => `${showFetch(r)}, x-amz-checksum-sha256 ${r.checksumSha256 ? "echoed" : "absent"}`,
    );
    await rec.op(
      "presigned PUT read-back (get + stat + tags)",
      async () => ({
        got: await adapter.get(signedPutKey),
        facts: await adapter.stat(signedPutKey),
        tags: await tagsOf(signedPutKey),
      }),
      ({ got, facts, tags: t }) =>
        !got || !sameBytes(got.data, signedPutBytes)
          ? "bytes differ or missing"
          : expectEqual(
              "read-back",
              {
                contentType: got.contentType,
                checksum: facts?.checksumSha256,
                storageClass: facts?.storageClass,
                tags: t,
              },
              {
                contentType: "image/jpeg",
                checksum: sha256B64(signedPutBytes),
                storageClass: "INTELLIGENT_TIERING",
                tags: putTags,
              },
            ),
    );
  }
  // Negative checks: what the signature is supposed to forbid.
  const badBodyUrl = await signedPut("objects/signed-bad-body.bin", signedPutBytes, "STANDARD");
  await rec.op(
    "presigned PUT, body does not match signed checksum",
    () =>
      fetchUrl(badBodyUrl, {
        method: "PUT",
        headers: signedHeaders(signedPutBytes, "STANDARD"),
        body: randomBytes(signedPutBytes.length),
      }),
    (r) => (r.status >= 400 ? null : `HTTP ${r.status}; AWS refuses with 400 BadDigest`),
    showFetch,
  );
  const droppedUrl = await signedPut("objects/signed-dropped.bin", signedPutBytes, "GLACIER");
  await rec.op(
    "presigned PUT, signed x-amz-storage-class header dropped",
    () => {
      const headers = signedHeaders(signedPutBytes, "GLACIER");
      delete headers["x-amz-storage-class"];
      return fetchUrl(droppedUrl, { method: "PUT", headers, body: signedPutBytes });
    },
    (r) =>
      r.status === 403 ? null : `HTTP ${r.status}; AWS refuses with 403 SignatureDoesNotMatch`,
    showFetch,
  );
  await rec.op(
    "presigned PUT, x-amz-storage-class changed from the signed value",
    () =>
      fetchUrl(droppedUrl, {
        method: "PUT",
        headers: signedHeaders(signedPutBytes, "STANDARD"),
        body: signedPutBytes,
      }),
    (r) =>
      r.status === 403 ? null : `HTTP ${r.status}; AWS refuses with 403 SignatureDoesNotMatch`,
    showFetch,
  );

  // Control, not an adapter call: presign the way adapter.ts warns against
  // (signableHeaders without unhoistableHeaders), so the x-amz-* values are hoisted
  // into the query and SignedHeaders=host, then send them as headers. AWS answers
  // 403 AccessDenied "There were headers present in the request which were not
  // signed". Says whether an emulator job would catch that regression.
  const hoisted = new Set(["x-amz-checksum-sha256", "x-amz-storage-class", "x-amz-tagging"]);
  const hoistedUrl = await getSignedUrl(
    setup,
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${keyPrefix}objects/signed-hoisted.bin`,
      ContentType: "image/jpeg",
      ChecksumSHA256: sha256B64(signedPutBytes),
      StorageClass: "STANDARD",
      Tagging: encodeTagging(putTags),
    }),
    { expiresIn: 3600, signableHeaders: hoisted },
  );
  await rec.op(
    "control: presigned PUT with headers hoisted (the bug adapter.ts documents)",
    () =>
      fetchUrl(hoistedUrl, {
        method: "PUT",
        headers: signedHeaders(signedPutBytes, "STANDARD"),
        body: signedPutBytes,
      }),
    (r) =>
      r.status === 403
        ? null
        : `HTTP ${r.status}; AWS refuses with 403 AccessDenied (headers present which were not signed)`,
    (r) => `${showFetch(r)} [${showUrl(hoistedUrl)}]`,
  );

  // ---- archive tier and restoreObject ---------------------------------------------
  // PutOptions has no storage class, so an archived object can only come from a
  // presigned PUT (or a multipart upload): the same path a device uses.
  const archivedKey = "objects/archived.bin";
  const archivedUrl = await signedPut(archivedKey, signedPutBytes, "DEEP_ARCHIVE");
  await rec.op(
    "presigned PUT (storage class DEEP_ARCHIVE)",
    () =>
      fetchUrl(archivedUrl, {
        method: "PUT",
        headers: signedHeaders(signedPutBytes, "DEEP_ARCHIVE"),
        body: signedPutBytes,
      }),
    (r) => (r.status === 200 ? null : showFetch(r)),
    (r) => `${showFetch(r)}, x-amz-checksum-sha256 ${r.checksumSha256 ? "echoed" : "absent"}`,
  );
  await rec.op(
    "stat (DEEP_ARCHIVE object)",
    () => adapter.stat(archivedKey),
    (f) =>
      expectEqual("stat", f && { storageClass: f.storageClass, availability: f.availability }, {
        storageClass: "DEEP_ARCHIVE",
        availability: { state: "archived", tier: "DEEP_ARCHIVE", expectedLatencyHours: 12 },
      }),
  );
  await rec.op(
    "get (DEEP_ARCHIVE object, not restored)",
    () => adapter.get(archivedKey),
    // AWS answers 403 InvalidObjectState, which the adapter's 403 branch maps to null.
    (r) =>
      r === null ? null : "returned the bytes; AWS answers 403 InvalidObjectState (adapter: null)",
    (r) => (r === null ? "null" : `${r.data.length} bytes`),
  );
  await rec.op(
    "restoreObject (Standard, 1 day)",
    () => adapter.restoreObject(archivedKey, { tier: "Standard", days: 1 }),
    (r) => expectEqual("restoreObject", r, "started"),
  );
  await rec.op(
    "restoreObject (again, while in progress)",
    () => adapter.restoreObject(archivedKey, { tier: "Standard", days: 1 }),
    (r) => expectEqual("restoreObject", r, "already-in-progress"),
  );
  await rec.op(
    "stat (DEEP_ARCHIVE object after restore request)",
    () => adapter.stat(archivedKey),
    (f) => expectEqual("availability", f?.availability, { state: "restoring", readyAt: null }),
  );
  await refused(
    "restoreObject (STANDARD object)",
    () => adapter.restoreObject(putKey, { tier: "Standard", days: 1 }),
    "403 InvalidObjectState",
  );

  // ---- multipart ------------------------------------------------------------------
  // Two parts: 5 MiB (S3's minimum for a non-final part) and 1 KiB.
  const parts = [randomBytes(5 * 1024 * 1024), randomBytes(1024)];
  const mpKey = "objects/multipart.bin";
  const mpTags = { "starkeep:intent": "keep" };
  const uploadId = await rec.op(
    "createMultipartUpload (contentType, storage class, tagging)",
    () =>
      adapter.createMultipartUpload(mpKey, {
        contentType: "video/mp4",
        storageClass: "INTELLIGENT_TIERING",
        tagging: mpTags,
      }),
    (id) => (typeof id === "string" && id.length > 0 ? null : "no upload id"),
    () => "upload id returned",
  );
  const completed = [];
  if (uploadId) {
    for (const [i, bytes] of parts.entries()) {
      const partNumber = i + 1;
      const url = await rec.op(
        `getSignedUploadPartUrl (part ${partNumber})`,
        () =>
          adapter.getSignedUploadPartUrl(mpKey, uploadId, partNumber, {
            checksumSha256: sha256HexToBase64(sha256Hex(bytes)),
          }),
        () => null,
        showUrl,
      );
      if (!url) continue;
      const res = await rec.op(
        `presigned UploadPart (part ${partNumber}, ${bytes.length} B, fetch)`,
        () =>
          fetchUrl(url, {
            method: "PUT",
            headers: { "x-amz-checksum-sha256": sha256B64(bytes) },
            body: bytes,
          }),
        (r) =>
          r.status !== 200
            ? showFetch(r)
            : !r.etag
              ? "no ETag in the response"
              : r.checksumSha256 !== sha256B64(bytes)
                ? `response x-amz-checksum-sha256 is ${JSON.stringify(r.checksumSha256)}; AWS echoes the part's checksum`
                : null,
        (r) =>
          `HTTP ${r.status}, ETag ${r.etag ? "present" : "absent"}, x-amz-checksum-sha256 echoed`,
      );
      if (res?.status === 200 && res.etag) {
        completed.push({ partNumber, etag: res.etag, checksumSha256: sha256B64(bytes) });
      }
    }
    const badPartUrl = await adapter.getSignedUploadPartUrl(mpKey, uploadId, 3, {
      checksumSha256: sha256B64(parts[1]),
    });
    await rec.op(
      "presigned UploadPart, body does not match signed checksum",
      () =>
        fetchUrl(badPartUrl, {
          method: "PUT",
          headers: { "x-amz-checksum-sha256": sha256B64(parts[1]) },
          body: randomBytes(parts[1].length),
        }),
      (r) => (r.status >= 400 ? null : `HTTP ${r.status}; AWS refuses with 400 BadDigest`),
      showFetch,
    );
    await rec.op(
      "completeMultipartUpload",
      () => adapter.completeMultipartUpload(mpKey, uploadId, completed),
      () => {
        const location = observed.CompleteMultipartUploadCommand?.Location;
        return location && new URL(location).host.endsWith("amazonaws.com")
          ? `response Location is ${location} (real AWS host, not the emulator)`
          : null;
      },
      () => `Location ${observed.CompleteMultipartUploadCommand?.Location}`,
    );
    const composite = compositeSha256Checksum(parts.map(sha256Hex));
    await rec.op(
      "multipart read-back (stat composite checksum + get + tags)",
      async () => ({
        facts: await adapter.stat(mpKey),
        got: await adapter.get(mpKey),
        tags: await tagsOf(mpKey),
      }),
      ({ facts, got, tags: t }) =>
        !got || !sameBytes(got.data, Buffer.concat(parts))
          ? "bytes differ or missing"
          : expectEqual(
              "read-back",
              {
                checksum: facts?.checksumSha256,
                storageClass: facts?.storageClass,
                contentType: got.contentType,
                tags: t,
              },
              {
                checksum: composite,
                storageClass: "INTELLIGENT_TIERING",
                contentType: "video/mp4",
                tags: mpTags,
              },
            ),
    );
  }

  await rec.op("close", () => adapter.close());
} catch (err) {
  rec.aborted(err);
} finally {
  rec.emit({ bucket });
}
