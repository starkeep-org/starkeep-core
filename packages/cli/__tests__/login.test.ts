/**
 * `starkeep login --admin` and `logout --admin` against the fake pool. The test
 * plays the browser: it reads the sign-in address the CLI prints, has the pool
 * issue a code as the managed login page would, and follows the redirect to
 * the CLI's loopback listener.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFakePool,
  FAKE_DEVICE_CLIENT_ID,
  FAKE_POOL_ID,
  type FakePool,
} from "@starkeep/testkit";

const dir = mkdtempSync(join(tmpdir(), "cli-login-"));
process.env.STARKEEP_DIR = dir;
process.env.STARKEEP_CLI_CALLBACK_PORT = String(46_000 + Math.floor(Math.random() * 1_000));

const ADMIN = "admin@example.com";
const OTHER_ADMIN = "second@example.com";
const MEMBER = "member@example.com";
let pool: FakePool;
/** What the fake managed login page answers at /oauth2/authorize. */
let authorizeAnswer: "login" | "redirect_mismatch" = "login";
/** The stand-in local data server's sync state, or null when it does not answer. */
let sync: { state: string; email: string | null; message?: string } | null = null;
const syncCalls: string[] = [];
let server: Server;
let cloudBase = "";
let main: typeof import("../src/main").main;
let session: typeof import("@starkeep/operator/admin-session");

beforeAll(async () => {
  pool = createFakePool();
  pool.addUser(ADMIN, "Temp-password-1", { groups: ["starkeep-admins"], temporary: true });
  pool.addUser(OTHER_ADMIN, "Temp-password-1", { groups: ["starkeep-admins"], temporary: true });
  pool.addUser(MEMBER, "Temp-password-1", { groups: ["starkeep-users"], temporary: true });
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      if (url.pathname === "/oauth2/authorize") {
        const to =
          authorizeAnswer === "login" ? `/login${url.search}` : `/error?error=${authorizeAnswer}`;
        res.writeHead(302, { Location: to });
        res.end();
        return;
      }
      if (url.pathname === "/auth/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            region: "us-east-1",
            userPoolId: FAKE_POOL_ID,
            deviceClientId: FAKE_DEVICE_CLIENT_ID,
            cognitoDomain: "fake-pool.auth.us-east-1.amazoncognito.com",
          }),
        );
        return;
      }
      if (url.pathname.startsWith("/data-server/")) {
        const route = url.pathname.slice("/data-server".length);
        syncCalls.push(route);
        if (!sync) {
          res.writeHead(503);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        if (route === "/auth/login") {
          res.end(JSON.stringify({ email: MEMBER }));
        } else {
          res.end(JSON.stringify(route === "/auth/status" ? sync : {}));
        }
        return;
      }
      const answer =
        req.url === "/oauth2/token"
          ? pool.redeemCode(new URLSearchParams(body))
          : pool.handle(
              String(req.headers["x-amz-target"]).replace("AWSCognitoIdentityProviderService.", ""),
              JSON.parse(body) as Record<string, unknown>,
            );
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.STARKEEP_COGNITO_ENDPOINT = `${base}/cognito/`;
  process.env.STARKEEP_COGNITO_TOKEN_ENDPOINT = `${base}/oauth2/token`;
  process.env.STARKEEP_COGNITO_LOGIN_BASE = base;
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = `${base}/data-server`;
  cloudBase = base;
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      userPoolId: FAKE_POOL_ID,
      userPoolClientId: FAKE_DEVICE_CLIENT_ID,
      identityPoolId: "us-east-1:pool",
      cognitoDomain: "fake-pool.auth.us-east-1.amazoncognito.com",
    }),
  );
  ({ main } = await import("../src/main"));
  session = await import("@starkeep/operator/admin-session");
});

afterAll(() => server.close());

