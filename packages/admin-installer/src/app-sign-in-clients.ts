/**
 * The two Cognito app clients that sign people in on the managed login page:
 * one for cloud apps and one for mobile apps.
 *
 * Neither client lives in the bootstrap stack. The cloud-apps client's callback
 * names the CloudFront domain, which exists only after the cloud data server
 * install, and the mobile-apps client's callbacks change with each app install.
 * The admin-app role creates and updates both through the SDK.
 *
 * `UpdateUserPoolClient` resets every setting the call leaves out, so every
 * update here reads the client first and writes its whole configuration back.
 *
 * The identity pool trusts neither client, so a token from either reaches no
 * AWS role.
 */
import {
  CognitoIdentityProviderClient,
  CreateManagedLoginBrandingCommand,
  CreateUserPoolClientCommand,
  DescribeManagedLoginBrandingByClientCommand,
  DescribeUserPoolClientCommand,
  ListUserPoolClientsCommand,
  ResourceNotFoundException,
  UpdateUserPoolClientCommand,
  type UpdateUserPoolClientCommandInput,
  type UserPoolClientType,
} from "@aws-sdk/client-cognito-identity-provider";

export interface AppSignInClientIds {
  /** Cloud app sessions: the broker's HMAC branch and both gateway authorizers. */
  cloudAppsClientId: string;
  /** Mobile apps: the broker's mobile branch, with an attested key. */
  mobileAppsClientId: string;
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

/**
 * Without a branding style, a client's managed login page shows "Login pages
 * unavailable. Please contact an administrator." An SDK-created client gets
 * none, so each client gets Cognito's default style once.
 */
async function ensureBranding(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  clientId: string,
): Promise<void> {
  try {
    await client.send(
      new DescribeManagedLoginBrandingByClientCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
      }),
    );
    return;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  await client.send(
    new CreateManagedLoginBrandingCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      UseCognitoProvidedValues: true,
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
  };
}

/** The cloud-apps client's full settings for a deployment at `publicBaseUrl`. */
export function cloudAppsClientSettings(
  publicBaseUrl: string,
): Partial<UpdateUserPoolClientCommandInput> {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return {
    ...SHARED_SETTINGS,
    ...OAUTH_ON,
    ...CLOUD_APPS_LIFETIMES,
    ExplicitAuthFlows: [...SHARED_SETTINGS.ExplicitAuthFlows],
    SupportedIdentityProviders: [...SHARED_SETTINGS.SupportedIdentityProviders],
    AllowedOAuthFlows: [...OAUTH_ON.AllowedOAuthFlows],
    AllowedOAuthScopes: [...OAUTH_ON.AllowedOAuthScopes],
    CallbackURLs: [`${base}/auth/callback`],
    LogoutURLs: [`${base}/auth/signed-out`],
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
 * Bring both clients to their full settings once the CloudFront domain is
 * known, and give each its branding style. The mobile-apps client keeps the
 * callbacks that app installs registered.
 */
export async function configureAppSignInClients(
  pool: PoolRef & { publicBaseUrl: string; clients: AppSignInClientIds },
): Promise<void> {
  const client = cognito(pool.region);
  const cloudApps = await describe(client, pool.userPoolId, pool.clients.cloudAppsClientId);
  await client.send(
    new UpdateUserPoolClientCommand(
      updateInputFrom(cloudApps, cloudAppsClientSettings(pool.publicBaseUrl)),
    ),
  );
  await ensureBranding(client, pool.userPoolId, pool.clients.cloudAppsClientId);

  const mobileApps = await describe(client, pool.userPoolId, pool.clients.mobileAppsClientId);
  await client.send(
    new UpdateUserPoolClientCommand(
      updateInputFrom(mobileApps, mobileAppsClientSettings(mobileApps.CallbackURLs ?? [])),
    ),
  );
  await ensureBranding(client, pool.userPoolId, pool.clients.mobileAppsClientId);
}

/**
 * Add or remove one mobile app's callback on the mobile-apps client, keeping
 * every other setting. Install adds the callback; uninstall removes it.
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
  if (present) await ensureBranding(client, pool.userPoolId, pool.mobileAppsClientId);
}
