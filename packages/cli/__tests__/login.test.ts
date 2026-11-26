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
let pool: FakePool;
let server: Server;
let main: typeof import("../src/main").main;
let session: typeof import("@starkeep/operator/admin-session");

beforeAll(async () => {
  pool = createFakePool();
  pool.addUser(ADMIN, "Temp-password-1", { groups: ["starkeep-admins"], temporary: true });
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
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

describe("starkeep login --admin", () => {
  it("signs in on the page and keeps the session admin-web shares", async () => {
    const run = await runWithBrowser(["login", "--admin", "--no-browser"], ADMIN);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Signed in as the admin (${ADMIN})`);
    expect(session.adminSessionStatus()).toMatchObject({ signedIn: true, email: ADMIN });
  });

  it("signs out at the pool and on disk", async () => {
    let out = "";
    const code = await main(["logout", "--admin"], {
      cwd: dir,
      interactive: false,
      stdout: (t) => (out += t),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out).toContain("Signed out as the admin.");
    expect(session.adminSessionStatus().signedIn).toBe(false);
    expect(pool.revoked.size).toBe(1);
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

  it("needs one of --admin and --sync", async () => {
    const code = await main(["login"], { cwd: dir, interactive: false, stdout: () => {}, stderr: () => {} });
    expect(code).toBe(2);
  });
});
