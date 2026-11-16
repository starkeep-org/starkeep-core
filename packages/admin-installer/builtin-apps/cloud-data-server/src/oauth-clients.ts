/**
 * OAuth clients, identified by client ID metadata documents (CIMD).
 *
 * An MCP client presents an `https` URL as its `client_id`. The URL serves a
 * JSON document that names the client and lists its redirect URIs. The
 * authorization server fetches the document instead of keeping a client
 * registry, so nothing persists and no anonymous endpoint writes rows.
 *
 * The fetch runs on an anonymous caller's say-so, so it is guarded against
 * server-side request forgery:
 *
 * - The URL must be `https`, on the default port, with a path and no
 *   fragment or credentials. The `https` rule alone keeps the fetch off the
 *   Lambda runtime API on `127.0.0.1:9001`.
 * - The hostname resolves first, and every resolved address must be public.
 *   The connection uses the checked address, so a DNS rebind between the
 *   check and the connection cannot swap the target.
 * - The fetch follows no redirect, reads at most {@link MAX_DOCUMENT_BYTES}
 *   and gives up after {@link FETCH_TIMEOUT_MS}.
 *
 * A document is cached per container for its `Cache-Control` max-age, within
 * {@link MIN_CACHE_MS} and {@link MAX_CACHE_MS}.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { BlockList, isIP } from "node:net";

export const MAX_DOCUMENT_BYTES = 5 * 1024;
export const FETCH_TIMEOUT_MS = 3_000;
export const MIN_CACHE_MS = 5 * 60 * 1000;
export const MAX_CACHE_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const MAX_CLIENT_NAME = 64;

/** What the consent page and the token endpoint need from a client's document. */
export interface OAuthClient {
  clientId: string;
  /** The document's `client_name`, unverified: the client chose it. */
  clientName: string | null;
  redirectUris: string[];
}

export type ClientResult = { ok: true; client: OAuthClient } | { ok: false; message: string };

// ---------------------------------------------------------------------------
// The client_id URL
// ---------------------------------------------------------------------------

/** The `client_id` as a URL when it may name a metadata document, or null. */
export function clientIdUrl(raw: string | undefined): URL | null {
  if (!raw || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.hash || raw.includes("#")) return null;
  if (url.port !== "") return null;
  if (url.pathname === "/" || url.pathname === "") return null;
  // A client is named by its hostname. An IP literal also skips the guarded
  // lookup below, because Node connects to a literal without resolving it.
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) return null;
  // The document must name the same string, so a URL that normalizes into
  // another spelling could never match it.
  if (url.href !== raw) return null;
  return url;
}

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Whether a redirect URI is an `http` loopback address, as a native app's is. */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Whether a redirect URI may appear in a client's document at all. */
function acceptableRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.hash || url.username || url.password) return false;
    return url.protocol === "https:" || isLoopbackRedirect(uri);
  } catch {
    return false;
  }
}

/**
 * Whether `requested` matches one of the client's registered redirect URIs.
 * Matching is exact, except that a loopback `http` URI matches on any port
 * (OAuth 2.1, section 8.4.2), because a native app picks a free port at run
 * time.
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  if (!isLoopbackRedirect(requested)) return false;
  const want = new URL(requested);
  return registered.some((uri) => {
    if (!isLoopbackRedirect(uri)) return false;
    const have = new URL(uri);
    return (
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

/** The origin a redirect lands on, for the consent page's `form-action`. */
export function redirectOrigin(uri: string): string {
  return new URL(uri).origin;
}

// ---------------------------------------------------------------------------
// Address checks
// ---------------------------------------------------------------------------

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  // NAT64 and 6to4 can each carry a private IPv4 address. An IPv4-mapped
  // address is checked as the IPv4 address it carries, below: a BlockList
  // rule for ::ffff:0:0/96 would also match every plain IPv4 address.
  ["64:ff9b::", 96],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** Whether the fetch may connect to `address`: a public unicast address only. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (/^::ffff:/i.test(address)) return false;
  return !blocked.check(address, "ipv6");
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    ),
  );

/**
 * A `lookup` for `https.request` that refuses a hostname when any of its
 * addresses is not public. The connection then uses an address this function
 * returned, so the check and the connection cannot disagree.
 */
