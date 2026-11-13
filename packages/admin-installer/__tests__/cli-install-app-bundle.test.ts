/**
 * `cli:install-app` refuses a web app whose manifest names a bundle command
 * off the approved list, before it authenticates or deploys anything.
 *
 * The CLI runs for real, as a child process, against a throwaway Starkeep
 * directory whose config names an account, and a local stand-in answers the
 * cloud data server's `/health`, so nothing before the check needs the
 * network. A check that ran after the deploy began would leave a
 * half-installed app behind; this one exits first.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@starkeep/protocol-primitives";
import { validateManifest } from "@starkeep/admin-manifest";
import { DEFAULT_APPS_DIR } from "../src/app-discovery.js";
import { manifestDigest } from "../src/manifest-approval.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A copy of core's example app's manifest, which offers a web app, with `bundle` set. */
function appWithBundle(bundle: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-bundle-app-"));
  const manifest = JSON.parse(
    readFileSync(join(DEFAULT_APPS_DIR, "starkeep.manifest.json"), "utf-8"),
  ) as Record<string, unknown>;
  writeFileSync(join(dir, "starkeep.manifest.json"), JSON.stringify({ ...manifest, bundle }));
  cpSync(join(DEFAULT_APPS_DIR, "package.json"), join(dir, "package.json"));
  return dir;
}

// Stands in for the cloud data server's `/health`, which the protocol check reads.
let health: Server;
let apiGatewayUrl: string;
beforeAll(async () => {
  health = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", protocolVersion: PROTOCOL_VERSION }));
  });
  await new Promise<void>((done) => health.listen(0, "127.0.0.1", done));
  apiGatewayUrl = `http://127.0.0.1:${(health.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => health.close(() => done())));

function runCli(
  appDir: string,
  extraArgs: string[] = [],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const starkeepDir = mkdtempSync(join(tmpdir(), "cli-bundle-sk-"));
  writeFileSync(
    join(starkeepDir, "config.json"),
    JSON.stringify({
      stackPrefix: "sktest",
      accountId: "123456789012",
      userPoolId: "us-east-1_abc",
      userPoolClientId: "client",
      identityPoolId: "us-east-1:pool",
      apiGatewayId: "gw",
      authorizerId: "auth",
      s3Bucket: "bucket",
      auroraEndpoint: "abc.dsql.us-east-1.on.aws",
      apiGatewayUrl,
      cloudAppsUserPoolClientId: "cloud-apps",
    }),
  );
  const child = spawn(
    "npx",
    [
      "tsx",
      "scripts/cli-install-app.ts",
      "example-app",
      "--non-interactive",
      "--web",
      "--app-dir",
      appDir,
      ...extraArgs,
    ],
    {
      cwd: PACKAGE_DIR,
      env: {
        ...process.env,
        STARKEEP_DIR: starkeepDir,
        STARKEEP_ENV_DIR: starkeepDir,
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "token",
      },
      timeout: 60_000,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((done) => child.on("close", (status) => done({ status, stdout, stderr })));
}

describe("cli:install-app and the bundle command", () => {
  it("refuses an unapproved bundle command before installing anything", async () => {
    const result = await runCli(appWithBundle({ command: "node", args: ["scripts/bundle.mjs"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "The manifest's bundle command `node scripts/bundle.mjs` is not approved",
    );
    // Nothing past the check ran: no install banner, no dependency install.
    expect(result.stdout).not.toContain("cloud install");
    expect(result.stdout).not.toContain("Installing dependencies");
  });
});

// Admin's cloud-install route checks the folder against the manifest the
// person approved and passes its digest. The CLI reads the manifest again
// later, so it refuses a folder that changed between the two reads.
describe("cli:install-app and the approved manifest's digest", () => {
  const bundle = { command: "node", args: ["scripts/bundle.mjs"] };

  it("refuses a folder whose manifest no longer matches the approved digest", async () => {
    const result = await runCli(appWithBundle(bundle), ["--manifest-digest", "0".repeat(64)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("changed after the manifest was approved");
    expect(result.stdout).not.toContain("cloud install");
  });

  it("goes on past the check when the folder still holds the approved manifest", async () => {
    const appDir = appWithBundle(bundle);
    const manifest = validateManifest(
      JSON.parse(readFileSync(join(appDir, "starkeep.manifest.json"), "utf-8")),
    ).manifest!;
    const result = await runCli(appDir, ["--manifest-digest", manifestDigest(manifest)]);
    expect(result.stderr).not.toContain("changed after the manifest was approved");
    // The next check, on the bundle command, is the one that stops it.
    expect(result.stderr).toContain(
      "The manifest's bundle command `node scripts/bundle.mjs` is not approved",
    );
  });
});
