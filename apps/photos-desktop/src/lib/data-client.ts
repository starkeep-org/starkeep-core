import { readCloudConfig } from "./cloud-config";
import { refreshTokens } from "./cognito-auth";

export type DataSourceMode = "local" | "remote";
export const LOCAL_URL = "http://127.0.0.1:9820";

let tokenCache: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  const config = await readCloudConfig();
  if (!config?.cognitoConfig || !config.cognitoRefreshToken) {
    console.warn("[data-client] No Cognito config or refresh token in cloud config");
    return null;
  }
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    console.debug("[data-client] Using cached access token (expires in", Math.round((tokenCache.expiresAt - now) / 1000), "s)");
    return tokenCache.accessToken;
  }
  console.debug("[data-client] Refreshing access token via Cognito...");
  try {
    const tokens = await refreshTokens(config.cognitoConfig, config.cognitoRefreshToken);
    tokenCache = { accessToken: tokens.accessToken, expiresAt: now + tokens.expiresIn * 1000 };
    console.debug("[data-client] Access token refreshed, expires in", tokens.expiresIn, "s");
    return tokenCache.accessToken;
  } catch (err) {
    console.error("[data-client] Token refresh failed:", err);
    throw err;
  }
}

export async function resolveDataSource(mode: DataSourceMode): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
}> {
  if (mode === "remote") {
    const config = await readCloudConfig();
    if (config?.apiGatewayUrl) {
      console.debug("[data-client] Remote mode, apiGatewayUrl:", config.apiGatewayUrl);
      const token = await getAccessToken();
      if (!token) console.warn("[data-client] No access token — request will be unauthenticated");
      return {
        baseUrl: config.apiGatewayUrl.replace(/\/$/, ""),
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      };
    }
    console.warn("[data-client] Remote mode but no apiGatewayUrl in cloud config — falling back to local");
  }
  return { baseUrl: LOCAL_URL, headers: {} };
}
