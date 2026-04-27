import type { CognitoConfig, STSCredentials } from "./cognito-auth";

const CLOUD_CONFIG_KEY = "starkeep:cloud-config";
const CLOUD_CREDENTIALS_KEY = "starkeep:cloud-credentials";

export interface CloudConfig {
  stackPrefix: string;
  s3Bucket: string;
  s3Region: string;
  auroraEndpoint: string;
  apiGatewayUrl?: string;
  cognitoConfig: CognitoConfig;
  cognitoRefreshToken: string;
  userEmail?: string;
}

export type CloudConfigExport = Omit<CloudConfig, "cognitoRefreshToken">;

export interface CloudSetupState {
  state: "unconfigured" | "configured";
  has_credentials: boolean;
}

export async function getCloudSetupState(): Promise<CloudSetupState> {
  const config = await readCloudConfig();
  const creds = await readCloudCredentials();
  return {
    state: config ? "configured" : "unconfigured",
    has_credentials: !!creds,
  };
}

export async function readCloudConfig(): Promise<CloudConfig | null> {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(CLOUD_CONFIG_KEY);
  return raw ? (JSON.parse(raw) as CloudConfig) : null;
}

export async function writeCloudConfig(config: CloudConfig): Promise<void> {
  localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(config, null, 2));
}

export async function readCloudCredentials(): Promise<STSCredentials | null> {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(CLOUD_CREDENTIALS_KEY);
  return raw ? (JSON.parse(raw) as STSCredentials) : null;
}

export async function writeCloudCredentials(creds: STSCredentials): Promise<void> {
  localStorage.setItem(CLOUD_CREDENTIALS_KEY, JSON.stringify(creds));
}

export async function clearCloudConfig(): Promise<void> {
  localStorage.removeItem(CLOUD_CONFIG_KEY);
  localStorage.removeItem(CLOUD_CREDENTIALS_KEY);
  localStorage.removeItem("starkeep-partial-setup");
}

export function credentialsNearExpiry(creds: STSCredentials): boolean {
  const expiry = new Date(creds.expiration).getTime();
  return Date.now() > expiry - 5 * 60 * 1000;
}
