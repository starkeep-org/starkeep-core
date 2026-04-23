import type { CognitoConfig, STSCredentials } from "./cognito-auth";

export interface CloudConfig {
  stackPrefix: string;
  s3Bucket: string;
  s3Region: string;
  auroraEndpoint: string;
  apiGatewayUrl?: string;
  cognitoConfig: CognitoConfig;
  cognitoRefreshToken: string;
}

export interface CloudSetupState {
  state: "unconfigured" | "configured";
  has_credentials: boolean;
}

const CONFIG_KEY = "starkeep:cloud-config";
const CREDENTIALS_KEY = "starkeep:cloud-credentials";

export async function readCloudConfig(): Promise<CloudConfig | null> {
  const raw = localStorage.getItem(CONFIG_KEY);
  return raw ? (JSON.parse(raw) as CloudConfig) : null;
}

export async function writeCloudConfig(config: CloudConfig): Promise<void> {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export async function readCloudCredentials(): Promise<STSCredentials | null> {
  const raw = localStorage.getItem(CREDENTIALS_KEY);
  return raw ? (JSON.parse(raw) as STSCredentials) : null;
}

export async function writeCloudCredentials(creds: STSCredentials): Promise<void> {
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(creds));
}

export async function getCloudSetupState(): Promise<CloudSetupState> {
  const config = await readCloudConfig();
  return {
    state: config ? "configured" : "unconfigured",
    has_credentials: !!config,
  };
}
