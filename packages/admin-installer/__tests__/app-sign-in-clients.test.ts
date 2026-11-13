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
  UpdateManagedLoginBrandingCommand,
  UpdateUserPoolClientCommand,
  type UserPoolClientType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  brandingStyle,
  configureAppSignInClients,
  formLogoSvg,
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
        { ClientId: "conn1", ClientName: "sk-connectors" },
      ],
    });
    expect(await findOrCreateAppSignInClients(POOL)).toEqual({
      cloudAppsClientId: "cloud1",
      mobileAppsClientId: "mobile1",
      connectorsClientId: "conn1",
    });
    expect(cognito.commandCalls(CreateUserPoolClientCommand)).toHaveLength(0);
  });

  it("creates a missing client as a public client with no password flow", async () => {
    cognito.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [
        { ClientId: "cloud1", ClientName: "sk-cloud-apps" },
        { ClientId: "conn1", ClientName: "sk-connectors" },
      ],
    });
    cognito.on(CreateUserPoolClientCommand).resolves({ UserPoolClient: { ClientId: "mobile2" } });

    expect(await findOrCreateAppSignInClients(POOL)).toEqual({
      cloudAppsClientId: "cloud1",
      mobileAppsClientId: "mobile2",
      connectorsClientId: "conn1",
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

  it("creates the connectors client with ten-year refresh tokens and fifteen-minute ID tokens", async () => {
    cognito.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [
        { ClientId: "cloud1", ClientName: "sk-cloud-apps" },
        { ClientId: "mobile1", ClientName: "sk-mobile-apps" },
      ],
    });
    cognito.on(CreateUserPoolClientCommand).resolves({ UserPoolClient: { ClientId: "conn2" } });

    expect((await findOrCreateAppSignInClients(POOL)).connectorsClientId).toBe("conn2");
    expect(cognito.commandCalls(CreateUserPoolClientCommand)[0]!.args[0].input).toMatchObject({
      ClientName: "sk-connectors",
      GenerateSecret: false,
      IdTokenValidity: 15,
      RefreshTokenValidity: 3650,
      EnableTokenRevocation: true,
    });
  });

  it("follows the client list across pages", async () => {
    cognito
      .on(ListUserPoolClientsCommand)
      .resolvesOnce({ UserPoolClients: [], NextToken: "page2" })
      .resolves({
        UserPoolClients: [
          { ClientId: "cloud1", ClientName: "sk-cloud-apps" },
          { ClientId: "mobile1", ClientName: "sk-mobile-apps" },
          { ClientId: "conn1", ClientName: "sk-connectors" },
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
    cognito
      .on(DescribeUserPoolClientCommand, { ClientId: "conn1" })
      .resolves({ UserPoolClient: { ...MOBILE, ClientId: "conn1", ClientName: "sk-connectors" } });

    await configureAppSignInClients({
      ...POOL,
      publicBaseUrls: ["https://d1.cloudfront.net/"],
      clients: { cloudAppsClientId: "cloud1", mobileAppsClientId: "mobile1", connectorsClientId: "conn1" },
      gatewayBaseUrl: "https://abc123.execute-api.us-east-2.amazonaws.com",
      deploymentName: "Koller Family",
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

  it("gives the connectors client its callback on the gateway's own hostname alone", async () => {
    cognito.on(DescribeUserPoolClientCommand).resolves({ UserPoolClient: MOBILE });

    await configureAppSignInClients({
      ...POOL,
      publicBaseUrls: ["https://photos.example.com", "https://d1.cloudfront.net"],
      clients: { cloudAppsClientId: "cloud1", mobileAppsClientId: "mobile1", connectorsClientId: "conn1" },
      gatewayBaseUrl: "https://abc123.execute-api.us-east-2.amazonaws.com/",
      deploymentName: "Koller Family",
    });

    // The consent pages never answer on the shared origin, where app script
    // runs, so no CloudFront name appears here.
    expect(cognito.commandCalls(UpdateUserPoolClientCommand)[2]!.args[0].input).toMatchObject({
      CallbackURLs: ["https://abc123.execute-api.us-east-2.amazonaws.com/connect/callback"],
      LogoutURLs: ["https://abc123.execute-api.us-east-2.amazonaws.com/connections"],
      AllowedOAuthFlows: ["code"],
      RefreshTokenValidity: 3650,
      IdTokenValidity: 15,
    });
  });

  it("lists a callback and a logout address on every name the cloud answers on", async () => {
    cognito.on(DescribeUserPoolClientCommand).resolves({ UserPoolClient: MOBILE });

    await configureAppSignInClients({
      ...POOL,
      // The custom domain, and the CloudFront name that keeps answering.
      publicBaseUrls: ["https://photos.example.com", "https://d1.cloudfront.net/"],
      clients: { cloudAppsClientId: "cloud1", mobileAppsClientId: "mobile1", connectorsClientId: "conn1" },
      gatewayBaseUrl: "https://abc123.execute-api.us-east-2.amazonaws.com",
      deploymentName: "Koller Family",
    });

    expect(cognito.commandCalls(UpdateUserPoolClientCommand)[0]!.args[0].input).toMatchObject({
      CallbackURLs: [
        "https://photos.example.com/auth/callback",
        "https://d1.cloudfront.net/auth/callback",
      ],
      LogoutURLs: [
        "https://photos.example.com/auth/signed-out",
        "https://d1.cloudfront.net/auth/signed-out",
      ],
    });
  });

  it("lists a name given twice once", async () => {
    cognito.on(DescribeUserPoolClientCommand).resolves({ UserPoolClient: MOBILE });

    await configureAppSignInClients({
      ...POOL,
      publicBaseUrls: ["https://d1.cloudfront.net", "https://d1.cloudfront.net/"],
      clients: { cloudAppsClientId: "cloud1", mobileAppsClientId: "mobile1", connectorsClientId: "conn1" },
      gatewayBaseUrl: "https://abc123.execute-api.us-east-2.amazonaws.com",
      deploymentName: "Koller Family",
    });

    expect(
      cognito.commandCalls(UpdateUserPoolClientCommand)[0]!.args[0].input.CallbackURLs,
    ).toEqual(["https://d1.cloudfront.net/auth/callback"]);
  });

  it("gives a client with no branding style the Starkeep one", async () => {
    cognito.on(DescribeUserPoolClientCommand).resolves({ UserPoolClient: MOBILE });
    cognito
      .on(DescribeManagedLoginBrandingByClientCommand)
      .rejects(new ResourceNotFoundException({ message: "none", $metadata: {} }));

    await configureAppSignInClients({
      ...POOL,
      publicBaseUrls: ["https://d1.cloudfront.net"],
      clients: { cloudAppsClientId: "cloud1", mobileAppsClientId: "mobile1", connectorsClientId: "conn1" },
      gatewayBaseUrl: "https://abc123.execute-api.us-east-2.amazonaws.com",
      deploymentName: "Koller Family",
    });

    const created = cognito
      .commandCalls(CreateManagedLoginBrandingCommand)
      .map((c) => c.args[0].input);
    expect(created).toEqual([
      { UserPoolId: POOL.userPoolId, ClientId: "cloud1", ...brandingStyle("Koller Family") },
      { UserPoolId: POOL.userPoolId, ClientId: "mobile1", ...brandingStyle("Koller Family") },
      { UserPoolId: POOL.userPoolId, ClientId: "conn1", ...brandingStyle("Koller Family") },
    ]);
    expect(cognito.commandCalls(UpdateManagedLoginBrandingCommand)).toHaveLength(0);
  });

  it("writes the Starkeep style over a client's existing one", async () => {
    cognito.on(DescribeUserPoolClientCommand).resolves({ UserPoolClient: MOBILE });
    cognito
      .on(DescribeManagedLoginBrandingByClientCommand, { ClientId: "cloud1" })
      .resolves({ ManagedLoginBranding: { ManagedLoginBrandingId: "brand-cloud" } })
      .on(DescribeManagedLoginBrandingByClientCommand, { ClientId: "mobile1" })
      .resolves({ ManagedLoginBranding: { ManagedLoginBrandingId: "brand-mobile" } })
      .on(DescribeManagedLoginBrandingByClientCommand, { ClientId: "conn1" })
      .resolves({ ManagedLoginBranding: { ManagedLoginBrandingId: "brand-conn" } });

    await configureAppSignInClients({
      ...POOL,
      publicBaseUrls: ["https://d1.cloudfront.net"],
      clients: { cloudAppsClientId: "cloud1", mobileAppsClientId: "mobile1", connectorsClientId: "conn1" },
      gatewayBaseUrl: "https://abc123.execute-api.us-east-2.amazonaws.com",
      deploymentName: "Koller Family",
    });

    const updated = cognito
      .commandCalls(UpdateManagedLoginBrandingCommand)
      .map((c) => c.args[0].input);
    const style = { UseCognitoProvidedValues: false, ...brandingStyle("Koller Family") };
    expect(updated).toEqual([
      { UserPoolId: POOL.userPoolId, ManagedLoginBrandingId: "brand-cloud", ...style },
      { UserPoolId: POOL.userPoolId, ManagedLoginBrandingId: "brand-mobile", ...style },
      { UserPoolId: POOL.userPoolId, ManagedLoginBrandingId: "brand-conn", ...style },
    ]);
    expect(cognito.commandCalls(CreateManagedLoginBrandingCommand)).toHaveLength(0);
  });

  it("puts the star above the form and in the tab, in both color modes", () => {
    const { Settings, Assets } = brandingStyle("Koller Family");
    expect(Settings).toMatchObject({ components: { form: { logo: { enabled: true } } } });
    expect(Assets!.map((a) => `${a.Category}/${a.ColorMode}/${a.Extension}`)).toEqual([
      "FORM_LOGO/LIGHT/SVG",
      "FORM_LOGO/DARK/SVG",
      "FAVICON_SVG/LIGHT/SVG",
      "FAVICON_SVG/DARK/SVG",
    ]);
    const svg = (i: number) => new TextDecoder().decode(Assets![i]!.Bytes);
    expect(svg(0)).toBe(formLogoSvg("Koller Family", "LIGHT"));
    expect(svg(1)).toBe(formLogoSvg("Koller Family", "DARK"));
    expect(svg(2)).not.toContain("Koller Family");
  });

  it("writes the deployment's name under the star, escaped, in each mode's heading color", () => {
    const light = formLogoSvg("Tom & Jerry's <Photos>", "LIGHT");
    expect(light).toContain(">Tom &amp; Jerry&#39;s &lt;Photos&gt;</text>");
    expect(light).toContain('fill="#000716"');
    expect(formLogoSvg("Koller Family", "DARK")).toContain('fill="#d1d5db"');
  });

  it("carries no attribute Cognito's asset check refuses", () => {
    for (const asset of brandingStyle("Koller Family").Assets!) {
      const svg = new TextDecoder().decode(asset.Bytes);
      expect(svg).not.toMatch(/\b(role|aria-[a-z]+)=/);
    }
  });

  it("shrinks the font for a long name", () => {
    const size = (name: string) => Number(/font-size="(\d+)"/.exec(formLogoSvg(name, "LIGHT"))![1]);
    expect(size("Koller")).toBe(28);
    expect(size("x".repeat(32))).toBeLessThan(28);
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
    // The cloud data server install owns the branding style.
    expect(cognito.commandCalls(UpdateManagedLoginBrandingCommand)).toHaveLength(0);
    expect(cognito.commandCalls(CreateManagedLoginBrandingCommand)).toHaveLength(0);
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