export function guardedLookup(
  resolve: Resolver = systemResolver,
  allow: (address: string) => boolean = isPublicAddress,
) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every((a) => allow(a.address))) {
          const err: NodeJS.ErrnoException = new Error(
            `${hostname} resolves to an address the server may not fetch`,
          );
          err.code = "ENOTPUBLIC";
          callback(err, "");
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

export interface FetchedDocument {
  status: number;
  cacheControl: string | undefined;
  body: string;
}

export interface FetchDeps {
  /** Test seam: `https.request` by default. */
  request?: (url: URL, options: RequestOptions) => ClientRequest;
  /** Test seam: the lookup the request uses. */
  lookup?: RequestOptions["lookup"];
  timeoutMs?: number;
}

/** GET one document with the guards above. Rejects on any guard tripping. */
export function fetchDocument(url: URL, deps: FetchDeps = {}): Promise<FetchedDocument> {
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const doRequest = deps.request ?? ((u: URL, options: RequestOptions) => httpsRequest(u, options));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, doc?: FetchedDocument) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(doc!);
    };
    const req = doRequest(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      lookup: deps.lookup ?? (guardedLookup() as unknown as RequestOptions["lookup"]),
      // Every socket is fresh, so a pooled socket to a checked address is
      // never reused for another hostname.
      agent: false,
    });
    const timer = setTimeout(
      () => finish(new Error("the client document fetch timed out")),
      timeoutMs,
    );
    req.on("error", (err) => finish(err));
    req.on("response", (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DOCUMENT_BYTES) {
          finish(new Error("the client document is too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", (err) => finish(err));
      res.on("end", () =>
        finish(null, {
          status: res.statusCode ?? 0,
          cacheControl: res.headers["cache-control"],
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** Check a fetched document against the `client_id` that named it. */
export function checkClientDocument(clientId: string, body: string): ClientResult {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return { ok: false, message: "The client's metadata document is not JSON." };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, message: "The client's metadata document is not a JSON object." };
  }
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) {
    return { ok: false, message: "The client's metadata document names another client_id." };
  }
  const uris = d.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    !uris.every((u): u is string => typeof u === "string" && acceptableRedirectUri(u))
  ) {
    return {
      ok: false,
      message: "The client's metadata document lists no usable redirect_uris.",
    };
  }
  const method = d.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return {
      ok: false,
      message: "This server accepts public clients only (token_endpoint_auth_method none).",
    };
  }
  const rawName = typeof d.client_name === "string" ? d.client_name : "";
  const name = rawName
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_CLIENT_NAME);
  return { ok: true, client: { clientId, clientName: name || null, redirectUris: uris } };
}

/** The cache lifetime a `Cache-Control` header asks for, within the bounds. */
export function cacheMsFor(cacheControl: string | undefined): number {
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl ?? "");
  const askedMs = match ? Number(match[1]) * 1000 : 0;
  return Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, askedMs));
}

const cache = new Map<string, { client: OAuthClient; until: number }>();

/** Test seam. */
export function resetClientCache(): void {
  cache.clear();
}

export interface ClientDeps extends FetchDeps {
  now?: () => number;
  /** Test seam: replaces the whole fetch. */
  fetchDocument?: (url: URL) => Promise<FetchedDocument>;
}

/**
 * The client a `client_id` names, from its metadata document. A failure
 * carries a sentence for the error page; nothing here throws.
 */
export async function loadClient(
  clientId: string | undefined,
  deps: ClientDeps = {},
): Promise<ClientResult> {
  const url = clientIdUrl(clientId);
  if (!url || !clientId) {
    return {
      ok: false,
      message: "The client_id must be an https URL that serves a client metadata document.",
    };
  }
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(clientId);
  if (hit && hit.until > now) return { ok: true, client: hit.client };

  let fetched: FetchedDocument;
  try {
    fetched = await (deps.fetchDocument ?? ((u: URL) => fetchDocument(u, deps)))(url);
  } catch (err) {
    console.warn(`[oauth] fetching ${url.host}'s client document failed:`, err);
    return { ok: false, message: `The client's metadata document at ${url.host} did not load.` };
  }
  if (fetched.status !== 200) {
    return {
      ok: false,
      message: `The client's metadata document at ${url.host} answered ${fetched.status}.`,
    };
  }
  const checked = checkClientDocument(clientId, fetched.body);
  if (!checked.ok) return checked;
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(clientId, { client: checked.client, until: now + cacheMsFor(fetched.cacheControl) });
  return checked;
}
