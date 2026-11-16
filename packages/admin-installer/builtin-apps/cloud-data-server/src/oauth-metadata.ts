/**
 * The two OAuth discovery documents an MCP client reads before it signs in.
 *
 * - Protected resource metadata (RFC 9728), at
 *   `/.well-known/oauth-protected-resource/apps/<appId>/<path>` on the host
 *   the client reached the app on. It names the resource and the
 *   authorization server. It answers only for an installed app's declared
 *   `delegated` route, so a client learns nothing about any other path.
 * - Authorization server metadata (RFC 8414), at
 *   `/.well-known/oauth-authorization-server` on the issuer's host: the
 *   gateway's execute-api hostname, beside the consent pages.
 *
 * The resource answers through CloudFront only, and the issuer on the
 * execute-api hostname only. The caller says which arrived, from the
 * CloudFront origin header.
 */
import {
  CONNECT_AUTHORIZE_ROUTE,
  CONNECT_TOKEN_ROUTE,
  OAUTH_AS_METADATA_ROUTE,
  OAUTH_PRM_PREFIX,
  OAUTH_SCOPES,
} from "@starkeep/protocol-primitives";
import type { ConnectableApp } from "./delegation-store.js";

export interface MetadataResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const PRM_PATTERN = new RegExp(
  `^${OAUTH_PRM_PREFIX.replace(/[.]/g, "\\.")}/apps/([a-z0-9][a-z0-9._-]*)(/.*)$`,
);

/** Whether `rawPath` is one of the two discovery documents. */
export function isOAuthMetadataPath(rawPath: string): boolean {
  return rawPath === OAUTH_AS_METADATA_ROUTE || PRM_PATTERN.test(rawPath);
}

/** The app and the path within it that a protected resource metadata URL names. */
export function resourceOfMetadataPath(rawPath: string): { appId: string; subPath: string } | null {
  const match = PRM_PATTERN.exec(rawPath);
  return match ? { appId: match[1]!, subPath: match[2]! } : null;
}

/**
 * Whether `subPath` is one of an app's declared delegated paths. A
 * `{param}` segment in a declaration matches any one segment, as API
 * Gateway's does.
 */
export function declaresPath(declared: readonly string[], subPath: string): boolean {
  const want = subPath.split("/");
  return declared.some((path) => {
    const have = path.split("/");
    return (
      have.length === want.length &&
      have.every((seg, i) => seg === want[i] || (/^\{[^}+]+\}$/.test(seg) && want[i] !== ""))
    );
  });
}

/** The URL `/apps/<appId><subPath>` on `viewerBase`: the resource a client names. */
export function resourceUrl(viewerBase: string, appId: string, subPath: string): string {
  return `${viewerBase}/apps/${appId}${subPath}`;
}

/** The app and path a `resource` parameter names on one of the deployment's hosts, or null. */
export function parseResource(
  resource: string | undefined,
  viewerHosts: readonly string[],
): { appId: string; subPath: string; resource: string } | null {
  if (!resource) return null;
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.port) return null;
  if (!viewerHosts.includes(url.hostname)) return null;
  const match = /^\/apps\/([a-z0-9][a-z0-9._-]*)(\/.*)$/.exec(url.pathname);
  if (!match) return null;
  // The resource is compared as a string from here on, so it must already be
  // in its normal spelling.
  if (url.href !== resource) return null;
  return { appId: match[1]!, subPath: match[2]!, resource };
}

function json(statusCode: number, body: unknown, cache: boolean): MetadataResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cache ? "max-age=300" : "no-store",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}${CONNECT_AUTHORIZE_ROUTE}`,
    token_endpoint: `${issuer}${CONNECT_TOKEN_ROUTE}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [...OAUTH_SCOPES],
  };
}

export interface MetadataDeps {
  /** True when the request came through CloudFront (it carries the origin header). */
  throughCloudFront: boolean;
  /** `https://<execute-api host>`: the issuer. */
  issuer: string;
  /** `https://<viewer host>`: the host the client reached the app on. */
  viewerBase(): Promise<string>;
  connectableApps(): Promise<ConnectableApp[]>;
}

/** Answer one discovery document. Call only when {@link isOAuthMetadataPath} holds. */
export async function handleOAuthMetadata(
  rawPath: string,
  deps: MetadataDeps,
): Promise<MetadataResponse> {
  const notFound = json(404, { error: "Not found" }, false);
  if (rawPath === OAUTH_AS_METADATA_ROUTE) {
    if (deps.throughCloudFront) return notFound;
    return json(200, authorizationServerMetadata(deps.issuer), true);
  }
  const named = resourceOfMetadataPath(rawPath);
  if (!named || !deps.throughCloudFront) return notFound;
  const app = (await deps.connectableApps()).find((a) => a.appId === named.appId);
  if (!app || !declaresPath(app.delegatedPaths, named.subPath)) return notFound;
  return json(
    200,
    {
      resource: resourceUrl(await deps.viewerBase(), app.appId, named.subPath),
      authorization_servers: [deps.issuer],
      // The minimum for basic use, which a client requests in full. The user
      // may raise the mode to `readwrite` on the consent page.
      scopes_supported: ["read"],
      bearer_methods_supported: ["header"],
      resource_name: app.name,
    },
    true,
  );
}
