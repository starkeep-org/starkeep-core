/**
 * Pairing and revoking devices.
 *
 * ## Why the operator does this rather than the device
 *
 * Registration is the one step that cannot be authenticated by the thing being
 * registered. The alternative was for a handset to enrol itself with its
 * Cognito token, which would have meant teaching the data plane to verify user
 * JWTs — and the data plane identifies *apps*, not end users, by deliberate
 * design (see the route comments in `cloud-data-server-program.ts`). Reversing
 * that is a real decision and it belongs to the multi-user work (todo #52), not
 * to getting a phone syncing.
 *
 * So pairing happens here, in the privileged console, using credentials the
 * operator already holds. It is also the stronger bar: pairing requires the
 * admin console rather than a password.
 *
 * ## What is stored
 *
 * The device's **public** key, under `/${stackPrefix}/app-creds/_device-<id>`.
 * Nothing secret leaves the handset. Revoking is deleting that one parameter,
 * and it disturbs no other client of any app — which is the whole reason a
 * device gets its own asymmetric key rather than a copy of an app's shared
 * HMAC secret.
 *
 * `userId` is recorded even though nothing reads it yet. See the note on
 * `DeviceRegistration` — it is what saves already-paired devices a migration
 * when shared data is finally partitioned per user.
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
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { NextRequest, NextResponse } from "next/server";
// The `/app-creds` subpath, not the package root. The root barrel pulls in the
// whole installer — Pulumi, the orchestrator, the local registry — and a Next
// route importing it fails to build on a module several layers away that has
// nothing to do with pairing. Same shape of failure as a UI component reaching
// through a barrel for a type and dragging `sharp` into the browser bundle.
import {
  putDeviceKeyParameter,
  deleteDeviceKeyParameter,
} from "@starkeep/admin-installer/app-creds";
import type { AwsCredentials } from "@starkeep/admin-installer/app-creds";
// Likewise a subpath: `session` imports nothing but the STS client, so it can
// be pulled into a Next route without dragging the installer along behind it.
import { roleChain } from "@starkeep/admin-installer/session";
import type { STSCredentials } from "../../../src/lib/cognito-auth";

const CONFIG_PATH = join(starkeepDir(), "config.json");

interface StarkeepConfig {
  stackPrefix?: string;
  accountId?: string;
  managerRoleArn?: string;
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
 * the request body: admin-web runs on the operator's own machine, but a role
 * ARN is the one input here that decides *which* identity does a privileged
 * write, and it is already on disk — there is no reason for it to make a round
 * trip through the browser. Same fallback as the uninstall CLI for configs
 * written before `managerRoleArn` was recorded.
 */
async function managerCredentials(
  operatorCreds: STSCredentials,
  region: string,
): Promise<AwsCredentials> {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error("~/.starkeep/config.json not found — complete the cloud setup first");
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;
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

/** Must match the handler's `isValidDeviceId` — this name becomes a path. */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 32-byte Ed25519 key in a 44-byte SPKI wrapper, base64 — always 60 chars. */
const SPKI_RE = /^[A-Za-z0-9+/]{59}=$/;

interface PairBody {
  credentials: STSCredentials;
  stackPrefix: string;
  region: string;
  deviceId: string;
  publicKeySpki: string;
  userId?: string | null;
  label?: string | null;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as PairBody;
  const { credentials, stackPrefix, region, deviceId, publicKeySpki } = body;

  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return NextResponse.json(
      { error: "deviceId must be 1-128 chars of [A-Za-z0-9_-]" },
      { status: 400 },
    );
  }
  // Rejected here as well as at the verifier, because a key that fails to parse
  // in the Lambda is a device that silently cannot sync, diagnosable only from
  // CloudWatch. Failing at pairing time puts the error in front of the person
  // who can fix it.
  if (!publicKeySpki || !SPKI_RE.test(publicKeySpki)) {
    return NextResponse.json(
      { error: "publicKeySpki must be a base64 Ed25519 SPKI key (60 chars)" },
      { status: 400 },
    );
  }

  try {
    const name = await putDeviceKeyParameter({
      stackPrefix,
      deviceId,
      registration: {
        publicKeySpki,
        userId: body.userId ?? null,
        label: body.label ?? null,
        pairedAt: new Date().toISOString(),
      },
      region,
      awsCreds: await managerCredentials(credentials, region),
    });
    return NextResponse.json({ paired: { deviceId, parameterName: name } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/devices] pair failed", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const body = (await req.json()) as PairBody;
  const { credentials, stackPrefix, region, deviceId } = body;

  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return NextResponse.json({ error: "deviceId is required" }, { status: 400 });
  }

  try {
    // Revoke needs the same hop: `ssm:DeleteParameter` on `app-creds/*` is
    // Manager's too, so this path was denied for the same reason pairing was.
    await deleteDeviceKeyParameter({
      stackPrefix,
      deviceId,
      region,
      awsCreds: await managerCredentials(credentials, region),
    });
    return NextResponse.json({ revoked: deviceId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/devices] revoke failed", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
