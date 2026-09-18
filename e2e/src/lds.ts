/**
 * Direct local-data-server access for e2e assertions that go underneath the
 * UIs — creating shared records as Drive for the Drive smoke test, or
 * checking what survived an uninstall. Mirrors the Tier-1 suite's helpers but
 * keyed off a URL, so starkeep-apps suites can use it against a harness-booted
 * stack without importing core test files.
 */

import { createHash } from "node:crypto";
import { signedFetch, type AppCredentials } from "@starkeep/app-client";

export interface LdsApp extends AppCredentials {
  fetch(path: string, init?: Parameters<typeof signedFetch>[2]): Promise<Response>;
}

/**
 * Install an app straight into the LDS (loopback /admin route) and return its
 * credentials. Re-posting an active app's manifest is the supported way to
 * recover an existing secret, so this also serves as `builtinAppCreds`.
 */
export async function installAppDirect(
  ldsUrl: string,
  manifest: Record<string, unknown>,
): Promise<LdsApp> {
  const res = await fetch(`${ldsUrl}/admin/apps/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });
  if (!res.ok) {
    throw new Error(`install failed: ${res.status} ${await res.text()}`);
  }
  const { appId, hmacSecret } = (await res.json()) as {
    appId: string;
    hmacSecret: string;
  };
  const creds: AppCredentials = { appId, hmacSecret, dataServerUrl: ldsUrl };
  return { ...creds, fetch: (path, init) => signedFetch(creds, path, init) };
}

/** Drive's identity (all-access). Built in at LDS boot; this recovers its secret. */
export async function driveCreds(ldsUrl: string): Promise<LdsApp> {
  return installAppDirect(ldsUrl, {
    id: "starkeep-drive",
    name: "Drive",
    version: "1.0.0",
    tier: "official",
    infraRequirements: { fileAccessAll: true },
  });
}

/** Upload bytes and register a shared record for them. */
export async function createRecordWithBytes(
  app: LdsApp,
  options: {
    type?: string;
    bytes: Buffer;
    fileName?: string;
    contentType?: string;
    parentId?: string;
  },
): Promise<{ record: { id: string; [k: string]: unknown }; deduped?: boolean }> {
  const type = options.type ?? "image/png";
  const contentType = options.contentType ?? "image/png";

  const upload = await app.fetch(`/data/files?type=${type}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: options.bytes,
  });
  if (!upload.ok) {
    throw new Error(`upload failed: ${upload.status} ${await upload.text()}`);
  }
  const { contentHash, sizeBytes } = (await upload.json()) as {
    contentHash: string;
    sizeBytes: number;
  };

  const register = await app.fetch("/data/records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type,
      contentType,
      contentHash,
      sizeBytes,
      fileName: options.fileName,
      parentId: options.parentId,
    }),
  });
  if (!register.ok) {
    throw new Error(`register failed: ${register.status} ${await register.text()}`);
  }
  return (await register.json()) as { record: { id: string }; deduped?: boolean };
}

/**
 * Write an app-private file through the only supported path: presign, upload
 * to the returned URL, register the index row. Returns the stored key.
 *
 * Here rather than in each suite because the three-step shape is the platform's
 * and an app testing what survives a removal should not have to restate it.
 */
export async function putAppFile(
  app: LdsApp,
  subKey: string,
  bytes: Buffer | string,
  mimeType = "application/octet-stream",
): Promise<{ key: string }> {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  const presign = await app.fetch("/app-data/files/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subKey, contentType: mimeType }),
  });
  if (!presign.ok) throw new Error(`presign failed: ${presign.status} ${await presign.text()}`);
  const { url } = (await presign.json()) as { url: string };

  const uploaded = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: body as unknown as BodyInit,
  });
  if (!uploaded.ok) throw new Error(`upload failed: ${uploaded.status}`);

  const register = await app.fetch(`/app-data/files/${subKey}/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contentHash: createHash("sha256")
        .update(body as unknown as Uint8Array)
        .digest("hex"),
      mimeType,
      sizeBytes: body.length,
    }),
  });
  if (!register.ok) throw new Error(`register failed: ${register.status} ${await register.text()}`);
  return (await register.json()) as { key: string };
}

/**
 * Read an app-private file's bytes back, or null when the app has no such file.
 *
 * `null` rather than a throw for the 404, because "is it still there" is the
 * question a removal test asks and both answers are results.
 */
export async function readAppFile(app: LdsApp, subKey: string): Promise<string | null> {
  const res = await app.fetch(`/app-data/files/${subKey}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`app-file resolve failed: ${res.status}`);
  const { url } = (await res.json()) as { url: string };
  const bytes = await fetch(url);
  if (!bytes.ok) throw new Error(`app-file fetch failed: ${bytes.status}`);
  return bytes.text();
}

export async function listRecords(
  app: LdsApp,
  query = "",
): Promise<Array<{ id: string; type: string; [k: string]: unknown }>> {
  const res = await app.fetch(`/data/records${query}`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const body = (await res.json()) as {
    records: Array<{ id: string; type: string }>;
  };
  return body.records;
}
