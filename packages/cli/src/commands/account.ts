/**
 * `starkeep login` and `starkeep logout`: the admin session that admin-web
 * shares, and this computer's sync sign-in.
 *
 * Both sign-ins happen on the managed login page in the browser, through the
 * authorization code flow with PKCE. The CLI listens once on its fixed
 * loopback callback (`CLI_CALLBACK_PORT`), which the bootstrap template lists.
 * The terminal never reads a password.
 */
import { spawnSync } from "node:child_process";
import { readConfig } from "@starkeep/operator/config";
import {
  adminPool,
  adminSessionStatus,
  hasAdminSessionFile,
  saveAdminSignIn,
  signOutAdmin,
} from "@starkeep/operator/admin-session";
import { cliRedirectUri, startAuthorization, waitForCallback } from "@starkeep/operator/oauth";
import { localDataServerUrlFromEnv } from "@starkeep/operator/urls";
import { fetchDeviceAuthConfig, redeemAuthorizationCode } from "@starkeep/protocol-primitives";
import { flag, type Command, type ParsedArgs } from "../command";
import { CliError, usageError } from "../errors";
import type { Io } from "../io";

function which(args: ParsedArgs, verb: string): "admin" | "sync" {
  const admin = flag(args, "admin");
  const sync = flag(args, "sync");
  if (admin === sync) throw usageError(`Name what to ${verb}: --admin or --sync.`);
  return admin ? "admin" : "sync";
}

function openInBrowser(url: string): boolean {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return spawnSync(opener, [url], { stdio: "ignore" }).status === 0;
}

/** Run the browser half of a sign-in and return the code and its verifier. */
async function browserSignIn(
  io: Io,
  target: { domain: string; clientId: string },
  noBrowser: boolean,
): Promise<{ code: string; codeVerifier: string; redirectUri: string }> {
  const start = startAuthorization({ ...target, redirectUri: cliRedirectUri() });
  const wait = waitForCallback({ state: start.state });
  try {
    await wait.ready;
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  io.event({
    type: "prompt-needed",
    reason: "sign-in",
    detail: `Sign in on this page; it returns here when you finish:\n  ${start.url}`,
  });
  if (!noBrowser && !openInBrowser(start.url)) {
    io.warn("Could not open a browser. Open the address above yourself.");
  }
  try {
    const { code } = await wait.done;
    return { code, codeVerifier: start.codeVerifier, redirectUri: start.redirectUri };
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

async function loginAdmin(io: Io, noBrowser: boolean): Promise<void> {
  const pool = adminPool();
  if (!pool || !pool.cognitoDomain) {
    throw new CliError(
      "This computer has no cloud setup with a sign-in page yet. Finish the Stack outputs step in admin-web first.",
    );
  }
  const { code, codeVerifier, redirectUri } = await browserSignIn(
    io,
    { domain: pool.cognitoDomain, clientId: pool.clientId },
    noBrowser,
  );
  let status;
  try {
    const tokens = await redeemAuthorizationCode({
      domain: pool.cognitoDomain,
      clientId: pool.clientId,
      code,
      codeVerifier,
      redirectUri,
      ...(process.env.STARKEEP_COGNITO_TOKEN_ENDPOINT
        ? { tokenEndpoint: process.env.STARKEEP_COGNITO_TOKEN_ENDPOINT }
        : {}),
    });
    status = await saveAdminSignIn(tokens);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  io.event({
    type: "progress",
    message: `Signed in as the admin${status.email ? ` (${status.email})` : ""}. admin-web uses the same sign-in.`,
  });
  io.event({ type: "result", ok: true, data: status });
}

async function loginSync(io: Io, noBrowser: boolean): Promise<void> {
  const config = readConfig() ?? {};
  const cloudUrl = typeof config.apiGatewayUrl === "string" ? config.apiGatewayUrl : null;
  if (!cloudUrl) throw new CliError("This computer has joined no cloud. Join one in admin-web first.");
  let auth;
  try {
    auth = await fetchDeviceAuthConfig(cloudUrl);
  } catch (err) {
    throw new CliError(`Could not ask the cloud how to sign in: ${(err as Error).message}`);
  }
  const domain =
    auth.cognitoDomain ?? (typeof config.cognitoDomain === "string" ? config.cognitoDomain : null);
  if (!domain) throw new CliError("This cloud names no sign-in page yet. Redeploy the cloud data server.");
  const signIn = await browserSignIn(io, { domain, clientId: auth.deviceClientId }, noBrowser);
  // The local data server redeems the code and keeps the sync session.
  let res: Response;
  try {
    res = await fetch(`${localDataServerUrlFromEnv()}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signIn),
    });
  } catch {
    throw new CliError("The local data server is not answering. Run `starkeep start data-server` first.");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; email?: string };
  if (!res.ok) throw new CliError(`The sign-in did not finish: ${body.error ?? res.status}`);
  io.event({ type: "progress", message: `This computer syncs as ${body.email ?? "you"}.` });
  io.event({ type: "result", ok: true, data: { email: body.email ?? null } });
}

export const loginCommand: Command = {
  name: "login",
  summary: "Sign in as the admin, or sign this computer in to sync",
  usage: "--admin | --sync [--no-browser]",
  lane: "none",
  flags: {
    admin: { type: "boolean", description: "Sign in as the Starkeep admin, for admin-web and the CLI." },
    sync: { type: "boolean", description: "Sign this computer in to sync, as a data user." },
    "no-browser": { type: "boolean", description: "Print the sign-in address without opening it." },
  },
  details:
    "Opens the managed login page in the browser. The page asks for a new password at an account's\n" +
    "first sign-in. The admin session ends after 12 hours without use.",
  async run(io, args) {
    const noBrowser = flag(args, "no-browser");
    if (which(args, "sign in to") === "admin") await loginAdmin(io, noBrowser);
    else await loginSync(io, noBrowser);
  },
};

export const logoutCommand: Command = {
  name: "logout",
  summary: "End the admin session, or this computer's sync sign-in",
  usage: "--admin | --sync",
  lane: "none",
  flags: {
    admin: { type: "boolean", description: "End the admin session, for admin-web and the CLI alike." },
    sync: { type: "boolean", description: "Sign this computer out of sync." },
  },
  async run(io, args) {
    if (which(args, "sign out of") === "admin") {
      // `revoked` is false both when no session existed and when the pool
      // could not be reached, so the file decides which one this is.
      const hadSession = hasAdminSessionFile();
      const { revoked } = await signOutAdmin();
      io.event({
        type: "progress",
        message: revoked
          ? "Signed out as the admin."
          : hadSession
            ? "Signed out as the admin on this computer. The pool did not confirm that it revoked the sign-in."
            : "No admin session was open here.",
      });
      io.event({ type: "result", ok: true, data: { revoked } });
      return;
    }
    let res: Response;
    try {
      res = await fetch(`${localDataServerUrlFromEnv()}/auth/sign-out`, { method: "POST" });
    } catch {
      throw new CliError("The local data server is not answering. Run `starkeep start data-server` first.");
    }
    if (!res.ok) throw new CliError(`Sign-out failed (${res.status}).`);
    io.event({ type: "progress", message: "This computer no longer syncs." });
    io.event({ type: "result", ok: true });
  },
};

/** The admin half of `status`. */
export function adminStatusLine(): string {
  const status = adminSessionStatus();
  return status.signedIn
    ? `signed in${status.email ? ` as ${status.email}` : ""} until ${status.expiresAt} unless used`
    : "signed out";
}
