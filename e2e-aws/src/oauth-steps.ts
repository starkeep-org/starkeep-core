/**
 * An MCP client signs in with OAuth, end to end on real AWS.
 *
 * The client is the official MCP TypeScript SDK's own `auth()`, the
 * discovery and token code Claude Code runs, with Probe's client metadata
 * document as its `client_id` and a loopback redirect URI. Playwright plays
 * the user: it signs in on the managed login page and approves on the consent
 * page. The suite reads the code off the browser's request to the loopback
 * address, so it needs no listener and no outside host.
 *
 * What the steps hold (plan-delegated-access-phase2-implementation-2026-11-16.md):
 *
 * - The gateway's bare 401 is enough for discovery: the SDK finds the
 *   protected resource metadata at its well-known location and the
 *   authorization server from there.
 * - The consent page issues a code that the token endpoint exchanges for a
 *   `read` access token, which reads through Probe and is refused a write.
 * - A refresh rotates the tokens.
 * - An expired access token gets a 401 at the gateway.
 * - Revoking on the connections page ends the next refresh.
 */

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { chromium, type Browser } from "./browser.js";
import { signInIfAsked } from "./delegation-steps.js";
import { REGION } from "./env.js";
import type { TestStackConfig } from "./run-state.js";

/** Where Probe serves its client metadata document, relative to the app. */
const CLIENT_DOCUMENT_PATH = "/_static/oauth-client.json";
/** Any port matches a loopback redirect URI the document lists. */
const REDIRECT_URI = "http://127.0.0.1:53682/callback";

export interface OAuthStepsContext {
  readonly config: () => TestStackConfig;
  readonly appId: string;
  /** The app's MCP route, relative to its mount, declared `auth: "delegated"`. */
  readonly mcpPath: string;
  readonly admin: () => { email: string; password: string };
}

