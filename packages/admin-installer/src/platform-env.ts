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

type HandlersOf = {
  infraRequirements?: { compute?: { handlers?: Array<{ env?: Record<string, unknown> }> } };
};

/**
 * `deployed` with each platform key the install filled set back to empty,
 * wherever `folder`'s handler at the same position leaves that key empty.
 * Everything else stays as recorded, so a real change still shows.
 */
export function withoutFilledPlatformEnv<T>(deployed: T, folder: unknown): T {
  const out = structuredClone(deployed) as T & HandlersOf;
  const deployedHandlers = out.infraRequirements?.compute?.handlers;
  const folderHandlers = (folder as HandlersOf | null)?.infraRequirements?.compute?.handlers;
  if (!Array.isArray(deployedHandlers) || !Array.isArray(folderHandlers)) return out;
  deployedHandlers.forEach((handler, i) => {
    const declared = folderHandlers[i]?.env;
    if (!handler?.env || !declared) return;
    for (const key of PLATFORM_ENV_KEYS) {
      if (declared[key] === "" && key in handler.env) handler.env[key] = "";
    }
  });
  return out;
}
