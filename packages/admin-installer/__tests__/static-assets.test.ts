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
  folderRedirectPage,
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
            bundleAssetsDir: "assets",
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

  it("returns nothing for an app with no bundleAssetsDir", () => {
    const m = manifest({
      publicPaths: ["/", "/_immutable/*", "/_static/*", "/sign-in"],
      staticAssetPaths: [],
      bundleAssetsDir: undefined,
    });
    expect(collectStaticAssets(m, zip({ "index.mjs": "x" }))).toEqual([]);
  });

  it("refuses a bundleAssetsDir the zip does not contain", () => {
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

  it("refuses a zip entry that is not a plain relative path", () => {
    // Each would be a key CloudFront could never serve, under a public prefix.
    for (const name of [
      "assets/_static/../x.js",
      "assets/_static//a.js",
      "assets/_static/./a.js",
    ]) {
      expect(() => collectStaticAssets(manifest(), zip({ [name]: "x" })), name).toThrow(
        /is not a plain relative path/,
      );
    }
  });

  it("refuses two handlers whose bundleAssetsDir hold the same served file", () => {
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
              publicPaths: ["/", "/_static/*", "/sign-in"],
              staticAssetPaths: ["/_static/*"],
              bundleAssetsDir: "assets",
            },
            {
              name: "admin",
              handler: "admin.handler",
              routes: ["GET /admin/{proxy+}"],
              auth: "session",
              publicPaths: ["/_static/*"],
              staticAssetPaths: ["/_static/*"],
              bundleAssetsDir: "admin-assets",
            },
          ],
        },
      },
    });
    if (!result.manifest) throw new Error(result.errors.join("\n"));
    expect(() =>
      collectStaticAssets(
        result.manifest!,
        zip({ "assets/_static/a.js": "a", "admin-assets/_static/a.js": "b" }),
      ),
    ).toThrow(/Two handlers' bundleAssetsDir both hold _static\/a\.js/);
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

describe("collectStaticAssets: public site", () => {
  function siteManifest(over: Record<string, unknown> = {}): AppManifest {
    const result = validateManifest({
      id: "blog",
      name: "Blog",
      version: "0.1.0",
      tier: "community",
      targets: ["cloud"],
      infraRequirements: { publicSite: { bundleDir: "site" }, ...over },
    });
    if (!result.manifest) throw new Error(result.errors.join("\n"));
    return result.manifest;
  }

  it("copies every file in the site's folder under _site/, revalidated on each load", () => {
    const assets = collectStaticAssets(
      siteManifest(),
      zip({
        "site/index.html": "<html>",
        "site/about/index.html": "<html>",
        "site/img/cat.png": "png",
        "README.md": "not served",
      }),
    );
    expect(assets.map((a) => [a.key, a.contentType, a.cacheControl])).toEqual([
      // The page at the folder's bare name, which moves the browser to about/.
      ["_site/about", "text/html; charset=utf-8", "public, max-age=0, must-revalidate"],
      ["_site/about/index.html", "text/html; charset=utf-8", "public, max-age=0, must-revalidate"],
      ["_site/img/cat.png", "image/png", "public, max-age=0, must-revalidate"],
      ["_site/index.html", "text/html; charset=utf-8", "public, max-age=0, must-revalidate"],
    ]);
  });

  // SITES-003
  it("writes a page at each folder's bare name that moves the browser inside the folder", () => {
    const assets = collectStaticAssets(
      siteManifest(),
      zip({
        "site/index.html": "<html>",
        "site/docs/v1.2/index.html": "<html>",
        "site/img/cat.png": "png",
      }),
    );
    // A folder with an index.html gets a page; one without (img/) does not,
    // because its slashed spelling would answer 404 anyway.
    expect(assets.map((a) => a.key)).toEqual([
      "_site/docs/v1.2",
      "_site/docs/v1.2/index.html",
      "_site/img/cat.png",
      "_site/index.html",
    ]);
    const page = new TextDecoder().decode(assets[0]!.body);
    expect(page).toBe(folderRedirectPage("v1.2"));
    // Relative to /sites/<appId>/docs/v1.2, "v1.2/" is the folder itself.
    expect(page).toContain('location.replace("v1.2/" + location.search + location.hash)');
    expect(page).toContain('<meta http-equiv="refresh" content="0; url=v1.2/">');
  });

  it("escapes a folder name before it reaches the page", () => {
    expect(folderRedirectPage('a"<b')).toContain('"a%22%3Cb/"');
    expect(folderRedirectPage('a"<b')).not.toContain('a"<b');
  });

  it("keeps a file that shares its name with a folder, rather than the folder's page", () => {
    // A zip's entry names are free text, so it can hold both.
    const assets = collectStaticAssets(
      siteManifest(),
      zip({ "site/index.html": "<html>", "site/about": "file", "site/about/index.html": "<html>" }),
    );
    const about = assets.find((a) => a.key === "_site/about")!;
    expect(new TextDecoder().decode(about.body)).toBe("file");
  });

  // SITES-020
  it("serves a file whose name has no extension as itself", () => {
    const assets = collectStaticAssets(
      siteManifest(),
      zip({ "site/index.html": "<html>", "site/assets/NOTICES": "licenses" }),
    );
    expect(assets.map((a) => a.key)).toEqual(["_site/assets/NOTICES", "_site/index.html"]);
  });

  it("serves a large site file from S3, with no Lambda size limit", () => {
    const big = new Uint8Array(MAX_LAMBDA_SERVED_FILE_BYTES + 1);
    const assets = collectStaticAssets(
      siteManifest(),
      zip({ "site/index.html": "<html>", "site/video.mp4": big }),
    );
    expect(assets.map((a) => a.key)).toEqual(["_site/index.html", "_site/video.mp4"]);
  });

  it("collects a site beside a handler's build output", () => {
    const m = manifest();
    m.infraRequirements.publicSite = { bundleDir: "site" };
    const assets = collectStaticAssets(
      m,
      zip({
        "assets/_immutable/app.js": "js",
        "site/index.html": "<html>",
      }),
    );
    expect(assets.map((a) => a.key)).toEqual(["_immutable/app.js", "_site/index.html"]);
  });

  // SITES-017
  it("refuses a bundle without the site's folder", () => {
    expect(() => collectStaticAssets(siteManifest(), zip({ "other/index.html": "x" }))).toThrow(
      /declares a public site in "site", but dist.zip has no files under site\//,
    );
  });

  // SITES-017
  it("refuses a site without index.html", () => {
    expect(() =>
      collectStaticAssets(siteManifest(), zip({ "site/about/index.html": "x" })),
    ).toThrow(StaticAssetsError);
    expect(() =>
      collectStaticAssets(siteManifest(), zip({ "site/about/index.html": "x" })),
    ).toThrow(/has no index.html/);
  });

  it("refuses a site file that is not a plain relative path", () => {
    expect(() =>
      collectStaticAssets(siteManifest(), zip({ "site/index.html": "x", "site/a//b.html": "x" })),
    ).toThrow(/not a plain relative path/);
  });
});

describe("uploadStaticAssets", () => {
  const asset = (key: string, body = key) => ({
    key,
    body: strToU8(body),
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
    expect(JSON.parse(objects.get("apps/dice/.deployments.json")!.body)).toMatchObject({
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
    expect(JSON.parse(objects.get("apps/dice/.deployments.json")!.body)).toMatchObject({
      current: ["_static/b.js"],
      previous: ["_static/a.js"],
    });
  });

  // SITES-011
  it("drops a site page the new deployment removed at once, unlike build files", async () => {
    await uploadStaticAssets(
      "dice",
      BUCKET,
      [asset("_immutable/v1.js"), asset("_site/index.html"), asset("_site/old.html")],
      "us-east-1",
      creds,
    );
    await uploadStaticAssets(
      "dice",
      BUCKET,
      [asset("_immutable/v2.js"), asset("_site/index.html")],
      "us-east-1",
      creds,
    );
    expect(keys()).toEqual([
      "apps/dice/.deployments.json",
      "apps/dice/_immutable/v1.js",
      "apps/dice/_immutable/v2.js",
      "apps/dice/_site/index.html",
    ]);
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

  it("treats new bytes under the same names as a new deployment", async () => {
    // A /_static/ file keeps its name across builds. Comparing names alone
    // read v3 as a rerun of v2 and kept v1's files forever.
    await uploadStaticAssets("dice", BUCKET, [asset("_immutable/v1.js")], "us-east-1", creds);
    await uploadStaticAssets("dice", BUCKET, [asset("_static/a.js", "v2")], "us-east-1", creds);
    await uploadStaticAssets("dice", BUCKET, [asset("_static/a.js", "v3")], "us-east-1", creds);
    expect(keys()).toEqual(["apps/dice/.deployments.json", "apps/dice/_static/a.js"]);
    expect(objects.get("apps/dice/_static/a.js")!.body).toBe("v3");
  });

  it("reads a record without a hash as a new deployment, not a rerun", async () => {
    // The record's shape before currentHash existed.
    objects.set("apps/dice/.deployments.json", {
      body: JSON.stringify({ current: ["_immutable/v2.js"], previous: ["_immutable/v1.js"] }),
    });
    objects.set("apps/dice/_immutable/v1.js", { body: "v1" });
    objects.set("apps/dice/_immutable/v2.js", { body: "v2" });
    await uploadStaticAssets("dice", BUCKET, [asset("_immutable/v2.js")], "us-east-1", creds);
    expect(keys()).toEqual(["apps/dice/.deployments.json", "apps/dice/_immutable/v2.js"]);
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
