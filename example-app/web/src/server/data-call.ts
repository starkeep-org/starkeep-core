/**
 * Data calls from the app's server, for a caller that holds a token the
 * platform issued: an outside client's delegation (`mcp.ts`) or a job run's
 * token (`jobs.ts`).
 *
 * Every call is signed with the app's credentials and forwards the token, so
 * the platform applies the token's mode, user and revocation to each one. The
 * browser's calls take the other path, through the signing proxy with the
 * user's session.
 */

import { signedFetch, type AppCredentials } from "@starkeep/app-client";
import { EXAMPLE_TYPE, textMetrics } from "@example-app/common";

/** A data call the data server refused, with its status and reason. */
export class DataCallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One data call. Answers the parsed JSON body, or the text when it is not JSON. */
export type DataCall = (
  method: string,
  path: string,
  body?: { json?: unknown; text?: string },
) => Promise<unknown>;

/**
 * A data caller for one token. `token` is null for a loopback caller on
 * the local surface, which the local data server admits as the app itself.
 */
export function dataCaller(creds: AppCredentials, token: string | null | undefined): DataCall {
  return async (method, path, body) => {
    const res = await signedFetch(creds, path, {
      method,
      delegation: token,
      ...(body?.json !== undefined
        ? { body: JSON.stringify(body.json), headers: { "Content-Type": "application/json" } }
        : body?.text !== undefined
          ? { body: body.text, headers: { "Content-Type": "text/plain" } }
          : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Keep the text.
    }
    if (!res.ok) {
      const reason =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : text.slice(0, 300);
      throw new DataCallError(res.status, `The data server answered ${res.status}: ${reason}`);
    }
    return parsed;
  };
}

/** A record as both data servers send it. */
export interface RecordRow {
  id: string;
  original_filename?: string | null;
  created_at?: string;
  /** As both data servers send it: `key` bare, `label` namespaced as `<app_id>/<key>`. */
  labels?: { app_id: string; key: string; value?: string | null }[];
  metadata?: Record<string, unknown>;
}

/**
 * Create an example file from text: store the bytes with `POST /data/files`,
 * then register the record with its line, word and character counts.
 */
export async function createExampleFile(
  call: DataCall,
  name: string,
  text: string,
): Promise<RecordRow> {
  const raw = name.replace(/\.skexample$/, "");
  const stored = (await call("POST", `/data/files?type=${encodeURIComponent(EXAMPLE_TYPE)}`, {
    text,
  })) as { contentHash: string; sizeBytes: number };
  const body = (await call("POST", "/data/records", {
    json: {
      type: EXAMPLE_TYPE,
      fileName: `${raw}.skexample`,
      contentType: "text/plain",
      contentHash: stored.contentHash,
      sizeBytes: stored.sizeBytes,
      metadata: textMetrics(text),
    },
  })) as { record: RecordRow };
  return body.record;
}
