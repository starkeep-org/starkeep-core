/**
 * /api/cognito-outputs — the two bootstrap outputs the wizard looks up after
 * sign-in instead of asking the operator to copy them.
 *
 * The device client is found by the name the bootstrap template gives it, so
 * these tests pin that name, a match on a later page, and the answer when the
 * pool lacks either resource.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mockClient } from "aws-sdk-client-mock";
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  ListUserPoolClientsCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { generateBootstrapTemplate } from "@starkeep/aws-bootstrap";
import { jsonRequest, makeDataDir } from "./helpers";
import { signInFake, signOutFake } from "./fake-admin-session";
vi.mock("@starkeep/operator/admin-session", async (original) =>
  (await import("./fake-admin-session")).fakeAdminSessionModule(await original()),
);

const cognito = mockClient(CognitoIdentityProviderClient);
let route: typeof import("../src/routes/cognito-outputs");

// The route acts as the signed-in admin (`fake-admin-session.ts`).
const SESSION = {};

beforeAll(async () => {
  const dir = makeDataDir("adminweb-cognito-outputs-");
  process.env.STARKEEP_DIR = dir;
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ stackPrefix: "sktest", userPoolId: "us-east-2_POOL" }),
  );
  route = await import("../src/routes/cognito-outputs");
});

beforeEach(() => {
  cognito.reset();
  cognito.on(ListUserPoolClientsCommand).resolves({
    UserPoolClients: [
      { ClientId: "adminclient", ClientName: "sktest-admin" },
      { ClientId: "deviceclient", ClientName: "sktest-devices" },
    ],
  });
  cognito.on(DescribeUserPoolCommand).resolves({ UserPool: { Domain: "sktest-123456789012" } });
});

async function lookUp(): Promise<Response> {
  return route.POST(jsonRequest("/api/cognito-outputs", SESSION));
}

describe("POST /api/cognito-outputs", () => {
  it("answers the device client and the managed login host", async () => {
    const res = await lookUp();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deviceUserPoolClientId: "deviceclient",
      cognitoDomain: "sktest-123456789012.auth.us-east-2.amazoncognito.com",
    });
    expect(cognito.commandCalls(DescribeUserPoolCommand)[0].args[0].input).toEqual({
      UserPoolId: "us-east-2_POOL",
    });
  });

  it("looks for the client name the bootstrap template gives the device client", () => {
    expect(generateBootstrapTemplate({ stackPrefix: "sktest", deploymentName: "Test" })).toContain(
      `ClientName: !Sub '\${StackPrefix}-devices'`,
    );
    expect(route.deviceClientName("sktest")).toBe("sktest-devices");
  });

  it("pages through the pool's clients", async () => {
    cognito
      .on(ListUserPoolClientsCommand)
      .resolvesOnce({
        UserPoolClients: [{ ClientId: "adminclient", ClientName: "sktest-admin" }],
        NextToken: "page-2",
      })
      .resolvesOnce({
        UserPoolClients: [{ ClientId: "deviceclient", ClientName: "sktest-devices" }],
      });
    const res = await lookUp();
    expect(((await res.json()) as { deviceUserPoolClientId: string }).deviceUserPoolClientId).toBe(
      "deviceclient",
    );
    const calls = cognito.commandCalls(ListUserPoolClientsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.NextToken).toBe("page-2");
  });

  it("says to update the stack when the pool has no device client", async () => {
    cognito.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [{ ClientId: "adminclient", ClientName: "sktest-admin" }],
    });
    const res = await lookUp();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /no app client named sktest-devices.*Update the bootstrap stack/,
    );
  });

  it("says to update the stack when the pool has no managed login domain", async () => {
    cognito.on(DescribeUserPoolCommand).resolves({ UserPool: {} });
    const res = await lookUp();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/no managed login domain/);
  });

  it("passes on Cognito's refusal", async () => {
    cognito.on(DescribeUserPoolCommand).rejects(new Error("AccessDeniedException"));
    const res = await lookUp();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("AccessDeniedException");
  });
});

describe("without an admin session", () => {
  it("answers 401 NOT_SIGNED_IN and asks the pool nothing", async () => {
    signOutFake();
    try {
      const res = await lookUp();
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "NOT_SIGNED_IN" });
      expect(cognito.calls()).toHaveLength(0);
    } finally {
      signInFake();
    }
  });
});
