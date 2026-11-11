/**
 * The served build output: what the installer reads out of dist.zip, what it
 * refuses before any step runs, and how it keeps and prunes files in the app
 * assets bucket across deployments. S3 is an in-memory map.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { validateManifest, type AppManifest } from "@starkeep/admin-manifest";

const objects = new Map<string, { body: string; contentType?: string; cacheControl?: string }>();
const calls: string[] = [];
let missingBucket = false;
let refuseDeletes = false;

function s3Error(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetObjectCommand extends Command {}
  class PutObjectCommand extends Command {}
  class ListObjectsV2Command extends Command {}
  class DeleteObjectsCommand extends Command {}
  return {
    GetObjectCommand,
    PutObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
    S3Client: class {
      async send(cmd: Command) {
        const input = cmd.input as Record<string, any>;
        calls.push(cmd.constructor.name);
        if (missingBucket) throw s3Error("NoSuchBucket");
        if (cmd instanceof GetObjectCommand) {
          const obj = objects.get(input.Key);
          // What S3 may answer under install-infra's prefix-conditioned
          // ListBucket grant: 403, not NoSuchKey. The code must never rely on
          // a 404 for a missing key, so the fake does not offer one.
          if (!obj) throw s3Error("AccessDenied");
          return { Body: { transformToString: async () => obj.body } };
        }
        if (cmd instanceof PutObjectCommand) {
          const body = input.Body;
          objects.set(input.Key, {
            body: typeof body === "string" ? body : new TextDecoder().decode(body),
            contentType: input.ContentType,
            cacheControl: input.CacheControl,
          });
          return {};
        }
        if (cmd instanceof ListObjectsV2Command) {
          return {
            Contents: [...objects.keys()]
              .filter((k) => k.startsWith(input.Prefix))
              .map((Key) => ({ Key })),
            IsTruncated: false,
          };
        }
        if (cmd instanceof DeleteObjectsCommand) {
          const keys = (input.Delete.Objects as { Key: string }[]).map((o) => o.Key);
          if (refuseDeletes) {
            return { Errors: keys.map((Key) => ({ Key, Code: "AccessDenied", Message: "no" })) };
          }
          for (const key of keys) objects.delete(key);
          return {};
        }
        throw new Error(`unexpected command ${cmd.constructor.name}`);
      }
    },
  };
});

import {
  collectStaticAssets,
  deleteStaticAssets,
  MAX_LAMBDA_SERVED_FILE_BYTES,
  MissingAppAssetsBucketError,
  StaticAssetsError,
  uploadStaticAssets,
} from "../src/static-assets";

const creds = { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };
const BUCKET = "starkeep-app-assets-111122223333-us-east-1";

function manifest(handler: Record<string, unknown> = {}): AppManifest {
  const result = validateManifest({
    id: "dice",
    name: "Dice",
    version: "0.1.0",
    description: "A test app.",
    tier: "community",
    targets: ["cloud"],
    infraRequirements: {
      compute: {
        enabled: true,
        handlers: [
          {
            name: "static",
            handler: "index.handler",
            routes: ["GET /", "ANY /{proxy+}"],
            auth: "session",
            publicPaths: ["/", "/_immutable/*", "/_static/*", "/big.bin", "/sign-in"],
            staticAssetPaths: ["/_immutable/*", "/_static/*", "/big.bin"],
            assetsDir: "assets",
            ...handler,
          },
        ],
      },
    },
  });
  if (!result.manifest) throw new Error(result.errors.join("\n"));
  return result.manifest;
}

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        name,
        typeof body === "string" ? strToU8(body) : body,
      ]),
    ),
  );
}

beforeEach(() => {
  objects.clear();
  calls.length = 0;
  missingBucket = false;
  refuseDeletes = false;
  vi.stubGlobal("setTimeout", (fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  });
});

describe("collectStaticAssets", () => {
  it("reads only the two served prefixes, with the local responder's headers", () => {
    const assets = collectStaticAssets(
      manifest(),
      zip({
        "index.mjs": "export const handler = 1",
        "assets/index.html": "<html>",
        "assets/_immutable/app.3f2a.js": "js",
        "assets/_static/canvaskit.wasm": "wasm",
        "assets/_static/fonts/a.woff2": "font",
      }),
    );
    expect(assets.map((a) => [a.key, a.contentType, a.cacheControl])).toEqual([
      [
        "_immutable/app.3f2a.js",
        "application/javascript; charset=utf-8",
        "public, max-age=31536000, immutable",
      ],
      ["_static/canvaskit.wasm", "application/wasm", "public, max-age=0, must-revalidate"],
      ["_static/fonts/a.woff2", "font/woff2", "public, max-age=0, must-revalidate"],
    ]);
  });

  it("copies no file that staticAssetPaths does not declare", () => {
    // CloudFront serves the bucket to anyone, so an undeclared file would be
    // an anonymous path the manifest never named.
    const m = manifest({
      publicPaths: ["/", "/_immutable/*", "/_static/fonts/*", "/sign-in"],
      staticAssetPaths: ["/_immutable/*", "/_static/fonts/*"],
    });
    const assets = collectStaticAssets(
      m,
      zip({
        "assets/_immutable/app.js": "js",
        "assets/_static/fonts/a.woff2": "font",
        "assets/_static/private.json": "{}",
      }),
    );
    expect(assets.map((a) => a.key)).toEqual(["_immutable/app.js", "_static/fonts/a.woff2"]);
  });

  it("returns nothing for an app with no assetsDir", () => {
    const m = manifest({ staticAssetPaths: [], assetsDir: undefined });
    expect(collectStaticAssets(m, zip({ "index.mjs": "x" }))).toEqual([]);
  });

  it("refuses an assetsDir the zip does not contain", () => {
    expect(() => collectStaticAssets(manifest(), zip({ "index.mjs": "x" }))).toThrow(
      /has no files under assets\//,
    );
  });

  it("refuses a file the Lambda would have to serve past the response limit", () => {
    const big = new Uint8Array(MAX_LAMBDA_SERVED_FILE_BYTES + 1);
    expect(() =>
      collectStaticAssets(manifest(), zip({ "assets/big.bin": big, "assets/_static/a.js": "a" })),
    ).toThrow(StaticAssetsError);
    expect(() =>
      collectStaticAssets(manifest(), zip({ "assets/big.bin": big, "assets/_static/a.js": "a" })),
    ).toThrow(/assets\/big\.bin \(4\.0 MB\).*under _static\//);
  });

  it("lets a large file through when it is served from S3 or not served at all", () => {
    const big = new Uint8Array(MAX_LAMBDA_SERVED_FILE_BYTES + 1);
    const assets = collectStaticAssets(
      manifest(),
      zip({ "assets/_static/canvaskit.wasm": big, "assets/app.js.map": big }),
    );
    expect(assets.map((a) => a.key)).toEqual(["_static/canvaskit.wasm"]);
  });
});

describe("uploadStaticAssets", () => {
  const asset = (key: string) => ({
    key,
    body: strToU8(key),
    contentType: "text/plain",
    cacheControl: "public, max-age=0, must-revalidate",
  });
  const keys = () => [...objects.keys()].sort();

  it("puts each file under the app's prefix with its headers", async () => {
    await uploadStaticAssets("dice", BUCKET, [asset("_static/a.js")], "us-east-1", creds);
    expect(objects.get("apps/dice/_static/a.js")).toMatchObject({
      contentType: "text/plain",
      cacheControl: "public, max-age=0, must-revalidate",
    });
    expect(JSON.parse(objects.get("apps/dice/.deployments.json")!.body)).toEqual({
      current: ["_static/a.js"],
      previous: [],
    });
  });

  it("reads the deployment record only when the listing shows it", async () => {
    // First install: no record, so no GetObject. A blind read could cost a
    // 403 that the access-denied retry spends minutes on.
    await uploadStaticAssets("dice", BUCKET, [asset("_static/a.js")], "us-east-1", creds);
    expect(calls).not.toContain("GetObjectCommand");
    calls.length = 0;
    await uploadStaticAssets("dice", BUCKET, [asset("_static/b.js")], "us-east-1", creds);
    expect(calls.filter((c) => c === "GetObjectCommand")).toHaveLength(1);
    expect(JSON.parse(objects.get("apps/dice/.deployments.json")!.body)).toEqual({
      current: ["_static/b.js"],
      previous: ["_static/a.js"],
    });
  });

  it("keeps the previous deployment's files and prunes the one before", async () => {
    await uploadStaticAssets("dice", BUCKET, [asset("_immutable/v1.js")], "us-east-1", creds);
    await uploadStaticAssets("dice", BUCKET, [asset("_immutable/v2.js")], "us-east-1", creds);
    // An open tab from v1 can still load its chunk.
    expect(keys()).toEqual([
      "apps/dice/.deployments.json",
      "apps/dice/_immutable/v1.js",
      "apps/dice/_immutable/v2.js",
    ]);
    await uploadStaticAssets("dice", BUCKET, [asset("_immutable/v3.js")], "us-east-1", creds);
    expect(keys()).toEqual([
      "apps/dice/.deployments.json",
      "apps/dice/_immutable/v2.js",
      "apps/dice/_immutable/v3.js",
    ]);
  });

  it("keeps the previous deployment when the same bundle is uploaded again", async () => {
    // A rerun after a failed compute step: the Lambda may still serve v1's
    // shell, so v1's files must survive.
    await uploadStaticAssets("dice", BUCKET, [asset("_immutable/v1.js")], "us-east-1", creds);
    await uploadStaticAssets("dice", BUCKET, [asset("_immutable/v2.js")], "us-east-1", creds);
    await uploadStaticAssets("dice", BUCKET, [asset("_immutable/v2.js")], "us-east-1", creds);
    expect(keys()).toContain("apps/dice/_immutable/v1.js");
  });

  it("never touches another app's files", async () => {
    objects.set("apps/other/_static/x.js", { body: "x" });
    await uploadStaticAssets("dice", BUCKET, [asset("_static/a.js")], "us-east-1", creds);
    expect(keys()).toContain("apps/other/_static/x.js");
  });

  it("names the bootstrap update when the bucket is missing", async () => {
    missingBucket = true;
    await expect(
      uploadStaticAssets("dice", BUCKET, [asset("_static/a.js")], "us-east-1", creds),
    ).rejects.toThrow(/update the bootstrap stack/);
  });

  it("fails when S3 refuses a delete rather than reporting success", async () => {
    await uploadStaticAssets("dice", BUCKET, [asset("_immutable/v1.js")], "us-east-1", creds);
    await uploadStaticAssets("dice", BUCKET, [asset("_immutable/v2.js")], "us-east-1", creds);
    refuseDeletes = true;
    await expect(
      uploadStaticAssets("dice", BUCKET, [asset("_immutable/v3.js")], "us-east-1", creds),
    ).rejects.toThrow(/Could not delete 1 object/);
  });
});

describe("deleteStaticAssets", () => {
  it("removes everything under the app's prefix and nothing else", async () => {
    objects.set("apps/dice/_static/a.js", { body: "a" });
    objects.set("apps/dice/.deployments.json", { body: "{}" });
    objects.set("apps/other/_static/x.js", { body: "x" });
    await deleteStaticAssets("dice", BUCKET, "us-east-1", creds);
    expect([...objects.keys()]).toEqual(["apps/other/_static/x.js"]);
  });

  it("treats a missing bucket as nothing to delete", async () => {
    missingBucket = true;
    await expect(deleteStaticAssets("dice", BUCKET, "us-east-1", creds)).resolves.toBeUndefined();
    expect(new MissingAppAssetsBucketError(BUCKET).message).toMatch(/does not exist/);
  });
});
