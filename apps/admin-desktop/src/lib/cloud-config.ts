/**
 * Types and helpers for reading/writing the two Starkeep cloud config files
 * that live in ~/.starkeep/ and are managed by Tauri commands.
 *
 * cloud-config.json    — pool IDs, bucket name, DSQL endpoint, refresh token.
 *                        Safe to store at rest; contains no short-lived secrets.
 * cloud-credentials.json — Short-lived STS credentials (rotate every 45 min).
 */

import { invoke } from "@tauri-apps/api/core";
import type { CognitoConfig, STSCredentials } from "./cognito-auth";

/**
 * Returns true when running inside the Tauri desktop app.
 * __TAURI_INTERNALS__ is injected synchronously by the Tauri webview before
 * any page scripts run; it is absent in plain browser / Vite dev sessions.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Thin wrapper around Tauri invoke that throws a clear error when called
 * outside the Tauri runtime so callers can handle it gracefully.
 */
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

/** Subset safe to share/export between devices (no credentials or tokens). */
export type CloudConfigExport = Omit<CloudConfig, "cognitoRefreshToken">;

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

export async function writeCloudConfig(config: CloudConfig): Promise<void> {
  await tauriInvoke("write_cloud_config", { configJson: JSON.stringify(config, null, 2) });
}

export async function readCloudCredentials(): Promise<STSCredentials | null> {
  const raw = await tauriInvoke<string | null>("read_cloud_credentials");
  if (!raw) return null;
  return JSON.parse(raw) as STSCredentials;
}

export async function writeCloudCredentials(creds: STSCredentials): Promise<void> {
  await tauriInvoke("write_cloud_credentials", { credsJson: JSON.stringify(creds, null, 2) });
}

export async function writeBootstrapTemplate(yaml: string): Promise<string> {
  return tauriInvoke<string>("write_bootstrap_template", { yaml });
}

/** Returns true if the stored STS credentials expire within the next 5 minutes. */
export function credentialsNearExpiry(creds: STSCredentials): boolean {
  const expiry = new Date(creds.expiration).getTime();
  return Date.now() > expiry - 5 * 60 * 1000;
}
