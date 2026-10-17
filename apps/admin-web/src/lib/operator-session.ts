/**
 * The signed-in operator's AWS session, minted fresh for one privileged call.
 *
 * Minted per action rather than held: the credentials expire, and a stale one
 * surfaces as an opaque AWS error at the moment the operator is trying to do
 * something. The server routes that receive it hop to Manager before touching
 * SSM (`lib/manager-credentials.ts`).
 */

import {
  readCloudConfig,
  readCognitoSession,
  writeCloudCredentials,
  writeCognitoSession,
} from "./cloud-config";
import { getIdentityPoolCredentials, refreshTokens, type STSCredentials } from "./cognito-auth";

export interface OperatorSession {
  credentials: STSCredentials;
  stackPrefix: string;
  region: string;
  /** The signed-in operator's Cognito `sub`. */
  userSub: string;
}

export async function operatorSession(): Promise<OperatorSession> {
  const cfg = await readCloudConfig();
  if (!cfg) throw new Error("Cloud is not configured. Complete the cloud setup first.");
  const session = await readCognitoSession();
  if (!session?.refreshToken) throw new Error("Not signed in. Sign in from the dashboard first.");

  const tokens = await refreshTokens(cfg.cognitoConfig, session.refreshToken);
  const credentials = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
  await writeCloudCredentials(credentials);
  await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });

  return { credentials, stackPrefix: cfg.stackPrefix, region: cfg.region, userSub: subOf(tokens.idToken) };
}

/**
 * The operator's session when this machine has a cloud and someone is signed
 * in, else null. For a write that goes to the cloud when there is one and to
 * this machine otherwise; the server decides which and says when it needs a
 * session it did not get.
 */
export async function operatorSessionIfSignedIn(): Promise<OperatorSession | null> {
  const cfg = await readCloudConfig();
  const session = await readCognitoSession();
  if (!cfg || !session?.refreshToken) return null;
  return operatorSession();
}

/** The `sub` claim of an ID token. The token came straight from Cognito, so it is read, not verified. */
export function subOf(idToken: string): string {
  const payload = idToken.split(".")[1] ?? "";
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  const sub = (JSON.parse(json) as { sub?: unknown }).sub;
  if (typeof sub !== "string" || sub === "") throw new Error("The sign-in token names no user.");
  return sub;
}
