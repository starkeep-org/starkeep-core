/**
 * The local data server's app registry, as admin-web's routes and the CLI act
 * on it: uninstall an app, and delete the data an uninstall kept.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { stopById } from "./daemons";
import { recordWanted } from "./services";
import { localDataServerUrlFromEnv } from "./urls";

export type LocalAppResult =
  | { ok: true }
  | { ok: false; status: number; error: string; detail?: string };

/** Whether the local data server answers its health check. */
export async function localDataServerUp(): Promise<boolean> {
  try {
    return (await fetch(`${localDataServerUrlFromEnv()}/health`)).ok;
  } catch {
    return false;
  }
}

/**
 * Uninstall an app from this computer. Its data stays, as an uninstall keeps
 * an app's data until a separate delete.
 */
export async function uninstallLocalApp(appId: string): Promise<LocalAppResult> {
  // Stop the app's server before its registry row goes. Otherwise the running
  // process keeps calling the data server with a secret that no longer
  // authenticates. Best effort: an app that is not running is fine.
  await stopById(appId);

  let resp: Response;
  try {
    resp = await fetch(`${localDataServerUrlFromEnv()}/admin/apps/${encodeURIComponent(appId)}`, {
      method: "DELETE",
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: "Could not reach local-data-server",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: "Uninstall failed", detail: await resp.text() };
  }

  const secretPath = join(starkeepDir(), "app-creds", `${appId}.json`);
  if (existsSync(secretPath)) unlinkSync(secretPath);
  // An uninstalled app is no longer one to run, so `starkeep start` with no
  // names must not bring it back from the discovery folders.
  recordWanted(appId, false);
  return { ok: true };
}

/**
 * Delete the data an uninstall kept. `confirm` is the app id the person typed
 * back; the data server refuses a mismatch, an installed app and an app with
 * no kept data.
 */
export async function deleteKeptAppData(appId: string, confirm: string): Promise<LocalAppResult> {
  let resp: Response;
  try {
    resp = await fetch(
      `${localDataServerUrlFromEnv()}/admin/apps/${encodeURIComponent(appId)}/delete-data`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm }),
      },
    );
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: "Could not reach local-data-server",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (resp.ok) return { ok: true };
  const text = await resp.text();
  let error = text;
  try {
    error = (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    /* plain text */
  }
  return { ok: false, status: resp.status, error };
}
