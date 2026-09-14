// Standard runtime-config shape served to the browser. Cloud apps populate
// these from the STARKEEP_* env block their compute.handlers[].env declares;
// local-only apps see all fields undefined and should fall back to the
// same-origin local-data proxy.
export interface RuntimeConfig {
  apiGatewayUrl?: string;
  region?: string;
  userPoolId?: string;
  userPoolClientId?: string;
  identityPoolId?: string;
  s3Bucket?: string;
  s3Region?: string;
}

export function getRuntimeConfig(): RuntimeConfig {
  const env = process.env;
  return {
    apiGatewayUrl: env.STARKEEP_API_GATEWAY_URL || undefined,
    region: env.AWS_REGION || undefined,
    userPoolId: env.STARKEEP_USER_POOL_ID || undefined,
    userPoolClientId: env.STARKEEP_USER_POOL_CLIENT_ID || undefined,
    identityPoolId: env.STARKEEP_IDENTITY_POOL_ID || undefined,
    s3Bucket: env.STARKEEP_FILES_BUCKET || undefined,
    s3Region: env.AWS_REGION || undefined,
  };
}

// Mount as a GET route (`app.get("/api/runtime-config", createRuntimeConfigHandler())`
// under Hono). The handler reads `process.env` on every call, which is the
// point: an installed app's Lambda gets its pool and bucket ids from the
// environment the installer set, so nothing here may be baked into the build.
export function createRuntimeConfigHandler(): () => Response {
  return () => Response.json(getRuntimeConfig());
}
