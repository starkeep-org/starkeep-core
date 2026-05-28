import type {
  SyncTransport,
  SyncExchangeRequest,
  SyncExchangeResponse,
} from "../types.js";
import { SyncError } from "../errors.js";

export interface HttpSyncTransportOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly getAuthHeader?: () => string | undefined;
}

/**
 * `SyncTransport` that talks to a remote Starkeep-compatible HTTP server
 * over `fetch`. Single endpoint: `POST {baseUrl}/sync/exchange`.
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
    async exchange(request: SyncExchangeRequest): Promise<SyncExchangeResponse> {
      return postJson<SyncExchangeRequest, SyncExchangeResponse>(
        "/sync/exchange",
        request,
      );
    },
  };
}
