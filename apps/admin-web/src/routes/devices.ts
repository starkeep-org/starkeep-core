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
 * One SSM parameter per device, `/${stackPrefix}/platform/devices/<id>`,
 * holding the public key, the Cognito user, the kind, the apps it may act as,
 * the label and the pairing time. The record is the authority: the broker
 * accepts the device's signatures while the parameter exists, and revoking
 * deletes it. The list admin-web shows is the same records, so the list cannot
 * miss a device that can sync.
 *
 * ## Why the operator's own session does not make the SSM call
 *
 * The credentials that arrive in the request body are the admin-app role, and
 * that role deliberately holds no SSM grant beyond the Pulumi passphrase.
 * Writing credentials, device records included, is Manager's job (see
 * `data-roles-and-permissions.md`), which keeps the federated human from being
 * a superuser over the credential prefixes. So this route does the same
 * admin-app → Manager hop the installer does before minting a per-app HMAC
 * secret or the CloudFront signing key.
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
  listDeviceRecords,
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

/** The longest label a device may carry. */
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

interface ListBody {
  credentials: STSCredentials;
  stackPrefix: string;
  region: string;
}

/** The paired devices, read from their records through Manager. */
export async function LIST(req: Request): Promise<Response> {
  const { credentials, stackPrefix, region } = (await req.json()) as ListBody;
  try {
    const awsCreds = await managerCredentials(readConfig(), credentials, region);
    const records = await listDeviceRecords({ stackPrefix, region, awsCreds });
    return Response.json({
      // The public key stays out of the list: nothing on this page needs it.
      devices: records.map(({ publicKeySpki: _key, ...rest }) => rest),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/devices] list failed", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * Pair a phone: publish its record.
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
  try {
    const name = await putDeviceKeyParameter({
      stackPrefix,
      deviceId,
      registration: {
        publicKeySpki,
        userId: body.userId ?? null,
        kind: "phone",
        appIds: PHONE_APP_IDS,
        label,
        pairedAt,
      },
      region,
      awsCreds,
    });
    return Response.json({ paired: { deviceId, parameterName: name }, baseUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/devices] pair failed", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * Revoke a device: delete its record. A record that is already gone counts as
 * deleted.
 */
export async function DELETE(req: Request): Promise<Response> {
  const body = (await req.json()) as PairBody;
  const { credentials, stackPrefix, region, deviceId } = body;

  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return Response.json({ error: "deviceId is required" }, { status: 400 });
  }

  try {
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
  return Response.json({ revoked: deviceId });
}
