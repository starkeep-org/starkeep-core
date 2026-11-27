/**
 * The signed-in admin, for a page that is about to ask the server to act in
 * the cloud.
 *
 * The browser holds no credentials. The server mints them from the shared
 * session file for each action (`lib/admin-auth.ts`), and the routes that hop
 * to Manager do so there (`@starkeep/operator/manager-credentials`). This
 * module only answers whether a session exists, and names the deployment.
 */

import { readCloudConfig } from "./cloud-config";
import { NotSignedInError, readAdminSession } from "./admin-session-client";

export interface OperatorSession {
  stackPrefix: string;
  region: string;
  /** The signed-in admin's Cognito `sub`. */
  userSub: string;
  email: string | null;
}

export async function operatorSession(): Promise<OperatorSession> {
  const cfg = await readCloudConfig();
  if (!cfg) throw new Error("Cloud is not configured. Complete the cloud setup first.");
  const session = await readAdminSession();
  if (!session.signedIn || !session.sub) throw new NotSignedInError();
  return {
    stackPrefix: cfg.stackPrefix,
    region: cfg.region,
    userSub: session.sub,
    email: session.email,
  };
}

/**
 * The admin's session when this machine has a cloud and someone is signed in,
 * else null. For a write that goes to the cloud when there is one and to this
 * machine otherwise; the server decides which and says when it needs a session
 * it did not get.
 */
export async function operatorSessionIfSignedIn(): Promise<OperatorSession | null> {
  const cfg = await readCloudConfig();
  if (!cfg) return null;
  const session = await readAdminSession();
  if (!session.signedIn || !session.sub) return null;
  return {
    stackPrefix: cfg.stackPrefix,
    region: cfg.region,
    userSub: session.sub,
    email: session.email,
  };
}
