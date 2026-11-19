/**
 * The credential vault: one user's secrets for one app's third-party
 * services, such as a provider's refresh token or an API key, kept where only
 * the data server reads them.
 *
 * Each secret is a Parameter Store SecureString under the account's `aws/ssm`
 * key, at `/<prefix>/app-creds/_vault/<appId>/<userId>/<name>`:
 *
 * - **Not under `platform/`.** Manager may read and decrypt `platform/*`, and
 *   every Starkeep admin can act as Manager, so a secret there would be every
 *   admin's to read. Under `app-creds/`, Manager may write and delete but never
 *   read.
 * - **Not an app's own name.** An app's execution role reads exactly its own
 *   `app-creds/<appId>` parameter and nothing below it, and no app id starts
 *   with `_`, so no app reaches `_vault`.
 *
 * Who reaches a secret is decided in `vault-routes.ts`: the user's own
 * browser, through the app's server, may list, write and delete, but never
 * read one back. Only a run of one of the app's scheduled jobs, for that
 * user, reads a value.
 *
 * Nothing here labels a parameter version. Parameter Store keeps 100 versions
 * of a parameter and deletes the oldest on each write, unless the oldest
 * carries a label, in which case the write fails. A secret that rotates on
 * every use, such as a refresh token, passes 100 versions within weeks, so a
 * single label would stop its rotation for good.
 */
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";

/** A secret's name: lowercase letters, digits, `_` and `-`, at most 64 characters. */
export const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The standard tier's limit on a parameter's value, in bytes. */
export const MAX_SECRET_BYTES = 4096;

/** The path that holds one user's secrets for one app, with no trailing slash. */
export function vaultPath(stackPrefix: string, appId: string, userId: string): string {
  return `/${stackPrefix}/app-creds/_vault/${appId}/${userId}`;
}

/** One secret's parameter name. Throws on a malformed secret name. */
export function vaultParameterName(
  stackPrefix: string,
  appId: string,
  userId: string,
  name: string,
): string {
  if (!SECRET_NAME_PATTERN.test(name)) throw new Error(`Malformed secret name: ${name}`);
  return `${vaultPath(stackPrefix, appId, userId)}/${name}`;
}

/** Why a value cannot be stored, or null when it can. */
export function secretValueRefusal(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "A secret is a non-empty string.";
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    return `A secret holds at most ${MAX_SECRET_BYTES} bytes.`;
  }
  return null;
}

export interface VaultTarget {
  ssm: SSMClient;
  stackPrefix: string;
  appId: string;
  userId: string;
}

/** One secret as a listing shows it: its name and when it last changed, never its value. */
export interface SecretEntry {
  name: string;
  /** Milliseconds since the epoch. */
  updatedAt: number | null;
}

/** Store or replace one secret. */
export async function putSecret(t: VaultTarget, name: string, value: string): Promise<void> {
  await t.ssm.send(
    new PutParameterCommand({
      Name: vaultParameterName(t.stackPrefix, t.appId, t.userId, name),
      Value: value,
      Type: "SecureString",
      Tier: "Standard",
      Overwrite: true,
    }),
  );
}

/** One secret's value, decrypted, or null when it is absent. Nothing is cached. */
export async function getSecret(t: VaultTarget, name: string): Promise<string | null> {
  try {
    const result = await t.ssm.send(
      new GetParameterCommand({
        Name: vaultParameterName(t.stackPrefix, t.appId, t.userId, name),
        WithDecryption: true,
      }),
    );
    return result.Parameter?.Value ?? null;
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}

/**
 * The user's secrets for the app: names and times only. Read without
 * decryption, so the call returns no plaintext, and the values it does
 * return are dropped here.
 */
export async function listSecrets(t: VaultTarget): Promise<SecretEntry[]> {
  const prefix = `${vaultPath(t.stackPrefix, t.appId, t.userId)}/`;
  const entries: SecretEntry[] = [];
  let nextToken: string | undefined;
  do {
    const page = await t.ssm.send(
      new GetParametersByPathCommand({
        Path: vaultPath(t.stackPrefix, t.appId, t.userId),
        Recursive: false,
        WithDecryption: false,
        MaxResults: 10,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    for (const p of page.Parameters ?? []) {
      if (!p.Name?.startsWith(prefix)) continue;
      entries.push({
        name: p.Name.slice(prefix.length),
        updatedAt: p.LastModifiedDate ? p.LastModifiedDate.getTime() : null,
      });
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Delete one secret. A secret already gone counts as deleted. */
export async function deleteSecret(t: VaultTarget, name: string): Promise<void> {
  try {
    await t.ssm.send(
      new DeleteParameterCommand({
        Name: vaultParameterName(t.stackPrefix, t.appId, t.userId, name),
      }),
    );
  } catch (err) {
    if (!(err instanceof ParameterNotFound)) throw err;
  }
}
