/**
 * A throwaway Starkeep folder and an operation context whose AWS calls are
 * stand-ins, for the operation tests.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, expect } from "vitest";
import { DEFAULT_APPS_DIR } from "../../src/app-discovery.js";
import type { OperationContext, OperationOverrides } from "../../src/operations/context.js";
import type { OperationEvent } from "../../src/operations/events.js";

export const CREDS = { accessKeyId: "AKIA", secretAccessKey: "secret", sessionToken: "token" };

/** A config the cloud data server install has completed. */
export const INSTALLED_CONFIG = {
  stackPrefix: "sktest",
  accountId: "123456789012",
  userPoolId: "us-east-1_abc",
  userPoolClientId: "admin-client",
  identityPoolId: "us-east-1:pool",
  deviceUserPoolClientId: "device-client",
  cognitoDomain: "sktest.auth.us-east-1.amazoncognito.com",
  deploymentName: "Home",
  apiGatewayId: "gw",
  apiGatewayUrl: "https://gw.example",
  publicBaseUrl: "https://d123.cloudfront.net",
  authorizerId: "auth",
  s3Bucket: "bucket",
  auroraEndpoint: "abc.dsql.us-east-1.on.aws",
  apiGatewayExecutionArn: "arn:aws:execute-api:us-east-1:123456789012:gw",
  cloudAppsUserPoolClientId: "cloud-apps",
  mobileAppsUserPoolClientId: "mobile-apps",
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function starkeepDirWith(config: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "op-test-sk-"));
  dirs.push(dir);
  if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

export function readConfigIn(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
}

/** A copy of core's example app, with `patch` merged into its manifest. */
export function exampleApp(patch: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "op-test-app-"));
  dirs.push(dir);
  const manifest = JSON.parse(
    readFileSync(join(DEFAULT_APPS_DIR, "starkeep.manifest.json"), "utf-8"),
  ) as Record<string, unknown>;
  writeFileSync(join(dir, "starkeep.manifest.json"), JSON.stringify({ ...manifest, ...patch }));
  cpSync(join(DEFAULT_APPS_DIR, "package.json"), join(dir, "package.json"));
  return dir;
}

export interface TestContext {
  ctx: OperationContext;
  events: OperationEvent[];
  emit: (e: OperationEvent) => void;
  lanes: string[];
  progress(): string;
}

export function testContext(
  starkeepDir: string,
  overrides: OperationOverrides = {},
  options: { signedIn?: boolean } = {},
): TestContext {
  const events: OperationEvent[] = [];
  const lanes: string[] = [];
  return {
    events,
    lanes,
    emit: (e) => void events.push(e),
    progress: () =>
      events
        .filter((e): e is Extract<OperationEvent, { type: "progress" }> => e.type === "progress")
        .map((e) => e.message)
        .join("\n"),
    ctx: {
      starkeepDir,
      adminLane: async (region) => {
        lanes.push(region);
        if (options.signedIn === false) {
          const { OperationError } = await import("../../src/operations/errors.js");
          throw new OperationError("NOT_SIGNED_IN", "Run `starkeep login --admin` first.");
        }
        return CREDS;
      },
      overrides: {
        sts: { send: async () => ({ Account: "999999999999" }) } as never,
        platformRecord: { read: async () => null, write: async () => {} },
        deployedAppSource: async () => null,
        ...overrides,
      },
    },
  };
}

/** An `expect(...).rejects` matcher input for an OperationError with `code`. */
export function withCode(code: string) {
  return expect.objectContaining({ name: "OperationError", code });
}

/**
 * A git repository shaped like a platform checkout, with `commit` to add a
 * commit and `branch` to work on another branch.
 */
export function platformRepo(): {
  dir: string;
  git: (...args: string[]) => string;
  commit: (file: string, text: string) => string;
} {
  const dir = mkdtempSync(join(tmpdir(), "op-test-repo-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  const commit = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
    git("add", file);
    git("commit", "-q", "-m", `edit ${file}`);
    return git("rev-parse", "HEAD");
  };
  commit("pnpm-lock.yaml", "lock");
  commit("packages/admin-installer/index.ts", "one");
  return { dir, git, commit };
}
