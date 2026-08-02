/**
 * Per-app HMAC credential provisioning in SSM Parameter Store.
 *
 * Path: `/${stackPrefix}/app-creds/${appId}` (SecureString).
 * Value (JSON): `{ appId, hmacSecret }`.
 *
 * The same secret is mirrored to the local registry (`shared_app_registry.
 * hmac_secret`) by `installLocal`, and to the local creds file by admin-web's
 * install route. Cloud-install reads the local registry's existing secret and
 * mirrors it to SSM so the local sync supervisor (which signs with the local
 * secret) and the cloud verifier (which reads SSM) agree on the same key.
 *
 * Bootstrap teardown (`scripts/teardown-bootstrap.sh`) walks
 * `/${stackPrefix}/app-creds/*` and deletes any parameters left over from
 * apps that did not run uninstall.
 */

import {
  SSMClient,
  GetParameterCommand,
  ParameterNotFound,
  ParameterAlreadyExists,
  PutParameterCommand,
  DeleteParameterCommand,
} from "@aws-sdk/client-ssm";
import type { AwsCredentials } from "./session";

/** Re-exported so a consumer of this subpath needs only this one import. */
export type { AwsCredentials };

export function appCredsParameterName(stackPrefix: string, appId: string): string {
  return `/${stackPrefix}/app-creds/${appId}`;
}

/**
 * Name of the CloudFront URL-signing SecureString. The leading underscore keeps
 * it out of the real-appId keyspace (real appIds start alphanumeric), so it can
 * never collide with a per-app HMAC secret at `app-creds/<appId>`, while still
 * sitting under `app-creds/*` so it rides the CDS Lambda's existing read grant
 * and the teardown script's `app-creds/*` sweep. MUST match the constant of the
 * same shape in cloud-data-server-program.ts (the Lambda reads this name).
 */
export function cloudFrontSigningParameterName(stackPrefix: string): string {
  return `/${stackPrefix}/app-creds/_cloudfront-signing`;
}

/**
 * Name of a paired device's public-key parameter.
 *
 * Same reservation trick as {@link cloudFrontSigningParameterName}, for the
 * same three reasons: real app ids start alphanumeric so `_device-` can never
 * collide with one; it rides the CDS Lambda's existing `app-creds/*` read grant
 * rather than needing a new IAM path and a bootstrap change; and teardown's
 * `app-creds/*` sweep removes paired devices along with everything else.
 *
 * The value is `{ publicKeySpki, userId, pairedAt, label }` and is **not
 * secret** — it is the public half. It is still stored as a SecureString,
 * because one convention under this prefix is cheaper to reason about than two.
 */
export function deviceKeyParameterName(stackPrefix: string, deviceId: string): string {
  return `/${stackPrefix}/app-creds/_device-${deviceId}`;
}

/** What a paired device is, as admin-web records it. */
export interface DeviceRegistration {
  /** Base64 SPKI Ed25519 public key, as the device published it. */
  readonly publicKeySpki: string;
  /**
   * The Cognito user this device was paired for.
   *
   * Recorded from the first pairing even though **nothing reads it yet**: the
   * data plane is app-identified, not user-identified, and making it otherwise
   * is a partitioning project rather than an auth change (todo #52). Capturing
   * it now is what saves every already-paired device a migration later, and it
   * costs one field.
   */
  readonly userId: string | null;
  /** Human-readable, so the operator can tell two phones apart when revoking. */
  readonly label: string | null;
  readonly pairedAt: string;
}

/**
 * Pair a device: publish its public key so the cloud will accept its signatures.
 *
 * Idempotent on device id, so re-pairing a reinstalled app converges rather
 * than erroring. Revocation is {@link deleteDeviceKeyParameter} — one delete,
 * and no other client of any app is disturbed, which is the entire reason a
 * device gets its own asymmetric key instead of the app's shared secret.
 */
export async function putDeviceKeyParameter(opts: {
  stackPrefix: string;
  deviceId: string;
  registration: DeviceRegistration;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<string> {
  const ssm = makeSsmClient(opts.region, opts.awsCreds);
  const name = deviceKeyParameterName(opts.stackPrefix, opts.deviceId);
  // Shape MUST match CachedDeviceKey's parse in the cloud-data-server handler.
  const value = JSON.stringify(opts.registration);
  const description = `Starkeep paired device ${opts.deviceId}. Public key only.`;
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Type: "SecureString",
        Value: value,
        Description: description,
        Tags: [
          { Key: "starkeep:appId", Value: "cloud-data-server" },
          { Key: "starkeep:managed", Value: "true" },
        ],
      }),
    );
  } catch (err) {
    if (!(err instanceof ParameterAlreadyExists)) throw err;
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Type: "SecureString",
        Value: value,
        Overwrite: true,
        Description: description,
      }),
    );
  }
  return name;
}

