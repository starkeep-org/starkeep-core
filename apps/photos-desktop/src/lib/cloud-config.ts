import { invoke } from "@tauri-apps/api/core";
import type { CognitoConfig, STSCredentials } from "./cognito-auth";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`Tauri not available (running outside desktop app). Command: ${cmd}`);
  }
  return invoke<T>(cmd, args);
}

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

export async function getCloudSetupState(): Promise<CloudSetupState> {
  return tauriInvoke<CloudSetupState>("get_cloud_setup_state");
}

export async function readCloudConfig(): Promise<CloudConfig | null> {
  const raw = await tauriInvoke<string | null>("read_cloud_config");
  if (!raw) return null;
  return JSON.parse(raw) as CloudConfig;
}

export async function readCloudCredentials(): Promise<STSCredentials | null> {
  const raw = await tauriInvoke<string | null>("read_cloud_credentials");
  if (!raw) return null;
  return JSON.parse(raw) as STSCredentials;
}
