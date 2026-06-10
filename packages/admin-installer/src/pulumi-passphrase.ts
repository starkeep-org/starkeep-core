import { randomBytes } from "node:crypto";
import {
  SSMClient,
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";

/**
 * Ensure /${stackPrefix}/pulumi/passphrase exists as an SSM SecureString,
 * creating it with a fresh random value on first cloud-data-server install.
 *
 * The bootstrap CloudFormation cannot create this parameter itself —
 * AWS::SSM::Parameter does not support Type: SecureString. So creation is
 * deferred to the installer, which runs with admin-app permissions.
 *
 * Create-if-missing is load-bearing: Pulumi encrypts state-bucket secrets
 * with a key derived from this passphrase, so overwriting it after any
 * pulumi up has run would break every subsequent up/destroy against
 * pre-existing stacks. We never call PutParameter with Overwrite.
 *
 * Returns:
 *   "created" — parameter did not exist; created with a fresh value.
 *   "already-exists" — parameter already present; left untouched.
 */
export async function ensurePulumiPassphrase(opts: {
  stackPrefix: string;
  region: string;
}): Promise<"created" | "already-exists"> {
  const ssm = new SSMClient({ region: opts.region });
  const name = `/${opts.stackPrefix}/pulumi/passphrase`;

  try {
    await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return "already-exists";
  } catch (err) {
    if (!(err instanceof ParameterNotFound)) throw err;
  }

  const fresh = randomBytes(32).toString("base64url");
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Type: "SecureString",
      Value: fresh,
      Description:
        "Pulumi stack-state encryption passphrase. Created by admin-installer on first cloud-data-server install; must remain stable thereafter.",
      Tags: [{ Key: "starkeep:managed", Value: "true" }],
    }),
  );
  return "created";
}
