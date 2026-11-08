/**
 * Whether the cloud runs this checkout's build of the cloud data server.
 *
 * The cloud data server install records the build it deployed in an SSM
 * parameter that only Manager reads (`@starkeep/admin-installer/cloud-data-server-build`),
 * so this route hops to Manager from the operator's session, as the
 * deployment-settings route does. It compares that record with the
 * `build-info.json` the checkout's last build wrote, and with the checkout's
 * current commit.
 *
 * Body: `{ credentials, stackPrefix, region }`.
 * Response: `{ comparison, cloud, local, head }`, with `cloud` and `local` each
 * a build record or null, and `head` the checkout's commit or null.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  compareCloudDataServerBuild,
  getCloudDataServerBuildParameter,
  readLocalCloudDataServerBuild,
} from "@starkeep/admin-installer/cloud-data-server-build";
import { REPO_ROOT } from "../lib/exec-commands";
import { managerCredentials, readStarkeepConfig } from "../lib/manager-credentials";
import type { STSCredentials } from "../lib/cognito-auth";

const run = promisify(execFile);

interface Body {
  credentials?: STSCredentials;
  stackPrefix?: string;
  region?: string;
}

async function checkoutCommit(): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Body is not valid JSON" }, { status: 400 });
  }
  const { credentials, stackPrefix, region } = body;
  if (!credentials || !stackPrefix || !region) {
    return Response.json(
      { error: "Sign in to compare the cloud's build with this checkout's." },
      { status: 401 },
    );
  }

  let cloud;
  try {
    const awsCreds = await managerCredentials(
      readStarkeepConfig(),
      credentials,
      region,
      "starkeep-build-check",
    );
    cloud = await getCloudDataServerBuildParameter({ stackPrefix, region, awsCreds });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/cloud-data-server/build] read failed", message);
    return Response.json({ error: message }, { status: 500 });
  }

  const local = readLocalCloudDataServerBuild();
  const head = await checkoutCommit();
  return Response.json({
    comparison: compareCloudDataServerBuild({ cloud, local, head }),
    cloud,
    local,
    head,
  });
}
