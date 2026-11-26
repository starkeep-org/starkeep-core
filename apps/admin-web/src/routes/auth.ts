/**
 * Sign-in on the managed login page, for the admin session and for this
 * computer's sync.
 *
 * - `GET /auth/start?client=admin|device&returnTo=/path` sends the browser to
 *   the managed login page, with a PKCE challenge and a `state` that only this
 *   server knows.
 * - `GET /auth/callback?code&state` receives the browser back. An admin code
 *   becomes the shared session file (`@starkeep/operator/admin-session`). A
 *   device code goes to the local data server's `/auth/login`, which redeems
 *   it and keeps the sync session. The browser then returns to `returnTo`.
 *
 * Neither route ever sees a password. The callback answers only a sign-in this
 * server started: an unknown `state` is refused, so another site cannot plant
 * its own code. Cognito matches the callback exactly, so browser sign-in works
 * only for an admin-web on its default port; `GET /api/admin-session` says so.
 */
import { readConfig } from "@starkeep/operator/config";
import {
  saveAdminSignIn,
  signOutAdmin,
  adminSessionStatus,
} from "@starkeep/operator/admin-session";
import {
  authorizationRefusal,
  refusedSignInMessage,
  startAuthorization,
} from "@starkeep/operator/oauth";
import { localDataServerUrlFromEnv } from "@starkeep/operator/urls";
import {
  ADMIN_WEB_CALLBACK_PATH,
  ADMIN_WEB_DEFAULT_PORT,
  fetchDeviceAuthConfig,
  redeemAuthorizationCode,
} from "@starkeep/protocol-primitives";
import { crossSiteRefusal, fromOwnPage } from "../lib/same-origin";

type Client = "admin" | "device";

interface Pending {
  client: Client;
  domain: string;
  clientId: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo: string;
  createdAt: number;
}

/** A sign-in the person has not finished within this time starts over. */
const PENDING_TTL_MS = 10 * 60_000;
const pending = new Map<string, Pending>();

const REDIRECT_URI = `http://localhost:${ADMIN_WEB_DEFAULT_PORT}${ADMIN_WEB_CALLBACK_PATH}`;

/** A path on admin-web itself, never another site. */
function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return "/";
  return value;
}

function withQuery(path: string, params: Record<string, string>): string {
  const url = new URL(path, "http://localhost");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return `${url.pathname}${url.search}${url.hash}`;
}

function back(returnTo: string, params: Record<string, string>): Response {
  return new Response(null, { status: 302, headers: { Location: withQuery(returnTo, params) } });
}

/** Why this admin-web cannot run a browser sign-in, or null when it can. */
export function browserSignInUnavailable(requestUrl: string): string | null {
  const port = Number(new URL(requestUrl).port || 80);
  if (port !== ADMIN_WEB_DEFAULT_PORT) {
    return `Browser sign-in returns to admin-web on port ${ADMIN_WEB_DEFAULT_PORT}, and this admin-web runs on port ${port}. Sign in with \`starkeep login\` in a terminal instead.`;
  }
  return null;
}

