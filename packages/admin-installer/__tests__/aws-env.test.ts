/**
 * Installer children run with the wizard's credentials and nothing the shell
 * held, and an app's build step runs with no AWS credentials at all (#134).
 */
import { afterEach, describe, expect, it } from "vitest";
import { installerEnv, useOnlyAwsCredentials, withoutAwsVariables } from "../src/aws-env";

const creds = { accessKeyId: "AKIAWIZARD", secretAccessKey: "wizard-secret", sessionToken: "tok" };

// A shell that started admin-web with a personal profile and a stray key pair.
const parent: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/op",
  AWS_PROFILE: "personal-sso",
  AWS_DEFAULT_PROFILE: "personal-sso",
  AWS_ACCESS_KEY_ID: "AKIASHELL",
  AWS_SECRET_ACCESS_KEY: "shell-secret",
  AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/token",
  AWS_DEFAULT_REGION: "eu-west-1",
};

describe("withoutAwsVariables", () => {
  it("removes every AWS_ variable and keeps the rest", () => {
    expect(withoutAwsVariables(parent)).toEqual({ PATH: "/usr/bin", HOME: "/home/op" });
  });
});

describe("installerEnv", () => {
  it("hands the child only the wizard's credentials and region", () => {
    const env = installerEnv(creds, "us-east-2", parent);
    expect(Object.keys(env).filter((k) => k.startsWith("AWS_"))).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_REGION",
    ]);
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAWIZARD");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("wizard-secret");
    expect(env.AWS_REGION).toBe("us-east-2");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("useOnlyAwsCredentials", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it("replaces this process's AWS environment", () => {
    process.env.AWS_PROFILE = "personal-sso";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::111111111111:role/other";
    useOnlyAwsCredentials(creds, "us-east-2");
    expect(process.env.AWS_PROFILE).toBeUndefined();
    expect(process.env.AWS_ROLE_ARN).toBeUndefined();
    expect(process.env.AWS_ACCESS_KEY_ID).toBe("AKIAWIZARD");
    expect(process.env.AWS_REGION).toBe("us-east-2");
  });
});