/** Run the CLI, answering its sign-in page as a person in a browser would. */
async function runWithBrowser(argv: string[], email: string) {
  let out = "";
  let err = "";
  const done = main(argv, {
    cwd: dir,
    interactive: false,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  // Wait for the address the CLI prints, then "sign in" there.
  let page: URL | null = null;
  for (let i = 0; i < 200 && !page; i++) {
    const match = /https:\/\/\S+\/oauth2\/authorize\S*/.exec(out + err);
    if (match) page = new URL(match[0].replace(/\\n.*$/, "").replace(/"$/, ""));
    else await new Promise((r) => setTimeout(r, 25));
  }
  expect(page, "the CLI printed no sign-in address").not.toBeNull();
  const redirectUri = page!.searchParams.get("redirect_uri")!;
  const code = pool.issueCode(email, {
    codeChallenge: page!.searchParams.get("code_challenge")!,
    redirectUri,
  });
  const back = await fetch(`${redirectUri}?code=${code}&state=${page!.searchParams.get("state")}`);
  expect(await back.text()).toContain("You can close this tab");
  return { code: await done, out, err };
}

async function run(argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    cwd: dir,
    interactive: false,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

function writeConfig(extra: Record<string, unknown>): void {
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      userPoolId: FAKE_POOL_ID,
      userPoolClientId: FAKE_DEVICE_CLIENT_ID,
      identityPoolId: "us-east-1:pool",
      ...extra,
    }),
  );
}

describe("starkeep login --admin", () => {
  it("signs in on the page, asking for the password, and keeps the session admin-web shares (ACCESS-204)", async () => {
    const run = await runWithBrowser(["login", "--admin", "--no-browser"], ADMIN);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(
      `Signed in as the admin (${ADMIN}). admin-web uses the same sign-in.`,
    );
    expect(session.adminSessionStatus()).toMatchObject({ signedIn: true, email: ADMIN });
    const page = new URL(/https:\/\/\S+\/oauth2\/authorize\S*/.exec(run.out + run.err)![0]);
    expect(page.searchParams.get("prompt")).toBe("login");
  });

  it("says whose session a sign-in with another admin account replaces", async () => {
    const run = await runWithBrowser(["login", "--admin", "--no-browser"], OTHER_ADMIN);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Signed in as the admin (${OTHER_ADMIN}).`);
    expect(run.out).toContain(`This replaces ${ADMIN}'s admin session on this computer.`);
    expect(session.adminSessionStatus()).toMatchObject({ signedIn: true, email: OTHER_ADMIN });
  });

  it("refuses an account without admin rights, and opens no session (ACCESS-200)", async () => {
    await run(["logout", "--admin"]);
    const signIn = await runWithBrowser(["login", "--admin", "--no-browser"], MEMBER);
    expect(signIn.code).toBe(1);
    expect(signIn.err).toContain(
      "This account has no admin rights on this cloud. Ask an admin to make you one.",
    );
    expect(session.adminSessionStatus().signedIn).toBe(false);
  });

  it("says the time ran out when no sign-in arrives (ACCESS-205)", async () => {
    process.env.STARKEEP_SIGN_IN_TIMEOUT_MS = "300";
    try {
      const timedOut = await run(["login", "--admin", "--no-browser"]);
      expect(timedOut.code).toBe(1);
      expect(timedOut.err).toContain("No sign-in arrived before the time ran out.");
      expect(session.adminSessionStatus().signedIn).toBe(false);
    } finally {
      delete process.env.STARKEEP_SIGN_IN_TIMEOUT_MS;
    }
  });

  it("names the old bootstrap stack when the page refuses the sign-in, before anyone waits", async () => {
    authorizeAnswer = "redirect_mismatch";
    try {
      const refused = await run(["login", "--admin", "--no-browser"]);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(
        "The managed login page refused this sign-in (redirect_mismatch).",
      );
      expect(refused.err).toContain("scripts/update-bootstrap.sh --apply");
      expect(refused.out + refused.err).not.toContain("Sign in on this page");
    } finally {
      authorizeAnswer = "login";
    }
  });

  it("asks for the stack outputs when the configuration names no sign-in page (ACCESS-210)", async () => {
    writeConfig({});
    try {
      const missing = await run(["login", "--admin"]);
      expect(missing.code).toBe(1);
      expect(missing.err).toContain(
        "The admin sign-in needs the CognitoDomain output, which admin-web's Stack outputs step saves.",
      );
    } finally {
      writeConfig({ cognitoDomain: "fake-pool.auth.us-east-1.amazoncognito.com" });
    }
  });

  it("shows the admin session and when it ends in the status (ACCESS-197)", async () => {
    const signedIn = await runWithBrowser(["login", "--admin", "--no-browser"], ADMIN);
    expect(signedIn.code, signedIn.err).toBe(0);
    const status = session.adminSessionStatus();
    writeConfig({
      cognitoDomain: "fake-pool.auth.us-east-1.amazoncognito.com",
      cloudUrl: "https://cloud.example.com",
    });
    const shown = await run(["status"]);
    expect(shown.out).toContain(`ADMIN     signed in as ${ADMIN} until ${status.expiresAt}`);
  });

  it("signs out at the pool and on disk", async () => {
    let out = "";
    const revokedBefore = pool.revoked.size;
    const code = await main(["logout", "--admin"], {
      cwd: dir,
      interactive: false,
      stdout: (t) => (out += t),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out).toContain("Signed out as the admin.");
    expect(session.adminSessionStatus().signedIn).toBe(false);
    expect(pool.revoked.size).toBe(revokedBefore + 1);
  });

  it("says the session ended here when the pool cannot confirm the revocation", async () => {
    const signedIn = await runWithBrowser(["login", "--admin", "--no-browser"], ADMIN);
    expect(signedIn.code, signedIn.err).toBe(0);
    const reachable = process.env.STARKEEP_COGNITO_ENDPOINT;
    // Nothing listens on port 1, so the revocation cannot reach the pool.
    process.env.STARKEEP_COGNITO_ENDPOINT = "http://127.0.0.1:1/cognito/";
    let out = "";
    try {
      const code = await main(["logout", "--admin"], {
        cwd: dir,
        interactive: false,
        stdout: (t) => (out += t),
        stderr: () => {},
      });
      expect(code).toBe(0);
    } finally {
      process.env.STARKEEP_COGNITO_ENDPOINT = reachable;
    }
    expect(out).not.toContain("No admin session was open here.");
    expect(out).toContain("Signed out as the admin on this computer.");
    expect(session.adminSessionStatus().signedIn).toBe(false);
  });

  it("needs one of --admin and --sync (ACCESS-214)", async () => {
    const code = await main(["login"], {
      cwd: dir,
      interactive: false,
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(2);
  });
});

describe("starkeep login --sync", () => {
  it("says to join a cloud first, and opens no browser (ACCESS-213)", async () => {
    const r = await run(["login", "--sync", "--no-browser"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "This computer has joined no cloud. Join one with `starkeep setup --join <address>` or in admin-web.",
    );
    expect(r.out + r.err).not.toContain("oauth2/authorize");
  });

  it("refuses before the browser opens when the data server is stopped", async () => {
    writeConfig({
      cognitoDomain: "fake-pool.auth.us-east-1.amazoncognito.com",
      apiGatewayUrl: cloudBase,
    });
    sync = null;
    const r = await run(["login", "--sync", "--no-browser"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "The local data server is not answering. Run `starkeep start data-server` first.",
    );
    expect(r.out + r.err).not.toContain("oauth2/authorize");
  });

  it("signs the computer in through the data server (ACCESS-211)", async () => {
    sync = { state: "signed-out", email: null };
    syncCalls.length = 0;
    const pending = runWithBrowser(["login", "--sync", "--no-browser"], MEMBER);
    // The stand-in data server reports the session once the sign-in lands.
    const r = await pending.then(async (x) => x);
    expect(syncCalls).toContain("/auth/login");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`This computer syncs as ${MEMBER}.`);
  });

  it("says when the library belongs to another account", async () => {
    sync = {
      state: "bound-elsewhere",
      email: MEMBER,
      message: "The library belongs to owner@example.com.",
    };
    const r = await runWithBrowser(["login", "--sync", "--no-browser"], MEMBER);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `Signed in as ${MEMBER}, but this computer's library belongs to another account, so it does not sync. The library belongs to owner@example.com.`,
    );
  });
});

describe("starkeep logout --sync", () => {
  it("signs a syncing computer out (ACCESS-212)", async () => {
    sync = { state: "signed-in", email: MEMBER };
    syncCalls.length = 0;
    const r = await run(["logout", "--sync"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("This computer no longer syncs.");
    expect(syncCalls).toContain("/auth/sign-out");
  });

  it("says a computer that does not sync was not signed in", async () => {
    sync = { state: "signed-out", email: null };
    syncCalls.length = 0;
    const r = await run(["logout", "--sync"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("This computer was not signed in to sync.");
    expect(syncCalls).not.toContain("/auth/sign-out");
  });
});
