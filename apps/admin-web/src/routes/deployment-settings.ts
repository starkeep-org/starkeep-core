/**
 * The deployment's settings: the canonical thresholds, the advisory
 * resolutions and the trash window, which hold for every node and the cloud.
 *
 * ## Where a change goes
 *
 * - **With a cloud.** The document is an SSM parameter that only Manager
 *   writes, so this route hops to Manager from the operator's session and
 *   writes it there (`changeDeploymentSettingsParameter`). It then asks this
 *   machine's local data server to read the document again, so this machine
 *   stamps with the new value at once. Other nodes and the cloud pick it up
 *   within a minute.
 * - **Without a cloud.** The local data server keeps the document in its own
 *   config, so this route forwards the change there.
 *
 * Reading goes through the local data server either way: it holds the value
 * this machine actually stamps with.
 */

import {
  changeDeploymentSettingsParameter,
  type AwsCredentials,
} from "@starkeep/admin-installer/app-creds";
import { localDataServerUrl } from "../lib/runtime-config";
import { managerCredentials, readStarkeepConfig, type StarkeepConfig } from "../lib/manager-credentials";
import type { STSCredentials } from "../lib/cognito-auth";

interface ChangeBody {
  change?: unknown;
  credentials?: STSCredentials;
  stackPrefix?: string;
  region?: string;
}

async function forward(path: string, init: RequestInit): Promise<Response> {
  const base = await localDataServerUrl();
  try {
    const res = await fetch(`${base}${path}`, { ...init, cache: "no-store" });
    return Response.json(await res.json(), { status: res.status });
  } catch (err) {
    // A daemon that is not running is the ordinary state of a fresh machine.
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), offline: true },
      { status: 503 },
    );
  }
}

/** The deployment's settings as this machine holds them. */
export async function GET(): Promise<Response> {
  return forward("/library/deployment-settings", {});
}

/** Change the deployment's settings. Body: `{ change, credentials?, stackPrefix?, region? }`. */
export async function PUT(req: Request): Promise<Response> {
  let body: ChangeBody;
  try {
    body = (await req.json()) as ChangeBody;
  } catch {
    return Response.json({ error: "Body is not valid JSON" }, { status: 400 });
  }

  let config: StarkeepConfig | null = null;
  try {
    config = readStarkeepConfig();
  } catch {
    // No config at all: a fresh machine with no cloud.
  }

  if (!config?.apiGatewayUrl) {
    return forward("/library/deployment-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body.change ?? {}),
    });
  }

  const { credentials, stackPrefix, region } = body;
  if (!credentials || !stackPrefix || !region) {
    return Response.json(
      { error: "This machine syncs with a cloud. Sign in to change the deployment's settings." },
      { status: 401 },
    );
  }

  let awsCreds: AwsCredentials;
  try {
    awsCreds = await managerCredentials(config, credentials, region, "starkeep-deployment-settings");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/deployment-settings] Manager hop failed", message);
    return Response.json({ error: message }, { status: 500 });
  }

  let result;
  try {
    result = await changeDeploymentSettingsParameter({ stackPrefix, change: body.change ?? {}, region, awsCreds });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/deployment-settings] write failed", message);
    return Response.json({ error: message }, { status: 500 });
  }
  if (!result.ok) {
    return Response.json({ error: "the settings are not valid", problems: result.problems }, { status: 422 });
  }

  // This machine reads the new value now rather than within a minute. A
  // daemon that is down reads it when it starts.
  await forward("/library/deployment-settings/refresh", { method: "POST" });
  return Response.json({ ok: true, settings: result.settings });
}
