import type {
  SyncTransport,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from "../types.js";
import { SyncError } from "../errors.js";

export interface HttpSyncTransportOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly getAuthHeader?: () => string | undefined;
}

/**
 * `SyncTransport` that talks to a remote Starkeep-compatible HTTP server
 * over `fetch`. Endpoints:
 *   POST {baseUrl}/sync/pull  — body SyncPullRequest, returns SyncPullResponse
 *   POST {baseUrl}/sync/push  — body SyncPushRequest, returns SyncPushResponse
 */
export function createHttpSyncTransport(
  options: HttpSyncTransportOptions,
): SyncTransport {
  const { baseUrl, fetch: fetchImpl = globalThis.fetch, getAuthHeader } = options;
  const trimmed = baseUrl.replace(/\/+$/, "");

  async function postJson<TRequest, TResponse>(
    path: string,
    body: TRequest,
  ): Promise<TResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const auth = getAuthHeader?.();
    if (auth) headers["Authorization"] = auth;

    const response = await fetchImpl(`${trimmed}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SyncError(
        `${path} failed: ${response.status} ${response.statusText} ${text}`,
      );
    }

    return (await response.json()) as TResponse;
  }

  return {
    async pullChanges(request: SyncPullRequest): Promise<SyncPullResponse> {
      return postJson<SyncPullRequest, SyncPullResponse>("/sync/pull", request);
    },
    async pushChanges(request: SyncPushRequest): Promise<SyncPushResponse> {
      return postJson<SyncPushRequest, SyncPushResponse>("/sync/push", request);
    },
  };
}
