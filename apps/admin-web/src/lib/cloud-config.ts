import type { CognitoConfig, STSCredentials } from "./cognito-auth";

/**
 * starkeep-config.json — the single source of truth for cloud setup.
 *
 * Region is NOT stored. It is derived from `userPoolId` (which AWS encodes the
 * region into, e.g. `us-east-2_Xxxxx`). Any code that needs a region must call
 * `getRegion(config)` so we never drift between a stored region and the actual
 * resource home.
 *
 * Tokens (Cognito refresh token, user email) and STS credentials live in
 * localStorage — the file holds only configuration, not session state.
 */
export interface StarkeepConfig {
  stackPrefix: string;
  stage: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  accountId?: string;
  permissionsBoundaryArn?: string;
  foundationalPermissionsBoundaryArn?: string;
  managerRoleArn?: string;
  installDdlRoleArn?: string;
  pulumiStateBucket?: string;
  // Populated by the cloud-data-server install:
  apiGatewayUrl?: string;
  apiGatewayId?: string;
  authorizerId?: string;
  s3Bucket?: string;
  auroraEndpoint?: string;
}

/**
 * Single source of region derivation. AWS Cognito user-pool IDs encode the
 * region as their prefix (`us-east-2_Xxxxx`), so the userPoolId is the
 * authoritative region marker — no separately-stored region field is needed.
 */
export function getRegion(config: Pick<StarkeepConfig, "userPoolId">): string {
  return regionFromUserPoolId(config.userPoolId);
}

export function regionFromUserPoolId(userPoolId: string): string {
  if (!userPoolId) return "";
  const parts = userPoolId.split("_");
  return parts.length > 1 ? parts[0] : "";
}

/**
 * Hydrated config returned to the UI — adds the derived region and a
 * cognitoConfig view assembled from the file's fields.
 */
export interface CloudConfig extends StarkeepConfig {
  region: string;
  cognitoConfig: CognitoConfig;
}

function hydrate(config: Partial<StarkeepConfig>): CloudConfig {
  const region = config.userPoolId ? regionFromUserPoolId(config.userPoolId) : "";
  return {
    stackPrefix: "",
    stage: "",
    userPoolId: "",
    userPoolClientId: "",
    identityPoolId: "",
    ...config,
    region,
    cognitoConfig: {
      userPoolId: config.userPoolId ?? "",
      userPoolClientId: config.userPoolClientId ?? "",
      identityPoolId: config.identityPoolId ?? "",
      region,
    },
  };
}

export interface CloudSetupState {
  state: "unconfigured" | "configured";
  has_credentials: boolean;
}

export async function getCloudSetupState(): Promise<CloudSetupState> {
  const config = await readCloudConfig();
  const creds = await readCloudCredentials();
  return {
    state: config?.apiGatewayUrl ? "configured" : "unconfigured",
    has_credentials: !!creds,
  };
}

export async function readCloudConfig(): Promise<CloudConfig | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { config: Partial<StarkeepConfig> | null };
    return body.config ? hydrate(body.config) : null;
  } catch {
    return null;
  }
}

export async function patchCloudConfig(patch: { [K in keyof StarkeepConfig]?: string | null }): Promise<CloudConfig | null> {
  const res = await fetch("/api/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { config: Partial<StarkeepConfig> | null };
  return body.config ? hydrate(body.config) : null;
}

const CLOUD_CREDENTIALS_KEY = "starkeep:cloud-credentials";
const COGNITO_SESSION_KEY = "starkeep:cognito-session";

export async function readCloudCredentials(): Promise<STSCredentials | null> {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(CLOUD_CREDENTIALS_KEY);
  return raw ? (JSON.parse(raw) as STSCredentials) : null;
}

export async function writeCloudCredentials(creds: STSCredentials): Promise<void> {
  localStorage.setItem(CLOUD_CREDENTIALS_KEY, JSON.stringify(creds));
}

export interface CognitoSession {
  refreshToken: string;
  userEmail?: string;
}

export async function readCognitoSession(): Promise<CognitoSession | null> {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(COGNITO_SESSION_KEY);
  return raw ? (JSON.parse(raw) as CognitoSession) : null;
}

export async function writeCognitoSession(session: CognitoSession): Promise<void> {
  localStorage.setItem(COGNITO_SESSION_KEY, JSON.stringify(session));
}

export async function clearCloudCredentials(): Promise<void> {
  localStorage.removeItem(CLOUD_CREDENTIALS_KEY);
  localStorage.removeItem(COGNITO_SESSION_KEY);
}

export function credentialsNearExpiry(creds: STSCredentials): boolean {
  const expiry = new Date(creds.expiration).getTime();
  return Date.now() > expiry - 5 * 60 * 1000;
}

