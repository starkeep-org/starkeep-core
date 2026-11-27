/**
 * The handler environment variables a cloud install fills in.
 *
 * A manifest declares a platform value its handler wants by listing the key
 * with an empty value. The install fills each such key with the deployment's
 * value before it deploys, and the registry records the filled-in manifest.
 * A reader that compares the recorded manifest with the folder's must treat a
 * filled key as matching the folder's empty one, or every web app reads as
 * changed after its own install.
 */
export const PLATFORM_ENV_KEYS = [
  "STARKEEP_API_GATEWAY_URL",
  "STARKEEP_USER_POOL_ID",
  "STARKEEP_USER_POOL_CLIENT_ID",
  "STARKEEP_IDENTITY_POOL_ID",
  "STARKEEP_LAMBDA_CONCURRENCY",
] as const;

export type PlatformEnvKey = (typeof PLATFORM_ENV_KEYS)[number];

/** The `config.json` fields the platform values come from. */
export interface PlatformEnvSource {
  publicBaseUrl?: unknown;
  apiGatewayUrl?: unknown;
  userPoolId?: unknown;
  identityPoolId?: unknown;
  lambdaConcurrency?: unknown;
  cloudAppsUserPoolClientId?: unknown;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The value a deploy writes now for each platform key. */
export function platformEnvValues(config: PlatformEnvSource): Record<PlatformEnvKey, string> {
  return {
    // The browser-facing base URL is the CloudFront distribution, so the
    // browser's whole fan-out goes through the edge cache. Server-to-server
    // calls keep the gateway (STARKEEP_CLOUD_DATA_BASE in pulumi-program.ts).
    STARKEEP_API_GATEWAY_URL: text(config.publicBaseUrl) || text(config.apiGatewayUrl),
    STARKEEP_USER_POOL_ID: text(config.userPoolId),
    // The cloud-apps client, never the admin client: the broker and both
    // gateway authorizers accept only its tokens.
    STARKEEP_USER_POOL_CLIENT_ID: text(config.cloudAppsUserPoolClientId),
    STARKEEP_IDENTITY_POOL_ID: text(config.identityPoolId),
    // The account's invocation ceiling, so an app that fans out on a user's
    // behalf can size that fan-out. Ten is the unraised account limit.
    STARKEEP_LAMBDA_CONCURRENCY: String(
      typeof config.lambdaConcurrency === "number" ? config.lambdaConcurrency : 10,
    ),
  };
}

type HandlersOf = {
  infraRequirements?: { compute?: { handlers?: Array<{ env?: Record<string, unknown> }> } };
};

/**
 * `deployed` with each platform key the install filled set back to empty,
 * wherever `folder`'s handler at the same position leaves that key empty and
 * the filled value is still the one a deploy would write (`now`). A value the
 * deployment has since changed, such as the public address after a custom
 * domain, stays, so the app reads as behind. Everything else stays as
 * recorded, so a real change still shows.
 */
export function withoutFilledPlatformEnv<T>(
  deployed: T,
  folder: unknown,
  now: Record<PlatformEnvKey, string>,
): T {
  const out = structuredClone(deployed) as T & HandlersOf;
  const deployedHandlers = out.infraRequirements?.compute?.handlers;
  const folderHandlers = (folder as HandlersOf | null)?.infraRequirements?.compute?.handlers;
  if (!Array.isArray(deployedHandlers) || !Array.isArray(folderHandlers)) return out;
  deployedHandlers.forEach((handler, i) => {
    const declared = folderHandlers[i]?.env;
    if (!handler?.env || !declared) return;
    for (const key of PLATFORM_ENV_KEYS) {
      if (declared[key] === "" && key in handler.env && handler.env[key] === now[key]) {
        handler.env[key] = "";
      }
    }
  });
  return out;
}