/** Revoke a device. The cloud stops accepting its signatures within the cache TTL. */
export async function deleteDeviceKeyParameter(opts: {
  stackPrefix: string;
  deviceId: string;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<void> {
  const ssm = makeSsmClient(opts.region, opts.awsCreds);
  try {
    await ssm.send(
      new DeleteParameterCommand({
        Name: deviceKeyParameterName(opts.stackPrefix, opts.deviceId),
      }),
    );
  } catch (err) {
    // Already gone is the desired end state, not an error.
    if (!(err instanceof ParameterNotFound)) throw err;
  }
}

function makeSsmClient(region: string, creds: AwsCredentials): SSMClient {
  return new SSMClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

/**
 * Mirror the given hmac secret to SSM SecureString. Idempotent — retried
 * install steps converge on the same value.
 *
 * SSM forbids Tags together with Overwrite in one PutParameter, and the manager
 * role intentionally lacks GetParameter on app-creds (it never reads the
 * secret), so we cannot check existence first. Instead: create with Tags and no
 * Overwrite — the create path fires the implicit ssm:AddTagsToResource authz
 * check the manager role is granted (see manager-policy ManagerManageAppCreds);
 * if the parameter already exists, re-put the value with Overwrite and no Tags
 * (PutParameter only, no tagging check). Tags are applied once at creation.
 *
 * Returns the SSM parameter name (so callers can wire it into Lambda env).
 */
export async function putAppCredsParameter(opts: {
  stackPrefix: string;
  appId: string;
  hmacSecret: string;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<string> {
  const ssm = makeSsmClient(opts.region, opts.awsCreds);
  const name = appCredsParameterName(opts.stackPrefix, opts.appId);
  const value = JSON.stringify({ appId: opts.appId, hmacSecret: opts.hmacSecret });
  const description = `Per-app HMAC credential for ${opts.appId}. Created by admin-installer.`;
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Type: "SecureString",
        Value: value,
        Description: description,
        Tags: [
          { Key: "starkeep:appId", Value: opts.appId },
          { Key: "starkeep:managed", Value: "true" },
        ],
      }),
    );
  } catch (err) {
    if (!(err instanceof ParameterAlreadyExists)) throw err;
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Type: "SecureString",
        Value: value,
        Overwrite: true,
        Description: description,
      }),
    );
  }
  return name;
}

/**
 * Write the CloudFront URL-signing config (Part B) to its SecureString, under
 * Manager creds. Same create-then-overwrite idempotency as putAppCredsParameter
 * (Manager has no GetParameter on app-creds, so we can't check existence first):
 * create with Tags and no Overwrite; on ParameterAlreadyExists, re-put the value
 * with Overwrite and no Tags. The signing material is generated by the CDS
 * Pulumi stack and exported as stack outputs — this keeps the write off the
 * CDS role (which is read-only on SSM) and on Manager, which already holds
 * PutParameter + KMS-encrypt on `app-creds/*` (see manager-policy
 * ManagerManageAppCreds), so no IAM change is needed.
 */
export async function putCloudFrontSigningParameter(opts: {
  stackPrefix: string;
  keyPairId: string;
  domain: string;
  privateKey: string;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<string> {
  const ssm = makeSsmClient(opts.region, opts.awsCreds);
  const name = cloudFrontSigningParameterName(opts.stackPrefix);
  // Shape MUST match CloudFrontSigningConfig in the cloud-data-server handler.
  const value = JSON.stringify({
    keyPairId: opts.keyPairId,
    domain: opts.domain,
    privateKey: opts.privateKey,
  });
  const description =
    "CloudFront shared-file URL-signing config (keyPairId/domain/privateKey). " +
    "Created by admin-installer.";
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Type: "SecureString",
        Value: value,
        Description: description,
        Tags: [
          { Key: "starkeep:appId", Value: "cloud-data-server" },
          { Key: "starkeep:managed", Value: "true" },
        ],
      }),
    );
  } catch (err) {
    if (!(err instanceof ParameterAlreadyExists)) throw err;
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Type: "SecureString",
        Value: value,
        Overwrite: true,
        Description: description,
      }),
    );
  }
  return name;
}

/** Fetch and parse the JSON-encoded SecureString. Returns null if absent. */
export async function getAppCredsParameter(opts: {
  stackPrefix: string;
  appId: string;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<{ appId: string; hmacSecret: string } | null> {
  const ssm = makeSsmClient(opts.region, opts.awsCreds);
  const name = appCredsParameterName(opts.stackPrefix, opts.appId);
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    const raw = result.Parameter?.Value;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { appId?: string; hmacSecret?: string };
    if (!parsed.appId || !parsed.hmacSecret) return null;
    return { appId: parsed.appId, hmacSecret: parsed.hmacSecret };
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}

/** Idempotent delete — swallows ParameterNotFound. */
export async function deleteAppCredsParameter(opts: {
  stackPrefix: string;
  appId: string;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<void> {
  const ssm = makeSsmClient(opts.region, opts.awsCreds);
  const name = appCredsParameterName(opts.stackPrefix, opts.appId);
  try {
    await ssm.send(new DeleteParameterCommand({ Name: name }));
  } catch (err) {
    if (err instanceof ParameterNotFound) return;
    throw err;
  }
}
