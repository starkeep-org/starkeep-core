export { installApp, uninstallApp } from "./orchestrator";
export type { InstallerConfig, InstallInput, UninstallInput, InstallResult } from "./orchestrator";

export { runAppInstallDdl, runAppUninstallDdl } from "./dsql-ddl";
export type { DsqlDdlOptions } from "./dsql-ddl";

export {
  initializeSharedSchema,
  installerPgUser,
} from "./dsql-schema-init";
export type { SchemaInitOptions } from "./dsql-schema-init";

export {
  installCloudDataServer,
  uninstallCloudDataServer,
  installDrive,
  uninstallDrive,
  cloudDataServerBundleSha256Base64,
} from "./builtin-installs";
export type {
  CloudDataServerInstallConfig,
  CloudDataServerInstallOutputs,
} from "./builtin-installs";

export { formatAnonymousRouteReport } from "./anonymous-route-report";

export { roleChain } from "./session";
export type { AwsCredentials } from "./session";

/**
 * Device pairing. Exported for admin-web, which is where an operator pairs a
 * handset — registration is the one step a device cannot authenticate for
 * itself, so it happens in the privileged console.
 */
export {
  deviceKeyParameterName,
  putDeviceKeyParameter,
  deleteDeviceKeyParameter,
} from "./app-creds";
export type { DeviceRegistration } from "./app-creds";

export {
  regionFromUserPoolId,
  cognitoPasswordAuth,
  cognitoPasswordAuthTokens,
  getIdentityPoolCredentials,
} from "./cognito-auth";
export type {
  CognitoUserPoolRef,
  CognitoIdentityPoolRef,
  CognitoTokens,
  IdentityPoolCredentials,
} from "./cognito-auth";

export {
  installLocal,
  uninstallLocal,
  LocalInstallError,
  ManifestValidationError,
} from "./local/installer";
export type { InstallLocalResult, UninstallLocalOptions } from "./local/installer";
export {
  listAppRegistry,
  sizeClassKeysByApp,
  appRegistryRow,
  listInstallSteps,
} from "./local/registry";
export type { RegisteredApp, InstallStepRow } from "./local/registry";

// The cloud registry — the authoritative list of apps installed against a
// stack. Exported so the tier-3 suite can ask what is deployed instead of
// naming apps it happens to know about; see e2e-aws/src/journey.test.ts.
export { createDsqlRegistry } from "./registry";
export type { InstalledApp, Registry, RegistryOptions } from "./registry";

// The install-time anonymous-surface probe, exported for the same reason: the
// e2e asserts the deployed reality with the code the installer uses.
export { probeAnonymousSurface, formatProbeReport } from "./post-install-probe";
export type { ProbeReport, ProbeResult } from "./post-install-probe";
