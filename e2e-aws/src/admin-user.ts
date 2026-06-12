/**
 * Ensure the test admin user exists in the bootstrap user pool.
 *
 * Production setup has the operator create this account in the Cognito
 * console (the stack's ConsoleLink output); the runner does the API
 * equivalent: AdminCreateUser with the invite email suppressed, then
 * AdminSetUserPassword(Permanent) so sign-in never hits the
 * NEW_PASSWORD_REQUIRED challenge. The password is generated per stack and
 * kept in the run-state dir.
 */

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { regionFromUserPoolId } from "@starkeep/admin-installer";
import {
  generatePassword,
  readAdminCredentials,
  writeAdminCredentials,
  type AdminCredentials,
  type RunPaths,
} from "./run-state.js";

const TEST_ADMIN_EMAIL = "tier3-admin@starkeep.test";

export async function ensureAdminUser(
  paths: RunPaths,
  userPoolId: string,
): Promise<AdminCredentials> {
  const region = regionFromUserPoolId(userPoolId);
  const client = new CognitoIdentityProviderClient({ region });

  const saved = readAdminCredentials(paths);
  const exists = await userExists(client, userPoolId, TEST_ADMIN_EMAIL);

  if (exists && saved?.email === TEST_ADMIN_EMAIL) return saved;

  if (!exists) {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: TEST_ADMIN_EMAIL,
        UserAttributes: [
          { Name: "email", Value: TEST_ADMIN_EMAIL },
          { Name: "email_verified", Value: "true" },
        ],
        MessageAction: "SUPPRESS",
      }),
    );
  }

  // User exists but the saved password is missing or stale (e.g. the .run dir
  // was deleted while the stack stayed up): setting a fresh permanent
  // password re-syncs state without recreating the user.
  const creds: AdminCredentials = { email: TEST_ADMIN_EMAIL, password: generatePassword() };
  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: TEST_ADMIN_EMAIL,
      Password: creds.password,
      Permanent: true,
    }),
  );
  writeAdminCredentials(paths, creds);
  return creds;
}

async function userExists(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  username: string,
): Promise<boolean> {
  try {
    await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "UserNotFoundException") return false;
    throw err;
  }
}
