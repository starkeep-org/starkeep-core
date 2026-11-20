/**
 * Identity Pool federation: an admin's Cognito ID token becomes temporary AWS
 * credentials for the admin-app role.
 *
 * The admin signs in on the managed login page (`admin-session.ts`), or the
 * tier-3 runner signs in with the admin password flow. Both then exchange the
 * ID token here, which is the leg every install script walks before it can
 * assume the Manager role.
 */

import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from "@aws-sdk/client-cognito-identity";

export interface CognitoUserPoolRef {
  userPoolId: string;
  userPoolClientId: string;
}

export interface CognitoIdentityPoolRef extends CognitoUserPoolRef {
  identityPoolId: string;
}

/**
 * Region is not stored in config.json — AWS encodes it into the user pool ID
 * (e.g. `us-east-2_Xxxxx`), so it is derived from there everywhere.
 */
export function regionFromUserPoolId(userPoolId: string): string {
  const parts = userPoolId.split("_");
  if (parts.length < 2 || !parts[0]) {
    throw new Error(
      `userPoolId "${userPoolId}" is not in the expected format <region>_<id>. ` +
        `Region is derived from userPoolId, so this prevents the installer from running.`,
    );
  }
  return parts[0];
}

export interface IdentityPoolCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** Exchange a user-pool ID token for temporary AWS credentials (admin-app role). */
export async function getIdentityPoolCredentials(
  pool: CognitoIdentityPoolRef,
  idToken: string,
): Promise<IdentityPoolCredentials> {
  const region = regionFromUserPoolId(pool.userPoolId);
  const client = new CognitoIdentityClient({ region });
  const loginKey = `cognito-idp.${region}.amazonaws.com/${pool.userPoolId}`;
  const logins = { [loginKey]: idToken };

  const idResponse = await client.send(
    new GetIdCommand({ IdentityPoolId: pool.identityPoolId, Logins: logins }),
  );
  if (!idResponse.IdentityId) throw new Error("Failed to get Cognito Identity ID");

  const credsResponse = await client.send(
    new GetCredentialsForIdentityCommand({ IdentityId: idResponse.IdentityId, Logins: logins }),
  );

  const c = credsResponse.Credentials;
  if (!c?.AccessKeyId || !c.SecretKey || !c.SessionToken) {
    throw new Error("Incomplete credentials from Identity Pool");
  }

  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretKey,
    sessionToken: c.SessionToken,
  };
}
