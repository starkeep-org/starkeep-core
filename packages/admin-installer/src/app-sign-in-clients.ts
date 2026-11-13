/**
 * The three Cognito app clients that sign people in on the managed login
 * page: one for cloud apps, one for mobile apps, and one for the consent and
 * connections pages that grant outside clients access ("connectors").
 *
 * No client lives in the bootstrap stack. The cloud-apps client's callback
 * names the CloudFront domain, which exists only after the cloud data server
 * install, the connectors client's names the gateway's own hostname, and the
 * mobile-apps client's callbacks change with each app install. The admin-app
 * role creates and updates all three through the SDK.
 *
 * `UpdateUserPoolClient` resets every setting the call leaves out, so every
 * update here reads the client first and writes its whole configuration back.
 *
 * The identity pool trusts none of the three, so a token from any of them
 * reaches no AWS role.
 */
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
  type CreateManagedLoginBrandingRequest,
  type UpdateUserPoolClientCommandInput,
  type UserPoolClientType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CONNECT_CALLBACK_ROUTE,
  CONNECTIONS_ROUTE,
  escapeMarkup,
} from "@starkeep/protocol-primitives";
import { ADMIN_STAR, starBody, starSvg } from "./starkeep-star";

export interface AppSignInClientIds {
  /** Cloud app sessions: the broker's HMAC branch and both gateway authorizers. */
  cloudAppsClientId: string;
  /** Mobile apps: the broker's mobile branch, with an attested key. */
  mobileAppsClientId: string;
  /**
   * The consent and connections pages. The broker keeps one refresh token
   * from this client per delegation, to check that the user may still use
   * data. No data branch and no gateway authorizer accepts its tokens.
   */
  connectorsClientId: string;
}

interface PoolRef {
  stackPrefix: string;
  region: string;
  userPoolId: string;
}

export function cloudAppsClientName(stackPrefix: string): string {
  return `${stackPrefix}-cloud-apps`;
}

export function mobileAppsClientName(stackPrefix: string): string {
  return `${stackPrefix}-mobile-apps`;
}

export function connectorsClientName(stackPrefix: string): string {
  return `${stackPrefix}-connectors`;
}

/** The address a mobile app's sign-in returns to, from its manifest's scheme. */
export function mobileCallbackUrl(callbackScheme: string): string {
  return `${callbackScheme}://auth/callback`;
}

/**
 * Settings both clients share. Public, so the browser and the phone exchange a
 * code with PKCE and no secret. The admin password flow needs AWS credentials
 * with `cognito-idp:AdminInitiateAuth`, so only the e2e suite and the account's
 * administrator can sign in through it; no app can sign in with a bare
 * password. Revocation lets a sign-out end one session.
 */
const SHARED_SETTINGS = {
  ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH"],
  SupportedIdentityProviders: ["COGNITO"],
  EnableTokenRevocation: true,
  PreventUserExistenceErrors: "ENABLED",
} as const;

const OAUTH_ON = {
  AllowedOAuthFlowsUserPoolClient: true,
  AllowedOAuthFlows: ["code"],
  AllowedOAuthScopes: ["openid", "email"],
} as const;

/**
 * Thirty-day sessions, as the admin client gave cloud apps before. A cloud
 * app's session lives in a browser cookie, so a short refresh token costs one
 * sign-in a month.
 */
const CLOUD_APPS_LIFETIMES = {
  TokenValidityUnits: { RefreshToken: "days" },
  RefreshTokenValidity: 30,
} as const;

/**
 * Ten-year refresh tokens, because an expired one stops background sync
 * silently. Fifteen-minute ID tokens bound how long a disabled or ungrouped
 * user keeps syncing, as on the device client.
 */
const MOBILE_APPS_LIFETIMES = {
  TokenValidityUnits: { IdToken: "minutes", AccessToken: "minutes", RefreshToken: "days" },
  IdTokenValidity: 15,
  AccessTokenValidity: 15,
  RefreshTokenValidity: 3650,
} as const;

/**
 * Ten-year refresh tokens, because a delegation lives as long as the user
 * chose and its stored refresh token must outlive it. Fifteen-minute ID
 * tokens bound how long a disabled or ungrouped user's outside clients keep
 * reaching data: the broker mints one from the stored refresh token and
 * checks its groups.
 */
const CONNECTORS_LIFETIMES = {
  TokenValidityUnits: { IdToken: "minutes", AccessToken: "minutes", RefreshToken: "days" },
  IdTokenValidity: 15,
  AccessTokenValidity: 15,
  RefreshTokenValidity: 3650,
} as const;

