/**
 * The cloud-apps and mobile-apps clients, which the cloud data server install
 * creates and each app install updates.
 *
 * `UpdateUserPoolClient` resets every setting a call leaves out, so the
 * property worth testing is that each update writes the client's whole
 * configuration back, changing only what it means to change.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CognitoIdentityProviderClient,
  CreateManagedLoginBrandingCommand,
  CreateUserPoolClientCommand,
  DescribeManagedLoginBrandingByClientCommand,
  DescribeUserPoolClientCommand,
  ListUserPoolClientsCommand,
  ResourceNotFoundException,
  UpdateUserPoolClientCommand,
  type UserPoolClientType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  configureAppSignInClients,
  findOrCreateAppSignInClients,
  setMobileAppCallback,
} from "../src/app-sign-in-clients.js";

const cognito = mockClient(CognitoIdentityProviderClient);
const POOL = { stackPrefix: "sk", region: "us-east-2", userPoolId: "us-east-2_pool" };

/** A mobile-apps client as Cognito describes it, with one app's callback. */
const MOBILE: UserPoolClientType = {
  UserPoolId: POOL.userPoolId,
  ClientId: "mobile1",
  ClientName: "sk-mobile-apps",
  RefreshTokenValidity: 3650,
  IdTokenValidity: 15,
  AccessTokenValidity: 15,
  TokenValidityUnits: { IdToken: "minutes", AccessToken: "minutes", RefreshToken: "days" },
  ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH"],
  SupportedIdentityProviders: ["COGNITO"],
  CallbackURLs: ["memo-mobile://auth/callback"],
  AllowedOAuthFlows: ["code"],
  AllowedOAuthScopes: ["openid", "email"],
  AllowedOAuthFlowsUserPoolClient: true,
  PreventUserExistenceErrors: "ENABLED",
  EnableTokenRevocation: true,
  AuthSessionValidity: 3,
  ReadAttributes: ["email"],
};

beforeEach(() => {
  cognito.reset();
  cognito.on(DescribeManagedLoginBrandingByClientCommand).resolves({});
});

function lastUpdate() {
  const calls = cognito.commandCalls(UpdateUserPoolClientCommand);
  return calls[calls.length - 1]!.args[0].input;
}

describe("findOrCreateAppSignInClients", () => {
  it("reuses clients that exist, by name", async () => {
    cognito.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [
        { ClientId: "admin1", ClientName: "sk-admin" },
        { ClientId: "cloud1", ClientName: "sk-cloud-apps" },
        { ClientId: "mobile1", ClientName: "sk-mobile-apps" },
      ],
    });
    expect(await findOrCreateAppSignInClients(POOL)).toEqual({
      cloudAppsClientId: "cloud1",
      mobileAppsClientId: "mobile1",
    });
    expect(cognito.commandCalls(CreateUserPoolClientCommand)).toHaveLength(0);
  });

  it("creates a missing client as a public client with no password flow", async () => {
    cognito
      .on(ListUserPoolClientsCommand)
      .resolves({ UserPoolClients: [{ ClientId: "cloud1", ClientName: "sk-cloud-apps" }] });
    cognito.on(CreateUserPoolClientCommand).resolves({ UserPoolClient: { ClientId: "mobile2" } });

    expect(await findOrCreateAppSignInClients(POOL)).toEqual({
      cloudAppsClientId: "cloud1",
      mobileAppsClientId: "mobile2",
    });
    const input = cognito.commandCalls(CreateUserPoolClientCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      ClientName: "sk-mobile-apps",
      GenerateSecret: false,
      IdTokenValidity: 15,
      RefreshTokenValidity: 3650,
      EnableTokenRevocation: true,
    });
    expect(input.ExplicitAuthFlows!.sort()).toEqual([
      "ALLOW_ADMIN_USER_PASSWORD_AUTH",
      "ALLOW_REFRESH_TOKEN_AUTH",
    ]);
  });

  it("follows the client list across pages", async () => {
    cognito
      .on(ListUserPoolClientsCommand)
      .resolvesOnce({ UserPoolClients: [], NextToken: "page2" })
      .resolves({
        UserPoolClients: [
          { ClientId: "cloud1", ClientName: "sk-cloud-apps" },
          { ClientId: "mobile1", ClientName: "sk-mobile-apps" },
        ],
      });
    expect((await findOrCreateAppSignInClients(POOL)).cloudAppsClientId).toBe("cloud1");
  });
});

