/**
 * An app's HMAC secret in SSM: created once at cloud install, never rotated by
 * a reinstall.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, ParameterAlreadyExists, PutParameterCommand } from "@aws-sdk/client-ssm";
import { ensureAppCredsParameter } from "../src/app-creds.js";

const ssm = mockClient(SSMClient);
const awsCreds = {
  accessKeyId: "A",
  secretAccessKey: "S",
  sessionToken: "T",
  expiration: new Date(),
};
const base = { stackPrefix: "sk", appId: "photos", region: "us-east-2", awsCreds };

beforeEach(() => ssm.reset());

function putInputs() {
  return ssm.commandCalls(PutParameterCommand).map((c) => c.args[0].input);
}

describe("ensureAppCredsParameter", () => {
  it("creates a tagged SecureString holding a fresh secret, and says it created one", async () => {
    ssm.on(PutParameterCommand).resolves({});
    expect(await ensureAppCredsParameter(base)).toBe(true);

    const [input] = putInputs();
    expect(input).toMatchObject({
      Name: "/sk/app-creds/photos",
      Type: "SecureString",
      Tags: [
        { Key: "starkeep:appId", Value: "photos" },
        { Key: "starkeep:managed", Value: "true" },
      ],
    });
    // Create-only: an Overwrite would rotate a live secret.
    expect(input!.Overwrite).toBeUndefined();
    const value = JSON.parse(input!.Value!) as { appId: string; hmacSecret: string };
    expect(value.appId).toBe("photos");
    expect(value.hmacSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps an existing secret: no second put, and says it created nothing", async () => {
    ssm
      .on(PutParameterCommand)
      .rejects(new ParameterAlreadyExists({ message: "exists", $metadata: {} }));
    expect(await ensureAppCredsParameter(base)).toBe(false);
    expect(putInputs()).toHaveLength(1);
  });

  it("propagates any other failure", async () => {
    ssm.on(PutParameterCommand).rejects(new Error("AccessDenied"));
    await expect(ensureAppCredsParameter(base)).rejects.toThrow("AccessDenied");
  });

  it("mints a different secret on each create", async () => {
    ssm.on(PutParameterCommand).resolves({});
    await ensureAppCredsParameter(base);
    await ensureAppCredsParameter({ ...base, appId: "memo" });
    const [a, b] = putInputs().map(
      (i) => (JSON.parse(i.Value!) as { hmacSecret: string }).hmacSecret,
    );
    expect(a).not.toBe(b);
  });
});
