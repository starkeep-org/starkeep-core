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
  PutParameterCommand,
  DeleteParameterCommand,
} from "@aws-sdk/client-ssm";
import type { AwsCredentials } from "./session";

export function appCredsParameterName(stackPrefix: string, appId: string): string {
  return `/${stackPrefix}/app-creds/${appId}`;
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
 * Mirror the given hmac secret to SSM SecureString. Idempotent — re-puts the
 * same value on every call (Overwrite: true) so retried install steps converge.
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
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Type: "SecureString",
      Value: value,
      Overwrite: true,
      Description: `Per-app HMAC credential for ${opts.appId}. Created by admin-installer.`,
      Tags: [
        { Key: "starkeep:appId", Value: opts.appId },
        { Key: "starkeep:managed", Value: "true" },
      ],
    }),
  );
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