describe("configureAppSignInClients", () => {
  it("gives the cloud-apps client the code flow, with its callback on the shared origin", async () => {
    cognito
      .on(DescribeUserPoolClientCommand, { ClientId: "cloud1" })
      .resolves({ UserPoolClient: { ...MOBILE, ClientId: "cloud1", ClientName: "sk-cloud-apps" } });
    cognito.on(DescribeUserPoolClientCommand, { ClientId: "mobile1" }).resolves({
      UserPoolClient: MOBILE,
    });

    await configureAppSignInClients({
      ...POOL,
      publicBaseUrl: "https://d1.cloudfront.net/",
      clients: { cloudAppsClientId: "cloud1", mobileAppsClientId: "mobile1" },
    });

    const [cloud, mobile] = cognito
      .commandCalls(UpdateUserPoolClientCommand)
      .map((c) => c.args[0].input);
    expect(cloud).toMatchObject({
      ClientId: "cloud1",
      ClientName: "sk-cloud-apps",
      CallbackURLs: ["https://d1.cloudfront.net/auth/callback"],
      LogoutURLs: ["https://d1.cloudfront.net/auth/signed-out"],
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid", "email"],
      AllowedOAuthFlowsUserPoolClient: true,
      RefreshTokenValidity: 30,
    });
    // The mobile-apps client keeps the callbacks app installs registered.
    expect(mobile!.CallbackURLs).toEqual(["memo-mobile://auth/callback"]);
  });

  it("gives a client with no branding style Cognito's default one", async () => {
    cognito.on(DescribeUserPoolClientCommand).resolves({ UserPoolClient: MOBILE });
    cognito
      .on(DescribeManagedLoginBrandingByClientCommand)
      .rejects(new ResourceNotFoundException({ message: "none", $metadata: {} }));

    await configureAppSignInClients({
      ...POOL,
      publicBaseUrl: "https://d1.cloudfront.net",
      clients: { cloudAppsClientId: "cloud1", mobileAppsClientId: "mobile1" },
    });

    const created = cognito
      .commandCalls(CreateManagedLoginBrandingCommand)
      .map((c) => c.args[0].input);
    expect(created).toEqual([
      { UserPoolId: POOL.userPoolId, ClientId: "cloud1", UseCognitoProvidedValues: true },
      { UserPoolId: POOL.userPoolId, ClientId: "mobile1", UseCognitoProvidedValues: true },
    ]);
  });
});

describe("setMobileAppCallback", () => {
  const pool = { region: POOL.region, userPoolId: POOL.userPoolId, mobileAppsClientId: "mobile1" };

  it("adds one app's callback and keeps every other setting", async () => {
    cognito.on(DescribeUserPoolClientCommand).resolves({ UserPoolClient: MOBILE });

    await setMobileAppCallback(pool, "starkeep-photos", true);

    const update = lastUpdate();
    expect(update.CallbackURLs).toEqual([
      "memo-mobile://auth/callback",
      "starkeep-photos://auth/callback",
    ]);
    // Settings this call has no business changing come back unchanged.
    expect(update.AuthSessionValidity).toBe(3);
    expect(update.ReadAttributes).toEqual(["email"]);
    expect(update.ClientName).toBe("sk-mobile-apps");
    expect(update.IdTokenValidity).toBe(15);
  });

  it("removes one app's callback and leaves the others", async () => {
    cognito.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: {
        ...MOBILE,
        CallbackURLs: ["memo-mobile://auth/callback", "starkeep-photos://auth/callback"],
      },
    });

    await setMobileAppCallback(pool, "starkeep-photos", false);

    expect(lastUpdate().CallbackURLs).toEqual(["memo-mobile://auth/callback"]);
    expect(lastUpdate().AllowedOAuthFlowsUserPoolClient).toBe(true);
  });

  it("turns the code flow off when the last callback goes, which Cognito requires", async () => {
    cognito.on(DescribeUserPoolClientCommand).resolves({ UserPoolClient: MOBILE });

    await setMobileAppCallback(pool, "memo-mobile", false);

    expect(lastUpdate()).toMatchObject({
      CallbackURLs: [],
      AllowedOAuthFlows: [],
      AllowedOAuthFlowsUserPoolClient: false,
    });
  });
});
