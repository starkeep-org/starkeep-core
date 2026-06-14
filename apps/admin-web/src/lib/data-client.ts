import { readCloudConfig, readCognitoSession, writeCognitoSession } from "./cloud-config";
import { refreshTokens } from "./cognito-auth";
import { localDataServerUrl } from "./runtime-config";

export type DataSourceMode = "local" | "remote";

let tokenCache: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  const config = await readCloudConfig();
  const session = await readCognitoSession();
  if (!config?.cognitoConfig || !session?.refreshToken) return null;
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.accessToken;
  const tokens = await refreshTokens(config.cognitoConfig, session.refreshToken);
  await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });
  tokenCache = { accessToken: tokens.accessToken, expiresAt: now + tokens.expiresIn * 1000 };
  return tokens.accessToken;
}

export async function resolveDataSource(mode: DataSourceMode): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
}> {
  if (mode === "remote") {
    const config = await readCloudConfig();
    if (config?.apiGatewayUrl) {
      const token = await getAccessToken();
      return {
        baseUrl: config.apiGatewayUrl.replace(/\/$/, ""),
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      };
    }
  }
  return { baseUrl: await localDataServerUrl(), headers: {} };
}