async function signInTarget(
  client: Client,
): Promise<{ domain: string; clientId: string } | string> {
  const config = readConfig() ?? {};
  const configDomain = typeof config.cognitoDomain === "string" ? config.cognitoDomain : null;
  if (client === "admin") {
    const clientId = typeof config.userPoolClientId === "string" ? config.userPoolClientId : null;
    if (!clientId || !configDomain) {
      return "Finish the cloud setup's Stack outputs step first: the admin sign-in needs the user pool client and the CognitoDomain output. A bootstrap stack from before the managed sign-in page has no CognitoDomain output: update it first with `scripts/update-bootstrap.sh --apply`.";
    }
    return { domain: configDomain, clientId };
  }
  // A machine that joined a cloud knows only its address; the cloud names the
  // device client and the sign-in page.
  const cloudUrl = typeof config.apiGatewayUrl === "string" ? config.apiGatewayUrl : null;
  if (!cloudUrl) return "Join a cloud first.";
  try {
    const auth = await fetchDeviceAuthConfig(cloudUrl);
    const domain = auth.cognitoDomain ?? configDomain;
    if (!domain) return "This cloud names no sign-in page yet. Redeploy the cloud data server.";
    return { domain, clientId: auth.deviceClientId };
  } catch (err) {
    return `Could not ask the cloud how to sign in: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Whether another site sent the browser here. The start is a top-level GET,
 * which the `Origin` checks let through. Without this check, a page on any
 * site could navigate to it while the managed login page's session cookie
 * lives, and the page would return a code with no question asked: admin-web
 * would then sign this computer's sync, or the admin session, in without the
 * person. Browsers name the initiator in `Sec-Fetch-Site`. `none` is an
 * address typed or opened from outside a page, such as by the CLI. A browser
 * that sends no such header passes, as it did before.
 */
function startedElsewhere(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

export async function START(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const client = url.searchParams.get("client");
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  if (startedElsewhere(req)) {
    return back("/", { signInError: "Start the sign-in from admin-web's own page." });
  }
  if (client !== "admin" && client !== "device") {
    return back(returnTo, { signInError: "Unknown sign-in kind." });
  }
  const unavailable = browserSignInUnavailable(req.url);
  if (unavailable) return back(returnTo, { signInError: unavailable });
  const target = await signInTarget(client);
  if (typeof target === "string") return back(returnTo, { signInError: target });

  const now = Date.now();
  for (const [state, p] of pending) if (now - p.createdAt > PENDING_TTL_MS) pending.delete(state);
  const start = startAuthorization({
    ...target,
    redirectUri: REDIRECT_URI,
    askPassword: client === "admin",
  });
  const refusal = await authorizationRefusal(start.url);
  if (refusal) return back(returnTo, { signInError: refusedSignInMessage(refusal) });
  pending.set(start.state, {
    client,
    ...target,
    codeVerifier: start.codeVerifier,
    redirectUri: start.redirectUri,
    returnTo,
    createdAt: now,
  });
  return new Response(null, { status: 302, headers: { Location: start.url } });
}

export async function CALLBACK(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) {
    return back("/", {
      signInError: "This sign-in did not start here, or it expired. Start it again.",
    });
  }
  const error = url.searchParams.get("error");
  if (error) {
    return back(p.returnTo, { signInError: url.searchParams.get("error_description") ?? error });
  }
  const code = url.searchParams.get("code");
  if (!code) return back(p.returnTo, { signInError: "The sign-in page sent no code." });

  if (p.client === "admin") {
    try {
      const tokens = await redeemAuthorizationCode({
        domain: p.domain,
        clientId: p.clientId,
        code,
        codeVerifier: p.codeVerifier,
        redirectUri: p.redirectUri,
        // Test seam: a fake token endpoint.
        ...(process.env.STARKEEP_COGNITO_TOKEN_ENDPOINT
          ? { tokenEndpoint: process.env.STARKEEP_COGNITO_TOKEN_ENDPOINT }
          : {}),
      });
      await saveAdminSignIn(tokens);
    } catch (err) {
      return back(p.returnTo, { signInError: err instanceof Error ? err.message : String(err) });
    }
    return back(p.returnTo, { signedIn: "admin" });
  }

  // The local data server redeems a device code and keeps the sync session.
  try {
    const res = await fetch(`${localDataServerUrlFromEnv()}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: p.codeVerifier, redirectUri: p.redirectUri }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return back(p.returnTo, { signInError: body.error ?? `Sign-in failed (${res.status})` });
    }
  } catch (err) {
    return back(p.returnTo, {
      signInError: `The local data server is not answering: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return back(p.returnTo, { signedIn: "device" });
}

/** Whether an admin session lives, and whether this admin-web can start a browser sign-in. */
export async function SESSION(req: Request): Promise<Response> {
  const status = adminSessionStatus();
  const unavailable = browserSignInUnavailable(req.url);
  return Response.json({
    ...status,
    browserSignIn: unavailable ? { available: false, reason: unavailable } : { available: true },
  });
}

/** End the admin session in both tools, here and at the pool. */
export async function SIGN_OUT(req: Request): Promise<Response> {
  if (!fromOwnPage(req)) return crossSiteRefusal();
  return Response.json(await signOutAdmin());
}

/** For tests: forget every sign-in in progress. */
export function forgetPendingSignIns(): void {
  pending.clear();
}
