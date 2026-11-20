/**
 * Shapes the browser half shares with the server about Cognito. The browser
 * signs nobody in itself: every sign-in happens on the managed login page
 * (`routes/auth.ts`), and the server keeps the session.
 */

export interface CognitoConfig {
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  region: string;
}

export interface STSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

/** The group whose members administer the deployment. */
export const ADMINS_GROUP = "starkeep-admins";
