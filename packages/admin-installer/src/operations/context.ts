/**
 * What every operation receives besides its input: the Starkeep folder, the
 * admin lane's credentials, and stand-ins for tests.
 *
 * The cloud operations call {@link OperationContext.adminLane} once they know
 * the deployment's region. The runner's implementation reads the admin's
 * credentials from the environment, or else from the admin session file, and
 * makes them the only AWS credentials this process uses
 * (`useOnlyAwsCredentials`). The library calls under an operation, Pulumi
 * among them, read the process environment, so the swap has to happen there.
 * The operation itself never touches `process.env`.
 */
import type { STSClient } from "@aws-sdk/client-sts";
import type { InstallerAwsCredentials } from "../aws-env";
import type { installApp, uninstallApp } from "../orchestrator";
import type {
  installCloudDataServer,
  installDrive,
  uninstallCloudDataServer,
  uninstallDrive,
} from "../builtin-installs";
import type { deleteAppDataCloud } from "../cloud-app-data";
import type { createDsqlRegistry } from "../registry";
import type { ensurePulumiPassphrase } from "../pulumi-passphrase";
import type { probeAnonymousSurface } from "../post-install-probe";
import type { installLocalApp } from "../local-app-install";
import type { AppDataCountsDsql } from "../dsql-ddl";
import type { RunCommand } from "./steps";

/**
 * Stand-ins for the AWS clients and library calls an operation makes, which
 * tests pass, and hooks for a caller that runs the operation in its own
 * process. A run through the runner passes none.
 */
export interface OperationOverrides {
  sts?: Pick<STSClient, "send">;
  fetch?: typeof fetch;
  runCommand?: RunCommand;
  installApp?: typeof installApp;
  uninstallApp?: typeof uninstallApp;
  installCloudDataServer?: typeof installCloudDataServer;
  uninstallCloudDataServer?: typeof uninstallCloudDataServer;
  installDrive?: typeof installDrive;
  uninstallDrive?: typeof uninstallDrive;
  deleteAppDataCloud?: typeof deleteAppDataCloud;
  createDsqlRegistry?: typeof createDsqlRegistry;
  ensurePulumiPassphrase?: typeof ensurePulumiPassphrase;
  probeAnonymousSurface?: typeof probeAnonymousSurface;
  installLocalApp?: typeof installLocalApp;
  /**
   * Asks a person at a terminal to approve a deletion after seeing what it
   * removes. Only a caller in the same process can pass it; a run in a child
   * process names the app id in its input instead.
   */
  confirmDeletion?: (counts: AppDataCountsDsql) => Promise<boolean>;
}

export interface OperationContext {
  /** The folder whose `config.json` the operation reads and writes. */
  starkeepDir: string;
  /**
   * The admin's credentials, applied to this process for `region`. Throws an
   * `OperationError` with `NOT_SIGNED_IN` when none can be had.
   */
  adminLane(region: string): Promise<InstallerAwsCredentials>;
  overrides?: OperationOverrides;
}

/** The signature every operation shares. */
export type Operation<I, R> = (
  ctx: OperationContext,
  input: I,
  emit: import("./events").Emit,
) => Promise<R>;
