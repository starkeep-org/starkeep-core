/**
 * Install (or re-install / update) the Starkeep Drive built-in app — the
 * User-Data-Owner identity for all shared-record sync.
 *
 * Mirrors the cloud-data-server install route: runs
 * `packages/admin-installer/scripts/cli-install-drive.ts` as a detached
 * process and streams its output to the browser via SSE (see
 * `lib/install-stream.ts`). Must run AFTER the
 * cloud-data-server install (which writes the foundational outputs this CLI
 * reads from ~/.starkeep/config.json) — the wizard sequences the two passes.
 *
 * Request body: { accessKeyId, secretAccessKey, sessionToken, reattach?, resumeFrom? }
 *
 * Response: text/event-stream
 *   data:  <stdout/stderr line>
 *   event: done   data: {}
 *   event: error  data: { message: string, code?: "EXPIRED_TOKEN" }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { REPO_ROOT } from "../lib/exec-commands";
import { getRegion } from "../lib/cloud-config";
import { installStream } from "../lib/install-stream";

const STARKEEP_DIR = starkeepDir();
const CONFIG_PATH = join(STARKEEP_DIR, "config.json");

interface StarkeepConfig {
  userPoolId: string;
  auroraEndpoint?: string;
  s3Bucket?: string;
  apiGatewayId?: string;
  authorizerId?: string;
}


export async function POST(req: Request) {
  const body = (await req.json()) as {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    reattach?: boolean;
    resumeFrom?: string;
  };

  if (!body.accessKeyId || !body.secretAccessKey || !body.sessionToken) {
    return new Response(
      JSON.stringify({ error: "accessKeyId, secretAccessKey, sessionToken required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!existsSync(CONFIG_PATH)) {
    return new Response(
      JSON.stringify({ error: `~/.starkeep/config.json not found` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const preConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;

  if (!preConfig.userPoolId) {
    return new Response(
      JSON.stringify({
        error:
          "~/.starkeep/config.json has no userPoolId — complete the wizard's Stack outputs step first",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  // Drive depends on the cloud-data-server foundational outputs being present.
  if (!preConfig.auroraEndpoint || !preConfig.s3Bucket || !preConfig.apiGatewayId || !preConfig.authorizerId) {
    return new Response(
      JSON.stringify({
        error:
          "cloud-data-server outputs missing from config — run the cloud-data-server install first",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const region = getRegion(preConfig);

  const spawnEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: body.accessKeyId,
    AWS_SECRET_ACCESS_KEY: body.secretAccessKey,
    AWS_SESSION_TOKEN: body.sessionToken,
    AWS_REGION: region,
  };

  return installStream({
    key: "drive",
    noun: "Drive install",
    command: "pnpm",
    args: ["--filter", "@starkeep/admin-installer", "cli:install-drive", "--non-interactive"],
    cwd: REPO_ROOT,
    env: spawnEnv,
    reattach: body.reattach === true,
    ...(typeof body.resumeFrom === "string" ? { resumeFrom: body.resumeFrom } : {}),
    failureMessage: (code) => `Installer exited with code ${code}`,
    onSuccess: () => ({ event: "done", data: {} }),
  });
}
