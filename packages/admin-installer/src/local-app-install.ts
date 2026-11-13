/**
 * The local install's last step: register an app with the local data server
 * and write the app's credentials file.
 *
 * Admin's install route and the terminal install (`cli:install-app-local`)
 * both call it, after the person approved the consent words and the app's
 * dependencies installed.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";

export type LocalInstallResult =
  | { ok: true; appId: string; secretPath: string }
  /** `error` is a sentence to show as is; `details` lists manifest validation errors. */
  | { ok: false; status: number; error: string; details?: string[] };

/**
 * Register the app whose manifest is `manifest`, from the folder `sourceDir`,
 * with the local data server at `dataServerUrl`. The server records the file
 * grants and answers the app's secret, which lands in
 * `~/.starkeep/app-creds/<appId>.json` with mode 0600.
 */
export async function installLocalApp(options: {
  manifest: Record<string, unknown>;
  sourceDir: string;
  dataServerUrl: string;
}): Promise<LocalInstallResult> {
  let resp: Response;
  try {
    resp = await fetch(`${options.dataServerUrl}/admin/apps/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: options.manifest, sourceDir: options.sourceDir }),
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Could not reach local-data-server at ${options.dataServerUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!resp.ok) return { ok: false, status: resp.status, ...(await installFailure(resp)) };

  const result = (await resp.json()) as { appId: string; hmacSecret: string };

  // The secret lives under the host's Starkeep folder, so an app loads it
  // whatever its working folder, and source folders stay free of host state.
  const credsDir = join(starkeepDir(), "app-creds");
  mkdirSync(credsDir, { recursive: true, mode: 0o700 });
  const secretPath = join(credsDir, `${result.appId}.json`);
  writeFileSync(
    secretPath,
    JSON.stringify(
      {
        appId: result.appId,
        hmacSecret: result.hmacSecret,
        dataServerUrl: options.dataServerUrl,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  // writeFileSync's mode applies only when it creates the file, so a
  // reinstall over a 0644 file would keep the loose mode.
  chmodSync(secretPath, 0o600);
  return { ok: true, appId: result.appId, secretPath };
}

/**
 * Turn the local data server's install refusal into `{ error, details? }`.
 * The server answers 400 `{ error: "ManifestValidationError", details }` or
 * 500 `{ error, message }`.
 */
async function installFailure(resp: Response): Promise<{ error: string; details?: string[] }> {
  const text = await resp.text();
  const parsed = parseJsonObject(text);
  if (parsed?.error === "ManifestValidationError" && Array.isArray(parsed.details)) {
    return {
      error: "The app's manifest failed validation.",
      details: parsed.details.map(String),
    };
  }
  if (typeof parsed?.message === "string") {
    return { error: `Install failed: ${parsed.message}` };
  }
  const quoted = text.trim() ? `: ${text.trim().slice(0, 500)}` : "";
  return { error: `Install failed: local-data-server answered ${resp.status}${quoted}` };
}

function parseJsonObject(
  text: string,
): { error?: unknown; message?: unknown; details?: unknown } | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}
