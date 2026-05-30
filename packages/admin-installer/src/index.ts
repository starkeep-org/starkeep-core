export { installApp, uninstallApp } from "./orchestrator";
export type { InstallerConfig, InstallInput, UninstallInput, InstallResult } from "./orchestrator";

export { runAppInstallDdl, runAppUninstallDdl } from "./dsql-ddl";
export type { DsqlDdlOptions } from "./dsql-ddl";

export {
  initializeSharedSchema,
  installerPgUser,
} from "./dsql-schema-init";
export type { SchemaInitOptions } from "./dsql-schema-init";

export { installCloudDataServer, installDrive, uninstallDrive } from "./builtin-installs";
export type {
  CloudDataServerInstallConfig,
  CloudDataServerInstallOutputs,
} from "./builtin-installs";

export { roleChain } from "./session";
export type { AwsCredentials } from "./session";

export {
  installLocal,
  uninstallLocal,
  LocalInstallError,
  ManifestValidationError,
} from "./local/installer";
export type { InstallLocalResult, UninstallLocalOptions } from "./local/installer";
export {
  listAppRegistry,
  appRegistryRow,
} from "./local/registry";
export type { RegisteredApp } from "./local/registry";
