/**
 * The AWS part of an installer's environment, and nothing inherited.
 *
 * An installer must run with exactly the credentials the operator signed in
 * for. The AWS SDK for JavaScript v3 reads its credential source from the
 * environment, and it prefers `AWS_PROFILE` over a static key pair, so a
 * profile left in the shell that started admin-web would silently win (#134).
 * Other `AWS_*` variables (`AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`,
 * `AWS_CONTAINER_CREDENTIALS_*`, `AWS_CONFIG_FILE`) select credential sources
 * too, so every one goes. Settings that select no credentials, such as
 * `AWS_CA_BUNDLE`, go as well: the rule is all or nothing, never a hidden
 * keep-list. Passing chosen settings through would be a later, explicit
 * opt-in.
 *
 * An app's own dependency install and build step need no AWS access at all,
 * so they get none of the installer's AWS variables. That is hygiene, not
 * isolation: it stops a build tool from logging the credentials, baking them
 * into the bundle, or calling AWS with them by accident. App code still runs
 * as the operator's OS user and can read the installer's own environment
 * (`ps -Eww <pid>` on macOS).
 */

/** The credentials an installer runs with. */
export interface InstallerAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** A copy of `env` with every `AWS_*` variable removed. */
export function withoutAwsVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("AWS_")) out[key] = value;
  }
  return out;
}

/** The four variables that hand an installer its credentials and region. */
export function awsVariables(
  creds: InstallerAwsCredentials,
  region: string,
): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
    AWS_REGION: region,
  };
}

/**
 * An installer child's environment: the parent's, minus every `AWS_*`
 * variable, plus the given credentials and region.
 */
export function installerEnv(
  creds: InstallerAwsCredentials,
  region: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...withoutAwsVariables(env), ...awsVariables(creds, region) };
}

/**
 * Make this process's AWS environment exactly `creds` and `region`, for an
 * installer CLI whose in-process SDK clients read the environment.
 */
export function useOnlyAwsCredentials(creds: InstallerAwsCredentials, region: string): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AWS_")) delete process.env[key];
  }
  Object.assign(process.env, awsVariables(creds, region));
}
