import type {
  SyncTransport,
  SyncExchangeRequest,
  SyncExchangeResponse,
} from "../types.js";
import { SyncError } from "../errors.js";

export interface HttpSyncTransportOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Produce per-request auth headers given the HTTP method, the request path
   * (relative to the per-app mount), and the serialized body bytes. Used to
   * HMAC-sign requests for the cloud verifier; mirrors the shape
   * `@starkeep/app-client/sign.ts`'s `signRequest` emits (method/path/ts bound).
   */
  readonly signRequest?: (
    method: string,
    path: string,
    body: string,
  ) => Record<string, string>;
}

/**
 * `SyncTransport` that talks to a remote Starkeep-compatible HTTP server
 * over `fetch`. Single endpoint: `POST {baseUrl}/sync/exchange`.
 */
export function createHttpSyncTransport(
  options: HttpSyncTransportOptions,
): SyncTransport {
  const { baseUrl, fetch: fetchImpl = globalThis.fetch, signRequest } = options;
  const trimmed = baseUrl.replace(/\/+$/, "");

  async function postJson<TRequest, TResponse>(
    path: string,
    body: TRequest,
  ): Promise<TResponse> {
    const serialized = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(signRequest?.("POST", path, serialized) ?? {}),
    };

    const response = await fetchImpl(`${trimmed}${path}`, {
      method: "POST",
      headers,
      body: serialized,
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
