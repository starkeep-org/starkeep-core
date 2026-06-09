import { randomBytes } from "node:crypto";
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";

const PLACEHOLDER = "REPLACE_WITH_RANDOM_32_BYTE_VALUE";

/**
 * Replace the bootstrap-time placeholder in /${stackPrefix}/pulumi/passphrase
 * with a per-deployment random SecureString on first cloud-data-server install.
 *
 * Detect-then-skip is load-bearing: Pulumi encrypts state-bucket secrets with
 * a key derived from this passphrase, so rotating it after any pulumi up has
 * run would break every subsequent up/destroy against pre-existing stacks.
 *
 * Returns:
 *   "rotated" — placeholder was found and overwritten with a fresh value.
 *   "already-rotated" — value is not the placeholder; left alone.
 */
export async function rotatePulumiPassphraseIfPlaceholder(opts: {
  stackPrefix: string;
  region: string;
}): Promise<"rotated" | "already-rotated"> {
  const ssm = new SSMClient({ region: opts.region });
  const name = `/${opts.stackPrefix}/pulumi/passphrase`;

  const current = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  const value = current.Parameter?.Value;
  if (!value) {
    throw new Error(`Pulumi passphrase parameter ${name} not found in SSM`);
  }
  if (value !== PLACEHOLDER) {
    return "already-rotated";
  }

  const fresh = randomBytes(32).toString("base64url");
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Type: "SecureString",
      Value: fresh,
      Overwrite: true,
    }),
  );
  return "rotated";
}
