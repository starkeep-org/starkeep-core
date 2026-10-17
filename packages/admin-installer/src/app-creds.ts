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
  GetParametersByPathCommand,
} from "@aws-sdk/client-ssm";
import {
  checkDeploymentSettings,
  serializeDeploymentSettings,
  withDeploymentSettingsChange,
  type DeploymentSettings,
} from "@starkeep/protocol-primitives";

// Re-exported for admin-web's server routes, which reach the installer only
// through this subpath: approving a device reads its pairing code and shows the
// fingerprint the admin confirms.
export {
  deviceFingerprint,
  parsePairingRequest,
  type PairingRequest,
} from "@starkeep/protocol-primitives";
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
 * The SSM prefix for the platform's own non-secret parameters: paired devices
 * and the deployment's settings.
 *
 * A prefix of its own, rather than reserved names under `app-creds/*`, so that
 * Manager can read and list device records without any read on the app
 * secrets. Manager writes app secrets but never reads them, and admin-web's
 * device list needs a read. One prefix keeps the cloud data server's runtime
 * grant and the foundational boundary to a single resource each.
 */
export function platformParameterPrefix(stackPrefix: string): string {
  return `/${stackPrefix}/platform`;
}

/**
 * Name of a paired device's record. The value is a {@link DeviceRegistration}
 * and is **not secret**: it is the public half of the device's key. Stored as
 * a plain `String`.
 */
export function deviceKeyParameterName(stackPrefix: string, deviceId: string): string {
  return `${platformParameterPrefix(stackPrefix)}/devices/${deviceId}`;
}

/** Name of the deployment's settings document. See `settings/deployment-settings.ts`. */
export function deploymentSettingsParameterName(stackPrefix: string): string {
  return `${platformParameterPrefix(stackPrefix)}/deployment-settings`;
}

/**
 * The deployment's settings document as SSM holds it, parsed but not checked,
 * or null when none is set.
 */
export async function getDeploymentSettingsParameter(opts: {
  stackPrefix: string;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<unknown> {
  const ssm = makeSsmClient(opts.region, opts.awsCreds);
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: deploymentSettingsParameterName(opts.stackPrefix) }),
    );
    const raw = result.Parameter?.Value;
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}

/**
 * Write the deployment's settings document. The caller checks it first.
 *
 * `onlyIfAbsent` writes nothing over an existing document, and answers whether
 * it wrote: cloud setup seeds the parameter from a machine's local values once,
 * and a second machine's setup must not overwrite what the operator chose since.
 */
export async function putDeploymentSettingsParameter(opts: {
  stackPrefix: string;
  document: string;
  region: string;
  awsCreds: AwsCredentials;
  onlyIfAbsent?: boolean;
}): Promise<boolean> {
  const ssm = makeSsmClient(opts.region, opts.awsCreds);
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: deploymentSettingsParameterName(opts.stackPrefix),
        Type: "String",
        Value: opts.document,
        Overwrite: !opts.onlyIfAbsent,
        Description: "Starkeep deployment settings. Written by admin-web through Manager.",
      }),
    );
    return true;
  } catch (err) {
    if (opts.onlyIfAbsent && err instanceof ParameterAlreadyExists) return false;
    throw err;
  }
}

export type DeploymentSettingsChange =
  | { readonly ok: true; readonly settings: DeploymentSettings }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Apply one change to the deployment's settings in SSM: read the document,
 * merge the change so a field it leaves out keeps its value, check the result,
 * and write it. A stored document that does not check out is replaced by the
 * change alone, because no field of it can be trusted.
 */
export async function changeDeploymentSettingsParameter(opts: {
  stackPrefix: string;
  change: unknown;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<DeploymentSettingsChange> {
  const requested = checkDeploymentSettings(opts.change);
  if (!requested.ok) return { ok: false, problems: requested.problems };
  const stored = await getDeploymentSettingsParameter(opts);
  const current = stored === null ? null : checkDeploymentSettings(stored);
  const base = current?.ok ? current.settings : {};
  const next = withDeploymentSettingsChange(base, requested.settings);
  const checked = checkDeploymentSettings(next);
  if (!checked.ok) return { ok: false, problems: checked.problems };
  await putDeploymentSettingsParameter({ ...opts, document: serializeDeploymentSettings(next) });
  return { ok: true, settings: next };
}

/** What kind of machine a device is. The broker scopes each kind differently. */
export type DeviceKind = "phone" | "desktop";

/** What a paired device is, as admin-web records it. */
export interface DeviceRegistration {
  /** Base64 SPKI Ed25519 public key, as the device published it. */
  readonly publicKeySpki: string;
  /** The Cognito user (`sub`) this device was paired for. */
  readonly userId: string | null;
  readonly kind: DeviceKind;
  /**
   * The apps the device may act as. The broker refuses any other app id, and
   * refuses a record without this field, so a device key is a key to the
   * apps it was paired for and no others.
   */
  readonly appIds: readonly string[];
  /** Human-readable, so the operator can tell two devices apart when revoking. */
  readonly label: string | null;
  readonly pairedAt: string;
}

/** One device record as admin-web lists it. */
export interface DeviceRecord extends DeviceRegistration {
  readonly deviceId: string;
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
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Type: "String",
      Value: JSON.stringify(opts.registration),
      Overwrite: true,
      Description: `Starkeep paired device ${opts.deviceId}. Public key only.`,
    }),
  );
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

/**
 * Every paired device. The records are the authority, so the list cannot
 * disagree with what the broker accepts. A record that does not parse is
 * listed with its id and nothing else it claims, so the operator can still
 * revoke it.
 */
export async function listDeviceRecords(opts: {
  stackPrefix: string;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<DeviceRecord[]> {
  const ssm = makeSsmClient(opts.region, opts.awsCreds);
  const path = `${platformParameterPrefix(opts.stackPrefix)}/devices`;
  const records: DeviceRecord[] = [];
  let nextToken: string | undefined;
  do {
    const page = await ssm.send(
      new GetParametersByPathCommand({ Path: path, Recursive: false, NextToken: nextToken }),
    );
    for (const p of page.Parameters ?? []) {
      const deviceId = p.Name?.slice(path.length + 1);
      if (!deviceId) continue;
      records.push({ deviceId, ...parseDeviceRegistration(p.Value) });
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return records.sort((a, b) => a.pairedAt.localeCompare(b.pairedAt));
}

/** A stored registration, read defensively. A field that does not parse reads as empty. */
export function parseDeviceRegistration(raw: string | undefined): DeviceRegistration {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      v = parsed as Record<string, unknown>;
    }
  } catch {
    // An unreadable record lists as empty, and revoking it still works.
  }
  return {
    publicKeySpki: typeof v.publicKeySpki === "string" ? v.publicKeySpki : "",
    userId: typeof v.userId === "string" ? v.userId : null,
    kind: v.kind === "desktop" ? "desktop" : "phone",
    appIds: Array.isArray(v.appIds) ? v.appIds.filter((a): a is string => typeof a === "string") : [],
    label: typeof v.label === "string" ? v.label : null,
    pairedAt: typeof v.pairedAt === "string" ? v.pairedAt : "",
  };
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
