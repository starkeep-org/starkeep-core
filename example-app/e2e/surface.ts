/**
 * Which surface the spec walks: the local platform `global-setup.ts` boots,
 * or the cloud test stack `cloud-setup.ts` prepares.
 *
 * The spec reads this to branch the few steps that differ by surface: the
 * local server's own request checks, the status S3 answers a presigned PUT
 * with, public links, sessions and the MCP client's credential.
 */

import { readFileSync } from "node:fs";

export type Surface = "local" | "cloud";

export const SURFACE: Surface = process.env.E2E_SURFACE === "cloud" ? "cloud" : "local";

/** What `@starkeep/e2e-aws`'s `app-cloud-run.ts prepare` wrote for this run. */
export type CloudRun =
  | { enabled: false }
  | {
      enabled: true;
      appId: string;
      appUrl: string;
      gatewayUrl: string;
      storageState: string;
      user: { email: string; password: string };
      delegationTokens: { read: string; readwrite: string };
    };

let cached: CloudRun | undefined;

/** The cloud run. Only the cloud project calls this. */
export function cloudRun(): CloudRun {
  if (cached) return cached;
  const path = process.env.E2E_CLOUD_RUN;
  if (!path) throw new Error("E2E_CLOUD_RUN is unset; run the cloud project's config");
  cached = JSON.parse(readFileSync(path, "utf8")) as CloudRun;
  return cached;
}

/** The enabled cloud run, for a step that runs only in the cloud. */
export function enabledCloudRun(): Extract<CloudRun, { enabled: true }> {
  const run = cloudRun();
  if (!run.enabled) throw new Error("the cloud run is not enabled");
  return run;
}
