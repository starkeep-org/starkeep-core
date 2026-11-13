/**
 * `cli:install-app-local` installs an app on this computer from the
 * terminal, the way Admin's Install button does: it checks the local data
 * server, prints the consent words, asks for approval, and then registers
 * the app and writes its credentials file.
 *
 * The CLI runs for real, as a child process with no terminal, against a
 * throwaway Starkeep folder. A local stand-in answers the data server's
 * `/health` and `/admin/apps/install`, and records each install request.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cpSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_APPS_DIR, readFolderManifest } from "../src/app-discovery.js";
import { accessLead, categoriesOf, grantPermissions } from "../src/consent-text.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A copy of core's example app's manifest alone, so no dependency install runs. */
function exampleApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-local-app-"));
  cpSync(join(DEFAULT_APPS_DIR, "starkeep.manifest.json"), join(dir, "starkeep.manifest.json"));
  return dir;
}

let server: Server;
let dataServerUrl: string;
let healthy = true;
const installs: Array<{ manifest: { id: string }; sourceDir: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      res.statusCode = healthy ? 200 : 503;
      res.end(JSON.stringify({ status: healthy ? "ok" : "down" }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/apps/install") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body) as (typeof installs)[number];
        installs.push(parsed);
        res.end(JSON.stringify({ appId: parsed.manifest.id, hmacSecret: "secret" }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  dataServerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));
beforeEach(() => {
  healthy = true;
  installs.length = 0;
});

function runCli(
  appDir: string,
  flags: string[] = [],
): Promise<{ status: number | null; stdout: string; stderr: string; starkeepDir: string }> {
  const starkeepDir = mkdtempSync(join(tmpdir(), "cli-local-sk-"));
  const child = spawn("npx", ["tsx", "scripts/cli-install-app-local.ts", appDir, ...flags], {
    cwd: PACKAGE_DIR,
    env: {
      ...process.env,
      STARKEEP_DIR: starkeepDir,
      STARKEEP_ENV_DIR: starkeepDir,
      STARKEEP_LOCAL_DATA_SERVER_URL: dataServerUrl,
    },
    // No terminal: stdin is a pipe, as under a script.
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((done) =>
    child.on("close", (status) => done({ status, stdout, stderr, starkeepDir })),
  );
}

describe("cli:install-app-local", () => {
  it("prints the consent words, then with --yes registers the app and writes its credentials", async () => {
    const appDir = exampleApp();
    const result = await runCli(appDir, ["--yes"]);
    // stderr may carry npx's own config warnings, so it only explains a failure.
    expect(result.status, result.stderr).toBe(0);

    // The words come from consent-text.ts, which Admin's dialog also renders
    // (see admin-web's consent-cli-parity.test.tsx).
    const folder = readFolderManifest(appDir);
    if (folder.kind !== "valid") throw new Error("the example manifest is invalid");
    const manifest = folder.manifest;
    expect(result.stdout).toContain("Install Example App?");
    expect(result.stdout).toContain(accessLead(manifest));
    for (const g of manifest.infraRequirements?.fileAccess ?? []) {
      const { files, metadata } = grantPermissions(g);
      expect(result.stdout).toContain(
        `${categoriesOf(g.types)}: files ${files}, metadata ${metadata}`,
      );
    }

    expect(installs).toEqual([{ manifest: folder.raw, sourceDir: appDir }]);
    const creds = join(result.starkeepDir, "app-creds", "example-app.json");
    expect(JSON.parse(readFileSync(creds, "utf-8"))).toEqual({
      appId: "example-app",
      hmacSecret: "secret",
      dataServerUrl,
    });
    expect(statSync(creds).mode & 0o777).toBe(0o600);
  });

  it("refuses without --yes when no terminal can ask, and installs nothing", async () => {
    const result = await runCli(exampleApp());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No terminal to ask for approval. Pass --yes to approve.");
    // The person still saw what they would approve.
    expect(result.stdout).toContain("Install Example App?");
    expect(installs).toEqual([]);
    expect(existsSync(join(result.starkeepDir, "app-creds"))).toBe(false);
  });

  it("refuses before the consent words when the data server does not answer", async () => {
    healthy = false;
    const result = await runCli(exampleApp(), ["--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`The local data server at ${dataServerUrl} is not answering.`);
    expect(result.stdout).not.toContain("Install Example App?");
    expect(installs).toEqual([]);
  });
});
