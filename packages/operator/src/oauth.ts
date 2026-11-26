/**
 * Sign-in on the managed login page with the authorization code flow and
 * PKCE, the pattern `gh auth login` and `aws sso login` follow:
 *
 * 1. {@link startAuthorization} makes a PKCE secret and the page's address.
 * 2. The person signs in on the page; a first sign-in sets the permanent
 *    password there. Neither tool ever sees a password.
 * 3. The page sends the browser to a loopback callback with a one-time code.
 *    admin-web receives it on its own route; the CLI runs
 *    {@link waitForCallback}, a listener that answers once and closes.
 * 4. The receiver redeems the code with the secret
 *    (`redeemAuthorizationCode`), or hands both to the local data server for
 *    a sync sign-in.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CLI_CALLBACK_PATH, CLI_CALLBACK_PORT } from "@starkeep/protocol-primitives";

export interface AuthorizationStart {
  /** The managed login page's address, to open in the browser. */
  url: string;
  /** A random value the callback must echo, which ties the callback to this start. */
  state: string;
  /** The PKCE secret. Its hash went to the page; the redeemer sends it. */
  codeVerifier: string;
  redirectUri: string;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function startAuthorization(options: {
  domain: string;
  clientId: string;
  redirectUri: string;
  /**
   * Ask for the password even when the page remembers the account, so a
   * sign-out cannot be undone by a silent sign-in. The admin sign-ins set it.
   */
  askPassword?: boolean;
}): AuthorizationStart {
  const codeVerifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: "openid email",
    state,
    code_challenge: pkceChallenge(codeVerifier),
    code_challenge_method: "S256",
    ...(options.askPassword ? { prompt: "login" } : {}),
  });
  return {
    url: `https://${options.domain}/oauth2/authorize?${query.toString()}`,
    state,
    codeVerifier,
    redirectUri: options.redirectUri,
  };
}

/**
 * Ask the managed login page whether it accepts this sign-in, before a person
 * waits on it. The page answers a refused request with a redirect to its error
 * page, such as `redirect_mismatch` when the client lists no such callback.
 * Returns the reason, or null when the page accepts the request or cannot be
 * reached (the browser then shows what happened).
 */
export async function authorizationRefusal(url: string): Promise<string | null> {
  const base = process.env.STARKEEP_COGNITO_LOGIN_BASE;
  const target = base ? `${base}${new URL(url).pathname}${new URL(url).search}` : url;
  let res: Response;
  try {
    res = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  const location = res.headers.get("location");
  if (!location) return null;
  const next = new URL(location, target);
  if (!next.pathname.endsWith("/error")) return null;
  return next.searchParams.get("error") ?? "error";
}

/** The message for a refused sign-in: an old bootstrap stack is the usual cause. */
export function refusedSignInMessage(reason: string): string {
  return (
    `The managed login page refused this sign-in (${reason}). A bootstrap stack from before the ` +
    "browser sign-in lists no callback address for it. Update the stack with " +
    "`scripts/update-bootstrap.sh --apply`, which needs the AWS account owner's credentials, then sign in again."
  );
}

/**
 * The port the CLI's one-shot listener uses: the one the bootstrap template
 * lists. `STARKEEP_CLI_CALLBACK_PORT` moves it for tests against a fake pool,
 * which matches no template.
 */
export function cliCallbackPort(): number {
  const override = Number(process.env.STARKEEP_CLI_CALLBACK_PORT);
  return Number.isInteger(override) && override > 0 ? override : CLI_CALLBACK_PORT;
}

/** The CLI's callback URL, as the bootstrap template lists it. */
export function cliRedirectUri(port: number = cliCallbackPort()): string {
  return `http://localhost:${port}${CLI_CALLBACK_PATH}`;
}

/** Why a callback did not bring a code. */
export class CallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallbackError";
  }
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style>` +
  `</head><body><h1>${title}</h1><p>${body}</p></body></html>`;

/**
 * Listen once on the loopback callback and resolve with the code. Answers the
 * browser with a short page, then closes. Rejects on a `state` that does not
 * match, on an error the page sent back, and after `timeoutMs`.
 */
export function waitForCallback(options: {
  state: string;
  port?: number;
  path?: string;
  timeoutMs?: number;
}): { done: Promise<{ code: string }>; ready: Promise<void>; cancel: () => void } {
  const port = options.port ?? cliCallbackPort();
  const path = options.path ?? CLI_CALLBACK_PATH;
  const servers: Server[] = [];
  let settle: { resolve: (v: { code: string }) => void; reject: (e: Error) => void };
  const done = new Promise<{ code: string }>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller may attach its handler only after the browser answered; a
  // rejection before then is still handled there, not reported as unhandled.
  done.catch(() => undefined);
  let finished = false;
  const finish = (outcome: { code: string } | Error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    for (const s of servers) s.close();
    if (outcome instanceof Error) settle.reject(outcome);
    else settle.resolve(outcome);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host) || url.pathname !== path) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    res.writeHead(error || !code || state !== options.state ? 400 : 200, {
      "Content-Type": "text/html; charset=utf-8",
      Connection: "close",
    });
    if (error) {
      const description = url.searchParams.get("error_description") ?? error;
      res.end(PAGE("Sign-in failed", "Return to the terminal."));
      finish(new CallbackError(`The sign-in page answered: ${description}`));
      return;
    }
    if (!code || state !== options.state) {
      // A stray or forged request: refuse it, and keep waiting for the real one.
      res.end(PAGE("Sign-in failed", "This callback does not match the sign-in in progress."));
      return;
    }
    res.end(PAGE("Signed in", "You can close this tab and return to the terminal."));
    finish({ code });
  };

  const timer = setTimeout(
    () => finish(new CallbackError("No sign-in arrived before the time ran out.")),
    options.timeoutMs ?? 5 * 60_000,
  );

  // Browsers resolve `localhost` to either loopback address, so listen on both.
  const listen = (host: string) =>
    new Promise<void>((resolve, reject) => {
      const server = createServer(handle);
      server.once("error", reject);
      server.listen(port, host, () => {
        servers.push(server);
        resolve();
      });
    });
  const ready: Promise<void> = (async () => {
    try {
      await listen("127.0.0.1");
    } catch (err) {
      const message =
        (err as NodeJS.ErrnoException).code === "EADDRINUSE"
          ? `Port ${port} is in use, so the sign-in cannot return here. Stop the program that holds it and try again.`
          : `Could not listen for the sign-in on port ${port}: ${(err as Error).message}`;
      finish(new CallbackError(message));
      throw new CallbackError(message);
    }
    // IPv6 loopback is a convenience; a machine without it still works.
    await listen("::1").catch(() => undefined);
  })();
  ready.catch(() => undefined);
  return { done, ready, cancel: () => finish(new CallbackError("Sign-in cancelled.")) };
}
