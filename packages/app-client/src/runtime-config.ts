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

// Mount as the body of a Next route segment (`export const GET = createRuntimeConfigHandler()`).
// The caller's route file must also `export const dynamic = "force-dynamic"`
// so Next reads env at request time rather than baking it into the build.
export function createRuntimeConfigHandler(): () => Response {
  return () => Response.json(getRuntimeConfig());
}
