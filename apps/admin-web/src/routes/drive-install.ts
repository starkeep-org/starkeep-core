/**
 * Install (or re-install / update) the Starkeep Drive built-in app — the
 * User-Data-Owner identity for all shared-record sync.
 *
 * Mirrors the cloud-data-server install route: runs the installer's
 * `install-drive` operation as a detached process and streams its output to
 * the browser via SSE (see `lib/install-stream.ts`). Must run AFTER the
 * cloud-data-server install (which writes the foundational outputs this operation
 * reads from ~/.starkeep/config.json) — the wizard sequences the two passes.
 *
 * Request body: { reattach?, resumeFrom? }. The route mints the signed-in admin's
 * credentials itself (`lib/admin-auth.ts`).
 *
 * Response: text/event-stream
 *   data:  <stdout/stderr line>
 *   event: done   data: {}
 *   event: error  data: { message: string, code?: "EXPIRED_TOKEN" }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { REPO_ROOT } from "@starkeep/operator/commands";
import { operationCommand, PLATFORM_RUN_OWNERS } from "@starkeep/operator/operation-runs";
import { getRegion } from "../lib/cloud-config";
import { installStream } from "../lib/install-stream";
import { installerEnv } from "@starkeep/admin-installer/aws-env";
import { requireAdmin } from "../lib/admin-auth";

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
    reattach?: boolean;
    resumeFrom?: string;
  };

  // A reconnect only follows a run, so it needs no sign-in. Anything that may
  // start a run mints the admin's credentials here, on the server.
  const admin = body.reattach === true ? null : await requireAdmin();
  if (admin instanceof Response) return admin;

  if (!existsSync(CONFIG_PATH)) {
    return new Response(JSON.stringify({ error: `~/.starkeep/config.json not found` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
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
  if (
    !preConfig.auroraEndpoint ||
    !preConfig.s3Bucket ||
    !preConfig.apiGatewayId ||
    !preConfig.authorizerId
  ) {
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
    ...(admin
      ? installerEnv(
          {
            accessKeyId: admin.stsCredentials.accessKeyId,
            secretAccessKey: admin.stsCredentials.secretAccessKey,
            sessionToken: admin.stsCredentials.sessionToken,
          },
          region,
        )
      : {}),
  };

  return installStream({
    key: "drive",
    // The CLI names the same owner, so either tool follows the other's run.
    owner: PLATFORM_RUN_OWNERS.installDrive,
    noun: "Drive install",
    ...operationCommand("install-drive", {}),
    cwd: REPO_ROOT,
    env: spawnEnv,
    reattach: body.reattach === true,
    ...(typeof body.resumeFrom === "string" ? { resumeFrom: body.resumeFrom } : {}),
    failureMessage: (code) => `Installer exited with code ${code}`,
    onSuccess: () => ({ event: "done", data: {} }),
  });
}
