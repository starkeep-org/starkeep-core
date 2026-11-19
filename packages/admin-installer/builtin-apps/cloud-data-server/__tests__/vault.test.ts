/**
 * The vault module: names, size limits, and the calls it makes, with no
 * version label ever written.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  LabelParameterVersionCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import {
  MAX_SECRET_BYTES,
  deleteSecret,
  getSecret,
  listSecrets,
  putSecret,
  secretValueRefusal,
  vaultParameterName,
  vaultPath,
} from "../src/vault.js";

const ssmMock = mockClient(SSMClient);
const t = { ssm: new SSMClient({}), stackPrefix: "sk", appId: "exercise", userId: "user-1" };

beforeEach(() => ssmMock.reset());

describe("names", () => {
  it("puts a user's secret under app-creds/_vault/<app>/<user>", () => {
    expect(vaultParameterName("sk", "exercise", "user-1", "peloton")).toBe(
      "/sk/app-creds/_vault/exercise/user-1/peloton",
    );
    expect(vaultPath("sk", "exercise", "user-1")).toBe("/sk/app-creds/_vault/exercise/user-1");
  });

  it("refuses a malformed name", () => {
    for (const bad of ["", "Peloton", "-x", "a/b", "../x", "a".repeat(65), "a b"]) {
      expect(() => vaultParameterName("sk", "exercise", "user-1", bad), bad).toThrow();
    }
    expect(() => vaultParameterName("sk", "exercise", "user-1", "a".repeat(64))).not.toThrow();
    expect(() => vaultParameterName("sk", "exercise", "user-1", "garmin_key-2")).not.toThrow();
  });
});

describe("values", () => {
  it("holds a non-empty string of at most the standard tier's 4,096 bytes", () => {
    expect(secretValueRefusal("x")).toBeNull();
    expect(secretValueRefusal("x".repeat(MAX_SECRET_BYTES))).toBeNull();
    expect(secretValueRefusal("x".repeat(MAX_SECRET_BYTES + 1))).not.toBeNull();
    // Bytes, not characters.
    expect(secretValueRefusal("é".repeat(MAX_SECRET_BYTES / 2 + 1))).not.toBeNull();
    expect(secretValueRefusal("")).not.toBeNull();
    expect(secretValueRefusal(42)).not.toBeNull();
  });
});

describe("calls", () => {
  it("writes a standard-tier SecureString, overwriting", async () => {
    ssmMock.on(PutParameterCommand).resolves({ Version: 7 });
    await putSecret(t, "peloton", "rt-1");
    expect(ssmMock.commandCalls(PutParameterCommand)[0]!.args[0].input).toEqual({
      Name: "/sk/app-creds/_vault/exercise/user-1/peloton",
      Value: "rt-1",
      Type: "SecureString",
      Tier: "Standard",
      Overwrite: true,
    });
  });

  it("reads with decryption, and answers null for a missing secret", async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({ Parameter: { Value: "rt-1" } });
    expect(await getSecret(t, "peloton")).toBe("rt-1");
    expect(ssmMock.commandCalls(GetParameterCommand)[0]!.args[0].input.WithDecryption).toBe(true);
    ssmMock
      .on(GetParameterCommand)
      .rejects(new ParameterNotFound({ message: "gone", $metadata: {} }));
    expect(await getSecret(t, "peloton")).toBeNull();
  });

  it("lists names and times across pages, without decryption", async () => {
    const at = new Date("2026-11-19T12:00:00Z");
    ssmMock
      .on(GetParametersByPathCommand)
      .resolvesOnce({
        Parameters: [
          { Name: "/sk/app-creds/_vault/exercise/user-1/peloton", LastModifiedDate: at },
        ],
        NextToken: "n",
      })
      .resolvesOnce({
        Parameters: [{ Name: "/sk/app-creds/_vault/exercise/user-1/garmin", LastModifiedDate: at }],
      });
    expect(await listSecrets(t)).toEqual([
      { name: "garmin", updatedAt: at.getTime() },
      { name: "peloton", updatedAt: at.getTime() },
    ]);
    const calls = ssmMock.commandCalls(GetParametersByPathCommand);
    expect(calls[0]!.args[0].input).toMatchObject({
      Path: "/sk/app-creds/_vault/exercise/user-1",
      Recursive: false,
      WithDecryption: false,
    });
    expect(calls[1]!.args[0].input.NextToken).toBe("n");
  });

  it("deletes, and treats a missing secret as deleted", async () => {
    ssmMock
      .on(DeleteParameterCommand)
      .rejects(new ParameterNotFound({ message: "gone", $metadata: {} }));
    await expect(deleteSecret(t, "peloton")).resolves.toBeUndefined();
    expect(ssmMock.commandCalls(DeleteParameterCommand)[0]!.args[0].input.Name).toBe(
      "/sk/app-creds/_vault/exercise/user-1/peloton",
    );
  });

  it("never labels a version, which would stop rotation at 100 versions", async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    for (let i = 0; i < 3; i++) await putSecret(t, "peloton", `rt-${i}`);
    expect(ssmMock.commandCalls(LabelParameterVersionCommand)).toHaveLength(0);
    // Nor anywhere else in the module.
    const source = readFileSync(fileURLToPath(new URL("../src/vault.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/LabelParameterVersion/);
  });
});
