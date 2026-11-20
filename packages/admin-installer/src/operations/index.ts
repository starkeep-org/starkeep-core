/**
 * The installer's operations: one function per cloud or local install step
 * that admin-web and the CLI start, each with a typed input, structured
 * events and a typed result. `run.ts` runs one by name.
 */
import type { Operation } from "./context";
import { deleteAppDataOp } from "./delete-app-data";
import { installCloudAppOp } from "./install-cloud-app";
import { installCloudDataServerOp } from "./install-cloud-data-server";
import { installDriveOp } from "./install-drive";
import { installLocalAppOp } from "./install-local-app";
import { uninstallCloudAppOp } from "./uninstall-cloud-app";
import { uninstallCloudDataServerOp } from "./uninstall-cloud-data-server";

export const OPERATIONS = {
  "install-cloud-data-server": installCloudDataServerOp,
  "install-drive": installDriveOp,
  "install-cloud-app": installCloudAppOp,
  "install-local-app": installLocalAppOp,
  "uninstall-cloud-app": uninstallCloudAppOp,
  "uninstall-cloud-data-server": uninstallCloudDataServerOp,
  "delete-app-data": deleteAppDataOp,
} as const satisfies Record<string, Operation<never, unknown>>;

export type OperationName = keyof typeof OPERATIONS;

/** The input type of the operation `N`. */
export type OperationInput<N extends OperationName> = Parameters<(typeof OPERATIONS)[N]>[1];

export function isOperationName(name: string): name is OperationName {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, name);
}

export * from "./events";
export * from "./errors";
export type { Operation, OperationContext, OperationOverrides } from "./context";
export type { InstallCloudAppInput, InstallCloudAppResult } from "./install-cloud-app";
export type {
  InstallCloudDataServerInput,
  InstallCloudDataServerResult,
} from "./install-cloud-data-server";
export type { UninstallCloudAppInput } from "./uninstall-cloud-app";
export type { DeleteAppDataInput, DeleteAppDataResult } from "./delete-app-data";
export type { InstallLocalAppInput } from "./install-local-app";