/** An in-memory OAuth client: what the SDK asks a real client to keep. */
class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;

  constructor(readonly clientMetadataUrl: string) {}

  get redirectUrl(): string {
    return REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Probe test client",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

export function defineOAuthSteps(d: OAuthStepsContext): void {
  let browser: Browser | undefined;
  let provider: MemoryProvider;
  const edge = () => d.config().publicBaseUrl!.replace(/\/+$/, "");
  const gateway = () => d.config().apiGatewayUrl!.replace(/\/+$/, "");
  const mcpUrl = () => `${edge()}/apps/${d.appId}${d.mcpPath}`;

  afterAll(async () => {
    await browser?.close();
  });

  /** Call one of the app's tools as an MCP client would. */
  async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
    const res = await fetch(mcpUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    if (res.status !== 200) return { http: res.status, status: res.status, body: await res.text() };
    const rpc = (await res.json()) as { result?: { content?: { text?: string }[] } };
    const answer = JSON.parse(rpc.result?.content?.[0]?.text ?? "{}") as {
      status: number;
      body: unknown;
    };
    return { http: 200, ...answer };
  }

  it("serves discovery: a bare 401, then both metadata documents", async () => {
    const bare = await fetch(mcpUrl(), { method: "POST", body: "{}" });
    expect(bare.status).toBe(401);

    const prm = await fetch(
      `${edge()}/.well-known/oauth-protected-resource/apps/${d.appId}${d.mcpPath}`,
    );
    expect(prm.status).toBe(200);
    const resource = (await prm.json()) as { resource: string; authorization_servers: string[] };
    expect(resource.resource).toBe(mcpUrl());
    expect(resource.authorization_servers).toEqual([gateway()]);

    const as = await fetch(`${gateway()}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    expect(await as.json()).toMatchObject({
      issuer: gateway(),
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
    });

    const doc = await fetch(`${edge()}/apps/${d.appId}${CLIENT_DOCUMENT_PATH}`);
    expect(doc.status).toBe(200);
    expect(((await doc.json()) as { client_id: string }).client_id).toBe(
      `${edge()}/apps/${d.appId}${CLIENT_DOCUMENT_PATH}`,
    );
  });

  it("signs in and approves, then exchanges the code for a read access token", async () => {
    provider = new MemoryProvider(`${edge()}/apps/${d.appId}${CLIENT_DOCUMENT_PATH}`);
    // No resource metadata URL: the gateway's 401 names none, so the SDK
    // takes the well-known fallback, as Claude Code would.
    expect(await auth(provider, { serverUrl: mcpUrl() })).toBe("REDIRECT");
    const authorizationUrl = provider.authorizationUrl!;
    expect(authorizationUrl.origin).toBe(gateway());
    expect(authorizationUrl.searchParams.get("client_id")).toBe(provider.clientMetadataUrl);
    expect(authorizationUrl.searchParams.get("resource")).toBe(mcpUrl());

    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(authorizationUrl.toString());
    await signInIfAsked(page, d.admin().email, d.admin().password);
    await page
      .getByRole("button", { name: "Allow" })
      .waitFor({ state: "visible", timeout: 60_000 });
    await expect.poll(async () => await page.content()).toContain(d.admin().email);
    // The redirect to the loopback address reaches no listener, and need not:
    // the browser's request carries the URL a native client's listener would
    // read. Playwright's routing does not intercept a redirected navigation,
    // so the step reads the request rather than fulfilling it.
    const callback = page.waitForRequest((r) => r.url().startsWith(REDIRECT_URI), {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Allow" }).click();
    const landed = new URL((await callback).url());
    expect(landed.searchParams.get("code"), landed.href).toBeTruthy();
    await page.close();

    expect(landed.searchParams.get("iss")).toBe(gateway());
    expect(landed.searchParams.get("state")).toBe(authorizationUrl.searchParams.get("state"));
    const code = landed.searchParams.get("code")!;
    expect(await auth(provider, { serverUrl: mcpUrl(), authorizationCode: code })).toBe(
      "AUTHORIZED",
    );
    expect(provider.saved).toMatchObject({ token_type: "Bearer", scope: "read" });
    expect(provider.saved!.refresh_token).toMatch(/^skr_/);
  });

  it("reads through the app with the access token, and is refused a write", async () => {
    const list = await tool(provider.saved!.access_token, "list_records");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const write = await tool(provider.saved!.access_token, "add_note", {
      recordId: "tier3-oauth",
      note: "no",
    });
    expect(write.status).toBe(403);
  });

  it("refreshes, rotating the refresh token", async () => {
    const before = provider.saved!;
    expect(await auth(provider, { serverUrl: mcpUrl() })).toBe("AUTHORIZED");
    expect(provider.saved!.refresh_token).not.toBe(before.refresh_token);
    expect(provider.saved!.access_token).not.toBe(before.access_token);
    expect((await tool(provider.saved!.access_token, "list_records")).status).toBe(200);
  });

  it("answers 401 at the gateway for an expired access token", async () => {
    // The deployment's own key signs a token that expired a minute ago, for
    // the delegation the flow created, so only the expiry is wrong.
    const live = provider.saved!.access_token;
    const claims = JSON.parse(
      Buffer.from(live.slice(4).split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const param = await new SSMClient({ region: REGION }).send(
      new GetParameterCommand({
        Name: `/${d.config().stackPrefix}/app-creds/_delegation-signing`,
        WithDecryption: true,
      }),
    );
    const { privateKeyPem } = JSON.parse(param.Parameter!.Value!) as { privateKeyPem: string };
    const expired = signToken(privateKeyPem, {
      ...claims,
      iat: Math.floor(Date.now() / 1000) - 120,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    expect((await tool(expired, "list_records")).http).toBe(401);
  });

  it("ends the next refresh when the user revokes on the connections page", async () => {
    const page = await browser!.newPage();
    await page.goto(`${gateway()}/connections`);
    await signInIfAsked(page, d.admin().email, d.admin().password);
    const row = page
      .getByRole("row")
      .filter({ hasText: "Probe test client" })
      .filter({ has: page.getByRole("button", { name: "Revoke" }) })
      .first();
    await row.getByRole("button", { name: "Revoke" }).click();
    await page.waitForURL(/\/connections$/);
    await page.close();

    const res = await fetch(`${gateway()}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: provider.saved!.refresh_token!,
        client_id: provider.clientMetadataUrl,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });
}

/** Sign delegation claims the way the data server does: ES256 behind `skd_`. */
function signToken(privateKeyPem: string, claims: Record<string, unknown>): string {
  const key = createPrivateKey(privateKeyPem);
  // The key id is a fingerprint of the public key's SPKI encoding.
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const kid = createHash("sha256").update(spki).digest("base64url").slice(0, 16);
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${b64({ alg: "ES256", typ: "JWT", kid })}.${b64(claims)}`;
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `skd_${input}.${signature.toString("base64url")}`;
}
