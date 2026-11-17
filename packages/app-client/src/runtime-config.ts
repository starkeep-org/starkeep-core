// Standard runtime-config shape served to the browser. Cloud apps populate
// these from the STARKEEP_* env block their compute.handlers[].env declares;
// local-only apps see all fields undefined and should fall back to the
// same-origin local-data proxy.
export interface RuntimeConfig {
  /**
   * The deployment's browser-facing base: the CloudFront distribution, or the
   * raw gateway on a deployment without one. Not where the consent pages
   * answer; see `connectUrl`.
   */
  apiGatewayUrl?: string;
  region?: string;
  userPoolId?: string;
  userPoolClientId?: string;
  identityPoolId?: string;
  s3Bucket?: string;
  s3Region?: string;
  /**
   * The platform's consent page for this app, where a user creates a token
   * for an outside client. Cloud only.
   */
  connectUrl?: string;
  /** The platform's page where a user lists and revokes outside clients. Cloud only. */
  connectionsUrl?: string;
}

// The consent pages answer only on the gateway's execute-api hostname, never
// on CloudFront. The installer sets STARKEEP_CLOUD_DATA_BASE to that URL on
// every app handler; `delegation.ts` fetches the token keys from it too.
const CONNECT_PATH = "/connect";
const CONNECTIONS_PATH = "/connections";

export function getRuntimeConfig(): RuntimeConfig {
  const env = process.env;
  const gateway = env.STARKEEP_CLOUD_DATA_BASE?.replace(/\/+$/, "");
  const appId = env.STARKEEP_APP_ID;
  const pages =
    gateway && appId
      ? {
          connectUrl: `${gateway}${CONNECT_PATH}?app=${encodeURIComponent(appId)}`,
          connectionsUrl: `${gateway}${CONNECTIONS_PATH}`,
        }
      : {};
  return {
    apiGatewayUrl: env.STARKEEP_API_GATEWAY_URL || undefined,
    region: env.AWS_REGION || undefined,
    userPoolId: env.STARKEEP_USER_POOL_ID || undefined,
    userPoolClientId: env.STARKEEP_USER_POOL_CLIENT_ID || undefined,
    identityPoolId: env.STARKEEP_IDENTITY_POOL_ID || undefined,
    s3Bucket: env.STARKEEP_FILES_BUCKET || undefined,
    s3Region: env.AWS_REGION || undefined,
    ...pages,
  };
}

// Mount as a GET route (`app.get("/api/runtime-config", createRuntimeConfigHandler())`
// under Hono). The handler reads `process.env` on every call, which is the
// point: an installed app's Lambda gets its pool and bucket ids from the
// environment the installer set, so nothing here may be baked into the build.
export function createRuntimeConfigHandler(): () => Response {
  return () => Response.json(getRuntimeConfig());
}
