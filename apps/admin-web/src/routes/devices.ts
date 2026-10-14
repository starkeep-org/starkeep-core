/**
 * Pairing, listing and revoking phones.
 *
 * ## Why pairing happens here
 *
 * Pairing is a phone's install step. An elevated person approves a device once,
 * the approval mints the device's credential, and the device then syncs with
 * nothing more to do. Installing a cloud or local app has the same shape: the
 * privileged console mints a credential, and the request path only ever
 * verifies one. Nothing in the cloud's request path can write a credential, and
 * pairing keeps it that way.
 *
 * The browser generates the device's keypair (`lib/device-pairing.ts`) and
 * sends only the public half here. The private half goes from the browser into
 * a QR code that the phone scans, and never reaches this server.
 *
 * ## What is stored, and where
 *
 * - **The key.** The device's public key, under
 *   `/${stackPrefix}/app-creds/_device-<id>`, with the apps it may act as. This
 *   is the authority: the broker accepts the device's signatures while the
 *   parameter exists. Revoking deletes it.
 * - **The list.** An entry in the library's settings file (`pairedDevices`),
 *   written through the local data server. The file syncs to every machine, so
 *   a phone paired here can be revoked from any machine. The entry holds the
 *   id, label, app ids and pairing time, and no key.
 *
 * Pairing writes the entry before the key, and revoking deletes the key before
 * the entry. Either way a failure part-way leaves an entry without a key, which
 * is harmless, and never a key without an entry, which would be a phone that
 * syncs and that nobody can find to revoke. For the same reason pairing refuses
 * when the local data server is down.
 *
 * ## Why the operator's own session does not make the SSM call
 *
 * The credentials that arrive in the request body are the admin-app role, and
 * that role deliberately holds no write on `/${stackPrefix}/app-creds/*` — its
 * only SSM grant is the Pulumi passphrase. Writing app credentials is Manager's
 * one standing non-IAM capability (see `data-roles-and-permissions.md`), which
 * is what keeps the federated human from being a superuser over the credential
 * prefix. So this route does the same admin-app → Manager hop the installer
 * does before minting a per-app HMAC secret or the CloudFront signing key; the
 * trust policy and the `sts:AssumeRole` grant for it already exist from
 * bootstrap, so no IAM change is involved.
 *
 * See `~/projects/starkeep/plan-mobile-qr-pairing-2026-10-13.md`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
// The `/app-creds` subpath, not the package root. The root barrel pulls in the
// whole installer — Pulumi, the orchestrator, the local registry — and a route
// importing it fails to build on a module several layers away that has nothing
// to do with pairing.
import {
  putDeviceKeyParameter,
  deleteDeviceKeyParameter,
} from "@starkeep/admin-installer/app-creds";
import type { AwsCredentials } from "@starkeep/admin-installer/app-creds";
// Likewise a subpath: `session` imports nothing but the STS client.
import { roleChain } from "@starkeep/admin-installer/session";
import type { STSCredentials } from "../lib/cognito-auth";

const CONFIG_PATH = join(starkeepDir(), "config.json");

/**
 * The apps a paired phone may act as. Set here rather than taken from the
 * request, because it decides what the device's key opens. A phone syncs
 * through Starkeep Drive and nothing else.
 */
export const PHONE_APP_IDS: readonly string[] = ["starkeep-drive"];

interface StarkeepConfig {
  stackPrefix?: string;
  accountId?: string;
  managerRoleArn?: string;
  publicBaseUrl?: string;
  apiGatewayUrl?: string;
}

function localDataServer(): string {
  return process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";
}

function readConfig(): StarkeepConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error("~/.starkeep/config.json not found — complete the cloud setup first");
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;
}

/**
 * The two credential shapes differ by one field: admin-web carries `expiration`
 * as the ISO string it came off the wire as, the installer as a `Date`. Mapped
 * explicitly rather than cast, so a future field added to either side is a
 * compile error here instead of an `undefined` at runtime.
 */
function toAwsCreds(c: STSCredentials): AwsCredentials {
  return {
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken,
    expiration: new Date(c.expiration),
  };
}

/**
 * Manager credentials for this one call, from the operator's session.
 *
 * The role ARN is read from `~/.starkeep/config.json` rather than taken from
 * the request body: a role ARN is the one input here that decides *which*
 * identity does a privileged write, and it is already on disk. Same fallback as
 * the uninstall CLI for configs written before `managerRoleArn` was recorded.
 */
async function managerCredentials(
  config: StarkeepConfig,
  operatorCreds: STSCredentials,
  region: string,
): Promise<AwsCredentials> {
  const managerRoleArn =
    config.managerRoleArn ??
    (config.accountId && config.stackPrefix
      ? `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-manager-role`
      : null);
  if (!managerRoleArn) {
    throw new Error(
      "~/.starkeep/config.json has no managerRoleArn (and no accountId to derive it from) — complete the cloud setup first",
    );
  }

  return roleChain([managerRoleArn], {
    baseCredentials: toAwsCreds(operatorCreds),
    region,
    // Distinguishable from an install in CloudTrail — this is the one Manager
    // call that is not part of installing or uninstalling something.
    sessionPrefix: "starkeep-pair-device",
    // No propagation retry: Manager has existed since bootstrap, so a denial
    // here is a real answer (usually an expired sign-in) and the operator is
    // watching a spinner while we decide that.
    assumeAttempts: 1,
  });
}

/** Must match the broker's `isValidDeviceId` — this name becomes a path. */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 32-byte Ed25519 key in a 44-byte SPKI wrapper, base64 — always 60 chars. */
const SPKI_RE = /^[A-Za-z0-9+/]{59}=$/;