function cognito(region: string): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ region });
}

async function findClientId(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  name: string,
): Promise<string | null> {
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListUserPoolClientsCommand({ UserPoolId: userPoolId, MaxResults: 60, NextToken: token }),
    );
    const match = page.UserPoolClients?.find((c) => c.ClientName === name);
    if (match?.ClientId) return match.ClientId;
    token = page.NextToken;
  } while (token);
  return null;
}

async function describe(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  clientId: string,
): Promise<UserPoolClientType> {
  const out = await client.send(
    new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }),
  );
  if (!out.UserPoolClient) throw new Error(`Cognito returned no client for ${clientId}`);
  return out.UserPoolClient;
}

/**
 * Every setting `UpdateUserPoolClient` takes, copied from the described
 * client, so an update changes only what `changes` names.
 */
export function updateInputFrom(
  current: UserPoolClientType,
  changes: Partial<UpdateUserPoolClientCommandInput>,
): UpdateUserPoolClientCommandInput {
  const keep: UpdateUserPoolClientCommandInput = {
    UserPoolId: current.UserPoolId!,
    ClientId: current.ClientId!,
    ClientName: current.ClientName,
    RefreshTokenValidity: current.RefreshTokenValidity,
    AccessTokenValidity: current.AccessTokenValidity,
    IdTokenValidity: current.IdTokenValidity,
    TokenValidityUnits: current.TokenValidityUnits,
    ReadAttributes: current.ReadAttributes,
    WriteAttributes: current.WriteAttributes,
    ExplicitAuthFlows: current.ExplicitAuthFlows,
    SupportedIdentityProviders: current.SupportedIdentityProviders,
    CallbackURLs: current.CallbackURLs,
    LogoutURLs: current.LogoutURLs,
    DefaultRedirectURI: current.DefaultRedirectURI,
    AllowedOAuthFlows: current.AllowedOAuthFlows,
    AllowedOAuthScopes: current.AllowedOAuthScopes,
    AllowedOAuthFlowsUserPoolClient: current.AllowedOAuthFlowsUserPoolClient,
    AnalyticsConfiguration: current.AnalyticsConfiguration,
    PreventUserExistenceErrors: current.PreventUserExistenceErrors,
    EnableTokenRevocation: current.EnableTokenRevocation,
    EnablePropagateAdditionalUserContextData: current.EnablePropagateAdditionalUserContextData,
    AuthSessionValidity: current.AuthSessionValidity,
    RefreshTokenRotation: current.RefreshTokenRotation,
  };
  const merged = { ...keep, ...changes };
  // Undefined fields are left out rather than sent: the SDK would serialize
  // nothing for them anyway, and a test comparing inputs reads cleaner.
  return Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  ) as unknown as UpdateUserPoolClientCommandInput;
}

/** Cognito's default heading colors, so the name reads like the page's text. */
const NAME_COLORS = { LIGHT: "#000716", DARK: "#d1d5db" } as const;

/**
 * The star with the deployment's name under it. An SVG shown as an image
 * loads no web fonts, so the name takes the system's sans-serif. A long name
 * gets a smaller font, so 32 characters still fit the 360-wide box.
 */
