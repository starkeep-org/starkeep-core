/**
 * `cli:install-app` builds its `installApp` input with `cloudInstallInput`.
 * The input must name the app's folder as the web app's source, because the
 * install records that folder's fingerprint and Admin's cloud list compares
 * it with the folder's fingerprint now (see orchestrator.test.ts for the
 * recording). An input without it reads as behind after every deploy.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "@starkeep/admin-manifest";
import { cloudInstallInput, type StarkeepCliConfig } from "../src/app-cli-config.js";
import { DEFAULT_APPS_DIR } from "../src/app-discovery.js";

const manifest = validateManifest(
  JSON.parse(readFileSync(join(DEFAULT_APPS_DIR, "starkeep.manifest.json"), "utf-8")),
).manifest!;

const config: StarkeepCliConfig = {
  stackPrefix: "sk",
  userPoolId: "us-east-1_pool",
  userPoolClientId: "client",
  identityPoolId: "us-east-1:pool",
  apiGatewayId: "gw",
  apiGatewayUrl: "https://gw.example",
  authorizerId: "auth",
  sessionAuthorizerId: "session-auth",
  s3Bucket: "files",
  auroraEndpoint: "abc.dsql.us-east-1.on.aws",
  mobileAppsUserPoolClientId: "mobile",
};

const registryCredentials = { accessKeyId: "AKIA", secretAccessKey: "secret", sessionToken: "t" };

function input(overrides: Partial<StarkeepCliConfig> = {}) {
  return cloudInstallInput({
    appId: "example-app",
    appDir: "/apps/example-app",
    manifest,
    surfaces: ["web"],
    zipBuffer: Buffer.from("zip"),
    config: { ...config, ...overrides },
    region: "us-east-1",
    accountId: "123456789012",
    registryCredentials,
  });
}

describe("cloudInstallInput", () => {
  it("names the app's folder as the web app's source", () => {
    expect(input().webSourceDir).toBe("/apps/example-app");
  });

  it("carries the app, the bundle and the deployment the config describes", () => {
    expect(input()).toMatchObject({
      appId: "example-app",
      manifest,
      surfaces: ["web"],
      zipBuffer: Buffer.from("zip"),
      version: manifest.version,
      registryCredentials,
      config: {
        stackPrefix: "sk",
        region: "us-east-1",
        accountId: "123456789012",
        dsqlHostname: "abc.dsql.us-east-1.on.aws",
        filesBucket: "files",
        apiGatewayId: "gw",
        apiGatewayUrl: "https://gw.example",
        apiGatewayExecutionArn: "arn:aws:execute-api:us-east-1:123456789012:gw",
        authorizerId: "auth",
        sessionAuthorizerId: "session-auth",
        managerRoleArn: "arn:aws:iam::123456789012:role/sk-manager-role",
        artifactsBucket: "sk-artifacts-123456789012-us-east-1",
        pulumiStateBucket: "sk-pulumi-state-123456789012-us-east-1",
        mobileSignIn: { userPoolId: "us-east-1_pool", mobileAppsClientId: "mobile" },
      },
    });
  });

  it("leaves out mobile sign-in for a deployment without the mobile-apps client", () => {
    expect(input({ mobileAppsUserPoolClientId: undefined }).config.mobileSignIn).toBeUndefined();
  });

  it("refuses a config without the cloud data server's fields", () => {
    expect(() => input({ auroraEndpoint: undefined })).toThrow(/missing required fields/);
  });
});
