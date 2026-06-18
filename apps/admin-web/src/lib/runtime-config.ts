// Browser-side accessor for the runtime config served by
// /api/runtime-config. The admin-web UI makes direct calls to the
// local-data-server and links to the Drive app; their URLs are loopback
// defaults on a real install but ephemeral in a harness-booted stack. Fetching
// them once (cached for the page lifetime) lets the browser use the configured
// URLs instead of hardcoded ports — which is what unblocks e2e of the
// dashboard, wizard, and watch-management UI.

export interface RuntimeConfig {
  localDataServerUrl: string;
  driveUrl: string;
}

export const RUNTIME_CONFIG_DEFAULTS: RuntimeConfig = {
  localDataServerUrl: "http://127.0.0.1:9820",
  driveUrl: "http://localhost:9830",
};

let cached: Promise<RuntimeConfig> | null = null;

export function getRuntimeConfig(): Promise<RuntimeConfig> {
  if (!cached) {
    cached = fetch("/api/runtime-config")
      .then((r) => (r.ok ? (r.json() as Promise<RuntimeConfig>) : RUNTIME_CONFIG_DEFAULTS))
      .catch(() => RUNTIME_CONFIG_DEFAULTS);
  }
  return cached;
}

/** Convenience: just the local-data-server base URL. */
export async function localDataServerUrl(): Promise<string> {
  return (await getRuntimeConfig()).localDataServerUrl;
}
