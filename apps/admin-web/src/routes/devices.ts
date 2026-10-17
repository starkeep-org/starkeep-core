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
 * Every SSM call here runs as Manager; see `lib/manager-credentials.ts`.
 *
 * See `~/projects/starkeep/plan-mobile-qr-pairing-2026-10-13.md`.
 */

// The `/app-creds` subpath, not the package root. The root barrel pulls in the
// whole installer — Pulumi, the orchestrator, the local registry — and a route
// importing it fails to build on a module several layers away that has nothing
// to do with pairing.
import { devicePairingRefusal } from "./users";
import {
  putDeviceKeyParameter,
  deleteDeviceKeyParameter,
  deviceFingerprint,
  listDeviceRecords,
  parsePairingRequest,
} from "@starkeep/admin-installer/app-creds";
import type { AwsCredentials } from "@starkeep/admin-installer/app-creds";
import type { STSCredentials } from "../lib/cognito-auth";
import {
  managerCredentials as managerHop,
  readStarkeepConfig as readConfig,
  type StarkeepConfig,
} from "../lib/manager-credentials";

/**
 * The apps a paired phone may act as. Set here rather than taken from the
 * request, because it decides what the device's key opens. A phone syncs
 * through Starkeep Drive and nothing else.
 */
export const PHONE_APP_IDS: readonly string[] = ["starkeep-drive"];

/** Manager, for the pairing routes. Distinguishable from an install in CloudTrail. */
function managerCredentials(
  config: StarkeepConfig,
  operatorCreds: STSCredentials,
  region: string,
): Promise<AwsCredentials> {
  return managerHop(config, operatorCreds, region, "starkeep-pair-device");
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
  /** "phone" unless "desktop": "Connect this machine" registers a desktop. */
  kind?: string;
}

/**
 * The apps a device's record lists. A phone acts as Drive only. A desktop
 * syncs every app installed on it, so the broker lets it act as any app
 * installed in the cloud and its record lists none.
 */
function appIdsFor(kind: "phone" | "desktop"): readonly string[] {
  return kind === "phone" ? PHONE_APP_IDS : [];
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
  const kind = body.kind === "desktop" ? "desktop" : "phone";

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

  try {
    const refusal = await devicePairingRefusal({ credentials, region }, body.userId);
    if (refusal) return Response.json({ error: refusal }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/devices] pair failed", message);
    return Response.json({ error: message }, { status: 500 });
  }

  const pairedAt = new Date().toISOString();
  try {
    const name = await putDeviceKeyParameter({
      stackPrefix,
      deviceId,
      registration: {
        publicKeySpki,
        userId: body.userId ?? null,
        kind,
        appIds: appIdsFor(kind),
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

interface CodeBody {
  code?: string;
  credentials?: STSCredentials;
  stackPrefix?: string;
  region?: string;
  userId?: string | null;
}

/**
 * Read a pasted pairing code without approving it: what the device says it
 * is, and the fingerprint the admin confirms with the device's owner. Nothing
 * here touches the cloud.
 */
export async function INSPECT(req: Request): Promise<Response> {
  const { code } = (await req.json()) as CodeBody;
  const parsed = parsePairingRequest(code ?? "");
  if (!parsed.ok) return Response.json({ error: parsed.reason }, { status: 400 });
  return Response.json({
    request: parsed.request,
    fingerprint: deviceFingerprint(parsed.request.publicKeySpki),
  });
}

/**
 * Approve a device from its pairing code: publish its record, bound to the
 * user the admin chose. The device made its own key and sent only the public
 * half, so the private half never leaves it. The device learns of the
 * approval by polling `device/self`.
 */
export async function APPROVE(req: Request): Promise<Response> {
  const body = (await req.json()) as CodeBody;
  const parsed = parsePairingRequest(body.code ?? "");
  if (!parsed.ok) return Response.json({ error: parsed.reason }, { status: 400 });
  const { credentials, stackPrefix, region } = body;
  if (!credentials || !stackPrefix || !region) {
    return Response.json({ error: "Sign in to approve a device." }, { status: 401 });
  }
  const { deviceId, publicKeySpki, label, kind } = parsed.request;
  try {
    // The device syncs for the account the admin chose, which must have a
    // data library.
    const refusal = await devicePairingRefusal({ credentials, region }, body.userId);
    if (refusal) return Response.json({ error: refusal }, { status: 400 });
    const config = readConfig();
    const awsCreds = await managerCredentials(config, credentials, region);
    await putDeviceKeyParameter({
      stackPrefix,
      deviceId,
      registration: {
        publicKeySpki,
        userId: body.userId ?? null,
        kind,
        appIds: appIdsFor(kind),
        label,
        pairedAt: new Date().toISOString(),
      },
      region,
      awsCreds,
    });
    return Response.json({ approved: { deviceId, label, kind } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/devices] approve failed", message);
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
