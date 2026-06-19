import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand, ParameterNotFound } from "@aws-sdk/client-ssm";
import {
  loadAppCredentials,
  appCredentialsPath,
  clearAppCredentialsCache,
} from "../src/credentials.js";

const ssmMock = mockClient(SSMClient);

let dir: string;
const ENV_KEYS = [
  "STARKEEP_DIR",
  "STARKEEP_APP_CLIENT_MODE",
  "STARKEEP_CLOUD_DATA_BASE",
  "STARKEEP_APP_CREDS_PARAMETER_NAME",
  "STACK_PREFIX",
  "STARKEEP_STACK_PREFIX",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "app-client-test-"));
  process.env.STARKEEP_DIR = dir;
  clearAppCredentialsCache();
  ssmMock.reset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  clearAppCredentialsCache();
});

function writeCreds(appId: string, content: unknown): void {
  mkdirSync(join(dir, "app-creds"), { recursive: true });
  writeFileSync(
    join(dir, "app-creds", `${appId}.json`),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

describe("local-mode credentials", () => {
  it("loads creds written at install time", async () => {
    writeCreds("photos", { appId: "photos", hmacSecret: "s3cret", dataServerUrl: "http://x:1" });
    const creds = await loadAppCredentials("photos");
    expect(creds).toEqual({ appId: "photos", hmacSecret: "s3cret", dataServerUrl: "http://x:1" });
    expect(appCredentialsPath("photos")).toBe(join(dir, "app-creds", "photos.json"));
  });

  it("defaults dataServerUrl to the local server when absent", async () => {
    writeCreds("photos", { appId: "photos", hmacSecret: "s3cret" });
    expect((await loadAppCredentials("photos"))?.dataServerUrl).toBe("http://127.0.0.1:9820");
  });

  it("returns null for a missing creds file", async () => {
    expect(await loadAppCredentials("not-installed")).toBeNull();
  });

  it("returns null for malformed JSON and for incomplete creds", async () => {
    writeCreds("broken", "{not json");
    expect(await loadAppCredentials("broken")).toBeNull();
    writeCreds("partial", { appId: "partial" });
    expect(await loadAppCredentials("partial")).toBeNull();
  });

  it("caches per process until cleared", async () => {
    writeCreds("photos", { appId: "photos", hmacSecret: "v1" });
    expect((await loadAppCredentials("photos"))?.hmacSecret).toBe("v1");
    writeCreds("photos", { appId: "photos", hmacSecret: "v2" });
    expect((await loadAppCredentials("photos"))?.hmacSecret).toBe("v1");
    clearAppCredentialsCache("photos");
    expect((await loadAppCredentials("photos"))?.hmacSecret).toBe("v2");
  });
});

describe("cloud-mode credentials", () => {
  beforeEach(() => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    process.env.STARKEEP_CLOUD_DATA_BASE = "https://api.example.com/";
    process.env.STACK_PREFIX = "teststack";
  });

  it("ignores any local creds file and fetches from SSM in cloud mode", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ appId: "photos", hmacSecret: "from-ssm" }) },
    });
    // A stale local file must never be used in cloud mode.
    writeCreds("photos", { appId: "photos", hmacSecret: "local-file-ignored" });
    expect((await loadAppCredentials("photos"))?.hmacSecret).toBe("from-ssm");
  });

  it("fetches the secret from SSM and derives the app URL", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ appId: "photos", hmacSecret: "from-ssm" }) },
    });
    const creds = await loadAppCredentials("photos");
    expect(creds).toEqual({
      appId: "photos",
      hmacSecret: "from-ssm",
      dataServerUrl: "https://api.example.com/apps/photos",
    });
    const call = ssmMock.commandCalls(GetParameterCommand)[0];
    expect(call.args[0].input).toEqual({
      Name: "/teststack/app-creds/photos",
      WithDecryption: true,
    });
  });

  it("prefers an explicit parameter name over the stack-prefix convention", async () => {
    process.env.STARKEEP_APP_CREDS_PARAMETER_NAME = "/custom/param";
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ appId: "photos", hmacSecret: "x" }) },
    });
    await loadAppCredentials("photos");
    expect(ssmMock.commandCalls(GetParameterCommand)[0].args[0].input.Name).toBe("/custom/param");
  });

  it("returns null when the parameter does not exist", async () => {
    ssmMock.on(GetParameterCommand).rejects(
      new ParameterNotFound({ message: "no such parameter", $metadata: {} }),
    );
    expect(await loadAppCredentials("photos")).toBeNull();
  });

  it("throws when cloud mode is missing its required env", async () => {
    delete process.env.STARKEEP_CLOUD_DATA_BASE;
    await expect(loadAppCredentials("photos")).rejects.toThrow(
      /STARKEEP_CLOUD_DATA_BASE/,
    );
  });

  it("caches the SSM result per process", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ appId: "photos", hmacSecret: "x" }) },
    });
    await loadAppCredentials("photos");
    await loadAppCredentials("photos");
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });
});
