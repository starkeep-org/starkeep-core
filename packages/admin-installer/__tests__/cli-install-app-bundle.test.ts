/**
 * `cli:install-app` refuses a web app whose manifest names a bundle command
 * off the approved list, before it authenticates or deploys anything.
 *
 * The CLI runs for real, as a child process, against a throwaway Starkeep
 * directory whose config names an account, so nothing before the check needs
 * the network. A check that ran after the deploy began would leave a
 * half-installed app behind; this one exits first.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_APPS_DIR } from "../src/app-discovery.js";

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

function runCli(appDir: string) {
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
      cloudAppsUserPoolClientId: "cloud-apps",
    }),
  );
  return spawnSync(
    "npx",
    [
      "tsx",
      "scripts/cli-install-app.ts",
      "example-app",
      "--non-interactive",
      "--web",
      "--app-dir",
      appDir,
    ],
    {
      cwd: PACKAGE_DIR,
      encoding: "utf-8",
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
}

describe("cli:install-app and the bundle command", () => {
  it("refuses an unapproved bundle command before installing anything", () => {
    const result = runCli(appWithBundle({ command: "node", args: ["scripts/bundle.mjs"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "The manifest's bundle command `node scripts/bundle.mjs` is not approved",
    );
    // Nothing past the check ran: no install banner, no dependency install.
    expect(result.stdout).not.toContain("cloud install");
    expect(result.stdout).not.toContain("Installing dependencies");
  });
});
