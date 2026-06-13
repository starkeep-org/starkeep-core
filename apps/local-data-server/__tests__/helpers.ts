/**
 * Shared helpers for the Tier-1 local-data-server suite. Each test file boots
 * its own real server process (via @starkeep/testkit) and talks to it over
 * HTTP exactly like an installed app: HMAC-signed requests through
 * @starkeep/app-client, with /admin/* used loopback-style like admin-web.
 */
import { signedFetch, type AppCredentials } from "@starkeep/app-client";
import type { LocalDataServer } from "@starkeep/testkit";

/** Manifest for a full-featured test app: readwrite images + app-data. */
export function testAppManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "testapp",
    name: "Test App",
    version: "1.0.0",
    tier: "community",
    infraRequirements: {
      fileAccess: [
        {
          extensions: ["jpg", "png"],
          access: "readwrite",
          metadataWrite: true,
          rationale: "test",
        },
      ],
      appSpecificSyncable: {
        files: true,
        tables: [
          {
            name: "notes",
            columns: [
              { name: "note_id", type: "text", primaryKey: true, notNull: true },
              { name: "body", type: "text" },
            ],
          },
        ],
      },
    },
    ...over,
  };
}

/** Manifest for a read-only app (pdf only, no app data). */
export function readOnlyAppManifest(): Record<string, unknown> {
  return {
    id: "readonly-app",
    name: "Read Only",
    version: "1.0.0",
    tier: "community",
    infraRequirements: {
      fileAccess: [
        { extensions: ["pdf"], access: "read", metadataWrite: false, rationale: "test" },
      ],
    },
  };
}

export interface InstalledApp extends AppCredentials {
  /** signedFetch bound to these creds. */
  fetch(path: string, init?: Parameters<typeof signedFetch>[2]): Promise<Response>;
}

export async function installApp(
  server: LocalDataServer,
  manifest: Record<string, unknown>,
): Promise<InstalledApp> {
  const res = await fetch(`${server.url}/admin/apps/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });
  if (!res.ok) {
    throw new Error(`install failed: ${res.status} ${await res.text()}`);
  }
  const { appId, hmacSecret } = (await res.json()) as { appId: string; hmacSecret: string };
  const creds: AppCredentials = { appId, hmacSecret, dataServerUrl: server.url };
  return {
    ...creds,
    fetch: (path, init) => signedFetch(creds, path, init),
  };
}

/**
 * Recover a built-in app's credentials. installLocal returns the existing
 * secret for an active app, so re-posting a minimal manifest with the
 * built-in's id is the supported way to obtain its identity.
 */
export async function builtinAppCreds(
  server: LocalDataServer,
  appId: "starkeep-drive" | "local-watcher",
): Promise<InstalledApp> {
  const manifest =
    appId === "starkeep-drive"
      ? {
          id: appId,
          name: "Drive",
          version: "1.0.0",
          tier: "official",
          infraRequirements: { fileAccessAll: true },
        }
      : { id: appId, name: "Watcher", version: "1.0.0", tier: "official" };
  return installApp(server, manifest);
}

/**
 * Upload bytes via POST /data/files and register a key-ref record. Returns
 * the parsed record response.
 */
export async function createRecordWithBytes(
  app: InstalledApp,
  options: {
    type?: string;
    bytes?: Buffer | string;
    fileName?: string;
    contentType?: string;
    parentId?: string;
  } = {},
): Promise<{ record: { id: string; [k: string]: unknown }; deduped?: boolean }> {
  const type = options.type ?? "jpg";
  const contentType = options.contentType ?? "image/jpeg";
  const bytes = Buffer.isBuffer(options.bytes)
    ? options.bytes
    : Buffer.from(options.bytes ?? `bytes-${Math.random()}`);

  const upload = await app.fetch(`/data/files?type=${type}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!upload.ok) throw new Error(`upload failed: ${upload.status} ${await upload.text()}`);
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
  if (!register.ok) throw new Error(`register failed: ${register.status} ${await register.text()}`);
  return (await register.json()) as { record: { id: string }; deduped?: boolean };
}

export async function listRecords(
  app: InstalledApp,
  query = "",
): Promise<Array<{ id: string; type: string; [k: string]: unknown }>> {
  const res = await app.fetch(`/data/records${query}`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const body = (await res.json()) as { records: Array<{ id: string; type: string }> };
  return body.records;
}

/**
 * Minimal SSE client over fetch: collects `data:` payloads; comment lines
 * (": connected", ": ping") are tracked separately so the payload contract
 * can be asserted exactly.
 */
export function openSse(url: string): {
  dataEvents: string[];
  comments: string[];
  close: () => Promise<void>;
} {
  const dataEvents: string[] = [];
  const comments: string[] = [];
  const controller = new AbortController();
  let buffer = "";

  const done = fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  }).then(async (res) => {
    if (res.status !== 200 || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) return;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) comments.push(line.slice(1).trim());
          else if (line.startsWith("data:")) dataEvents.push(line.slice(5).trim());
        }
      }
    }
  });

  return {
    dataEvents,
    comments,
    close: () => {
      controller.abort();
      return done.catch(() => {});
    },
  };
}

/** Poll until `fn` stops throwing, or fail after `timeoutMs`. */
export async function eventually<T>(
  fn: () => Promise<T> | T,
  { timeoutMs = 15_000, intervalMs = 150 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (Date.now() > deadline) throw lastError;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