export function formLogoSvg(deploymentName: string, colorMode: "LIGHT" | "DARK"): string {
  const fontSize = Math.min(28, Math.floor(600 / Math.max(deploymentName.length, 1)));
  const name = escapeMarkup(deploymentName);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 112">
  <g transform="translate(148 0)">
${starBody(ADMIN_STAR)}
  </g>
  <text x="180" y="100" text-anchor="middle" font-size="${fontSize}" font-weight="600" fill="${NAME_COLORS[colorMode]}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">${name}</text>
</svg>
`;
}

/**
 * Cognito's default style with the star and the deployment's name above the
 * form, and the star in the tab. The settings name only what differs from the
 * defaults, which turn the form logo off; Cognito fills in the rest.
 */
export function brandingStyle(
  deploymentName: string,
): Pick<CreateManagedLoginBrandingRequest, "Settings" | "Assets"> {
  const svg = (text: string) => new TextEncoder().encode(text);
  const modes = ["LIGHT", "DARK"] as const;
  return {
    Settings: {
      components: {
        form: {
          logo: { enabled: true, location: "CENTER", position: "TOP", formInclusion: "IN" },
        },
      },
    },
    Assets: [
      ...modes.map((ColorMode) => ({
        Category: "FORM_LOGO" as const,
        ColorMode,
        Extension: "SVG" as const,
        Bytes: svg(formLogoSvg(deploymentName, ColorMode)),
      })),
      ...modes.map((ColorMode) => ({
        Category: "FAVICON_SVG" as const,
        ColorMode,
        Extension: "SVG" as const,
        Bytes: svg(starSvg(ADMIN_STAR)),
      })),
    ],
  };
}

/**
 * Without a branding style, a client's managed login page shows "Login pages
 * unavailable. Please contact an administrator." An SDK-created client gets
 * none, so each client gets the Starkeep style. A client that already has a
 * style gets the Starkeep style written over it, so a reinstall replaces any
 * edit made in the console's branding editor.
 */
async function ensureBranding(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  clientId: string,
  deploymentName: string,
): Promise<void> {
  let brandingId: string | undefined;
  try {
    const out = await client.send(
      new DescribeManagedLoginBrandingByClientCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
      }),
    );
    brandingId = out.ManagedLoginBranding?.ManagedLoginBrandingId;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  if (brandingId) {
    await client.send(
      new UpdateManagedLoginBrandingCommand({
        UserPoolId: userPoolId,
        ManagedLoginBrandingId: brandingId,
        UseCognitoProvidedValues: false,
        ...brandingStyle(deploymentName),
      }),
    );
    return;
  }
  await client.send(
    new CreateManagedLoginBrandingCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      ...brandingStyle(deploymentName),
    }),
  );
}

/**
 * Find both clients by name, creating either one that does not exist yet.
 *
 * Runs before the cloud data server's Pulumi program, which needs both ids
 * for the broker's environment and the gateway's authorizers. A new client
 * starts without OAuth, because the code flow needs a callback and the
 * CloudFront domain may not exist yet; {@link configureAppSignInClients}
 * turns it on.
 */
export async function findOrCreateAppSignInClients(pool: PoolRef): Promise<AppSignInClientIds> {
  const client = cognito(pool.region);
  const ensure = async (name: string, lifetimes: Record<string, unknown>): Promise<string> => {
    const existing = await findClientId(client, pool.userPoolId, name);
    if (existing) return existing;
    const created = await client.send(
      new CreateUserPoolClientCommand({
        UserPoolId: pool.userPoolId,
        ClientName: name,
        GenerateSecret: false,
        ...SHARED_SETTINGS,
        ...lifetimes,
        ExplicitAuthFlows: [...SHARED_SETTINGS.ExplicitAuthFlows],
        SupportedIdentityProviders: [...SHARED_SETTINGS.SupportedIdentityProviders],
      }),
    );
    const id = created.UserPoolClient?.ClientId;
    if (!id) throw new Error(`Cognito created ${name} but returned no client id`);
    console.log(`Created Cognito app client ${name} (${id}).`);
    return id;
  };
  return {
    cloudAppsClientId: await ensure(cloudAppsClientName(pool.stackPrefix), CLOUD_APPS_LIFETIMES),
    mobileAppsClientId: await ensure(mobileAppsClientName(pool.stackPrefix), MOBILE_APPS_LIFETIMES),
    connectorsClientId: await ensure(connectorsClientName(pool.stackPrefix), CONNECTORS_LIFETIMES),
  };
}

/**
 * The cloud-apps client's full settings for a deployment that answers at each
 * of `publicBaseUrls`: the custom domain, when one is attached, and the
 * CloudFront domain. A sign-in finishes on the name it began on, so each name
 * needs its own callback and logout address.
 */
export function cloudAppsClientSettings(
  publicBaseUrls: readonly string[],
): Partial<UpdateUserPoolClientCommandInput> {
  const bases = [...new Set(publicBaseUrls.map((u) => u.replace(/\/+$/, "")))];
  return {
    ...SHARED_SETTINGS,
    ...OAUTH_ON,
    ...CLOUD_APPS_LIFETIMES,
    ExplicitAuthFlows: [...SHARED_SETTINGS.ExplicitAuthFlows],
    SupportedIdentityProviders: [...SHARED_SETTINGS.SupportedIdentityProviders],
    AllowedOAuthFlows: [...OAUTH_ON.AllowedOAuthFlows],
    AllowedOAuthScopes: [...OAUTH_ON.AllowedOAuthScopes],
    CallbackURLs: bases.map((b) => `${b}/auth/callback`),
    LogoutURLs: bases.map((b) => `${b}/auth/signed-out`),
  };
}

/**
 * The connectors client's full settings. The consent and connections pages
 * answer only on the gateway's own hostname, never on the shared origin where
 * app script runs, so the callback names that hostname alone.
 */
export function connectorsClientSettings(
  gatewayBaseUrl: string,
): Partial<UpdateUserPoolClientCommandInput> {
  const base = gatewayBaseUrl.replace(/\/+$/, "");
  return {
    ...SHARED_SETTINGS,
    ...OAUTH_ON,
    ...CONNECTORS_LIFETIMES,
    ExplicitAuthFlows: [...SHARED_SETTINGS.ExplicitAuthFlows],
    SupportedIdentityProviders: [...SHARED_SETTINGS.SupportedIdentityProviders],
    AllowedOAuthFlows: [...OAUTH_ON.AllowedOAuthFlows],
    AllowedOAuthScopes: [...OAUTH_ON.AllowedOAuthScopes],
    CallbackURLs: [`${base}${CONNECT_CALLBACK_ROUTE}`],
    LogoutURLs: [`${base}${CONNECTIONS_ROUTE}`],
  };
}

/**
 * The mobile-apps client's full settings for a set of callbacks. Cognito
 * refuses the code flow on a client with no callback, so the flow stays off
 * until an installed app declares a mobile build.
 */
export function mobileAppsClientSettings(
  callbackUrls: readonly string[],
): Partial<UpdateUserPoolClientCommandInput> {
  const sorted = [...new Set(callbackUrls)].sort();
  return {
    ...SHARED_SETTINGS,
    ...MOBILE_APPS_LIFETIMES,
    ExplicitAuthFlows: [...SHARED_SETTINGS.ExplicitAuthFlows],
    SupportedIdentityProviders: [...SHARED_SETTINGS.SupportedIdentityProviders],
    ...(sorted.length > 0
      ? {
          ...OAUTH_ON,
          AllowedOAuthFlows: [...OAUTH_ON.AllowedOAuthFlows],
          AllowedOAuthScopes: [...OAUTH_ON.AllowedOAuthScopes],
          CallbackURLs: sorted,
        }
      : {
          AllowedOAuthFlowsUserPoolClient: false,
          AllowedOAuthFlows: [],
          AllowedOAuthScopes: [],
          CallbackURLs: [],
        }),
    LogoutURLs: [],
  };
}

/**
 * Bring every client to its full settings once the CloudFront domain is
 * known, and give each its branding style. The mobile-apps client keeps the
 * callbacks that app installs registered.
 */
export async function configureAppSignInClients(
  pool: PoolRef & {
    publicBaseUrls: readonly string[];
    /** The gateway's own execute-api URL, where the consent pages answer. */
    gatewayBaseUrl: string;
    clients: AppSignInClientIds;
    deploymentName: string;
  },
): Promise<void> {
  const client = cognito(pool.region);
  const cloudApps = await describe(client, pool.userPoolId, pool.clients.cloudAppsClientId);
  await client.send(
    new UpdateUserPoolClientCommand(
      updateInputFrom(cloudApps, cloudAppsClientSettings(pool.publicBaseUrls)),
    ),
  );
  await ensureBranding(
    client,
    pool.userPoolId,
    pool.clients.cloudAppsClientId,
    pool.deploymentName,
  );

  const mobileApps = await describe(client, pool.userPoolId, pool.clients.mobileAppsClientId);
  await client.send(
    new UpdateUserPoolClientCommand(
      updateInputFrom(mobileApps, mobileAppsClientSettings(mobileApps.CallbackURLs ?? [])),
    ),
  );
  await ensureBranding(
    client,
    pool.userPoolId,
    pool.clients.mobileAppsClientId,
    pool.deploymentName,
  );

  const connectors = await describe(client, pool.userPoolId, pool.clients.connectorsClientId);
  await client.send(
    new UpdateUserPoolClientCommand(
      updateInputFrom(connectors, connectorsClientSettings(pool.gatewayBaseUrl)),
    ),
  );
  await ensureBranding(
    client,
    pool.userPoolId,
    pool.clients.connectorsClientId,
    pool.deploymentName,
  );
}

/**
 * Add or remove one mobile app's callback on the mobile-apps client, keeping
 * every other setting. Install adds the callback; uninstall removes it. The
 * client's branding style stays as the cloud data server install wrote it.
 */
export async function setMobileAppCallback(
  pool: { region: string; userPoolId: string; mobileAppsClientId: string },
  callbackScheme: string,
  present: boolean,
): Promise<void> {
  const client = cognito(pool.region);
  const current = await describe(client, pool.userPoolId, pool.mobileAppsClientId);
  const url = mobileCallbackUrl(callbackScheme);
  const others = (current.CallbackURLs ?? []).filter((u) => u !== url);
  const next = present ? [...others, url] : others;
  await client.send(
    new UpdateUserPoolClientCommand(updateInputFrom(current, mobileAppsClientSettings(next))),
  );
}