/** Must match `MAX_DEVICE_LABEL_LENGTH` in the settings file's rules. */
const MAX_LABEL_LENGTH = 100;

interface PairBody {
  credentials: STSCredentials;
  stackPrefix: string;
  region: string;
  deviceId: string;
  publicKeySpki: string;
  userId?: string | null;
  label?: string | null;
}

type ListCall =
  | { ok: true; body: { devices?: unknown; problems?: unknown } }
  | { ok: false; status: number; error: string };

/** Call the local data server's paired-device list, reporting a daemon that is down as such. */
async function callList(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<ListCall> {
  let res: Response;
  try {
    res = await fetch(`${localDataServer()}${path}`, {
      method,
      cache: "no-store",
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  } catch {
    return {
      ok: false,
      status: 503,
      error:
        "The local data server is not running. Start it from the dashboard: the paired-device list lives in the library's settings file, which it writes.",
    };
  }
  const parsed = (await res.json().catch(() => ({}))) as { error?: string; devices?: unknown; problems?: unknown };
  if (!res.ok) {
    return { ok: false, status: res.status, error: parsed.error ?? `local data server answered ${res.status}` };
  }
  return { ok: true, body: parsed };
}

/** The paired-device list, as the library's settings file holds it. */
export async function GET(): Promise<Response> {
  const result = await callList("GET", "/library/paired-devices");
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result.body);
}

/**
 * Pair a phone: list it, then publish its public key.
 *
 * Answers the cloud base URL the QR code carries, read from this machine's
 * config rather than from the browser, so the phone syncs with the deployment
 * this console administers.
 */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as PairBody;
  const { credentials, stackPrefix, region, deviceId, publicKeySpki } = body;
  const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : null;

  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return Response.json(
      { error: "deviceId must be 1-128 chars of [A-Za-z0-9_-]" },
      { status: 400 },
    );
  }
  // Rejected here as well as at the verifier, because a key that fails to parse
  // in the Lambda is a device that silently cannot sync, diagnosable only from
  // CloudWatch. Failing at pairing time puts the error in front of the person
  // who can fix it.
  if (!publicKeySpki || !SPKI_RE.test(publicKeySpki)) {
    return Response.json(
      { error: "publicKeySpki must be a base64 Ed25519 SPKI key (60 chars)" },
      { status: 400 },
    );
  }
  if (label !== null && label.length > MAX_LABEL_LENGTH) {
    return Response.json({ error: `label must be at most ${MAX_LABEL_LENGTH} characters` }, { status: 400 });
  }

  let config: StarkeepConfig;
  let awsCreds: AwsCredentials;
  try {
    config = readConfig();
    awsCreds = await managerCredentials(config, credentials, region);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/devices] pair failed", message);
    return Response.json({ error: message }, { status: 500 });
  }
  const baseUrl = config.publicBaseUrl ?? config.apiGatewayUrl;
  if (!baseUrl) {
    return Response.json(
      { error: "~/.starkeep/config.json has no cloud URL — deploy the cloud data server first" },
      { status: 400 },
    );
  }

  const pairedAt = new Date().toISOString();
  const listed = await callList("POST", "/library/paired-devices", {
    deviceId,
    label,
    appIds: PHONE_APP_IDS,
    pairedAt,
  });
  if (!listed.ok) return Response.json({ error: listed.error }, { status: listed.status });

  try {
    const name = await putDeviceKeyParameter({
      stackPrefix,
      deviceId,
      registration: {
        publicKeySpki,
        userId: body.userId ?? null,
        appIds: PHONE_APP_IDS,
        label,
        pairedAt,
      },
      region,
      awsCreds,
    });
    return Response.json({
      paired: { deviceId, parameterName: name },
      baseUrl,
      devices: listed.body.devices ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/devices] pair failed", message);
    // The entry is there and the key is not. Take the entry back so the list
    // does not show a phone that was never paired. If that fails too, the
    // entry is harmless and revoking it removes it.
    const rolledBack = await callList("DELETE", `/library/paired-devices/${encodeURIComponent(deviceId)}`);
    return Response.json(
      {
        error: rolledBack.ok
          ? message
          : `${message} (the list still shows ${deviceId}; revoke it to remove the entry)`,
      },
      { status: 500 },
    );
  }
}

/**
 * Revoke a phone: delete its key, then its list entry.
 *
 * A key that is already gone counts as deleted, so revoking an entry left
 * behind by a reinstall that kept data cleans up the list. A list update that
 * fails after the key is deleted still answers 200, because the device can no
 * longer sync; `listError` says the entry remains.
 */
export async function DELETE(req: Request): Promise<Response> {
  const body = (await req.json()) as PairBody;
  const { credentials, stackPrefix, region, deviceId } = body;

  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return Response.json({ error: "deviceId is required" }, { status: 400 });
  }

  try {
    // Revoke needs the same hop: `ssm:DeleteParameter` on `app-creds/*` is
    // Manager's too.
    await deleteDeviceKeyParameter({
      stackPrefix,
      deviceId,
      region,
      awsCreds: await managerCredentials(readConfig(), credentials, region),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/devices] revoke failed", message);
    return Response.json({ error: message }, { status: 500 });
  }

  const unlisted = await callList("DELETE", `/library/paired-devices/${encodeURIComponent(deviceId)}`);
  if (!unlisted.ok) {
    return Response.json({ revoked: deviceId, listError: unlisted.error });
  }
  return Response.json({ revoked: deviceId, devices: unlisted.body.devices ?? [] });
}
