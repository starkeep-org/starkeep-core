/**
 * An app's HMAC secret in SSM: created once at cloud install, never rotated by
 * a reinstall. And the CloudFront signing config, which the broker reads to
 * keep a visit's sign-in and signed URLs on the host the visit used.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, ParameterAlreadyExists, PutParameterCommand } from "@aws-sdk/client-ssm";
import { ensureAppCredsParameter, putCloudFrontSigningParameter } from "../src/app-creds.js";

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

describe("putCloudFrontSigningParameter", () => {
  const signing = {
    stackPrefix: "sk",
    keyPairId: "K1",
    domain: "photos.example.com",
    hosts: ["photos.example.com", "d1.cloudfront.net"],
    privateKey: "-----BEGIN PRIVATE KEY-----",
    region: "us-east-2",
    awsCreds,
  };

  it("stores every host the distribution answers on, beside the canonical domain", async () => {
    ssm.on(PutParameterCommand).resolves({});
    await putCloudFrontSigningParameter(signing);
    const [input] = putInputs();
    expect(input!.Name).toBe("/sk/app-creds/_cloudfront-signing");
    expect(JSON.parse(input!.Value!)).toEqual({
      keyPairId: "K1",
      domain: "photos.example.com",
      hosts: ["photos.example.com", "d1.cloudfront.net"],
      privateKey: "-----BEGIN PRIVATE KEY-----",
    });
  });

  it("carries the hosts into the overwrite of an existing parameter", async () => {
    ssm
      .on(PutParameterCommand)
      .rejectsOnce(new ParameterAlreadyExists({ message: "exists", $metadata: {} }))
      .resolves({});
    await putCloudFrontSigningParameter(signing);
    const overwrite = putInputs()[1]!;
    expect(overwrite.Overwrite).toBe(true);
    expect(JSON.parse(overwrite.Value!).hosts).toEqual(["photos.example.com", "d1.cloudfront.net"]);
  });
});
