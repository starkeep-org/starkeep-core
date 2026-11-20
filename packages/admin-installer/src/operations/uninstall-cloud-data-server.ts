/**
 * Uninstall the cloud data server and all of its AWS resources: Drive first,
 * while DSQL and the files bucket still exist, then `pulumi destroy` on the
 * cloud data server's stack and its role.
 *
 * It destroys the deployment's data, so the input must say `confirm: true`.
 */
import { deriveInstallerArns } from "../app-cli-config";
import { uninstallCloudDataServer, uninstallDrive } from "../builtin-installs";
import { customDomainInstallInput } from "../custom-domain";
import type { Operation } from "./context";
import {
  deploymentBanner,
  deploymentInstallerConfig,
  loadInstallerConfig,
  regionOf,
  resolveAccountId,
  writeInstallerConfig,
} from "./config";
import { OperationError } from "./errors";

export interface UninstallCloudDataServerInput {
  /** The person agreed to destroy the DSQL cluster, the files bucket and the rest. */
  confirm?: boolean;
}

export const DESTROY_WARNING =
  "This permanently destroys the DSQL cluster, the files bucket, the billing bucket, " +
  "the Lambda, the API Gateway and the app IAM role.";

export const uninstallCloudDataServerOp: Operation<
  UninstallCloudDataServerInput,
  { uninstalled: true; driveUninstalled: boolean }
> = async (ctx, input, emit) => {
  const config = loadInstallerConfig(ctx.starkeepDir);
  const region = regionOf(config);
  if (input.confirm !== true) {
    throw new OperationError(
      "NOT_CONFIRMED",
      `${DESTROY_WARNING} Confirm the uninstall (confirm: true). Nothing changed.`,
    );
  }
  const credentials = await ctx.adminLane(region);
  const accountId = await resolveAccountId(ctx, config, region);
  const arns = deriveInstallerArns(config, accountId, region);
  emit({
    type: "progress",
    message: deploymentBanner("Starkeep cloud data server uninstall", {
      region,
      stackPrefix: config.stackPrefix,
      accountId,
    }),
  });

  // Drive's role, Postgres role and grants come down through the
  // foundational install roles, so Drive goes while DSQL still exists. A
  // config without the install's outputs has nothing to aim the uninstall at.
  let driveUninstalled = false;
  if (
    config.apiGatewayId &&
    config.authorizerId &&
    config.s3Bucket &&
    config.auroraEndpoint &&
    config.apiGatewayExecutionArn
  ) {
    try {
      await (ctx.overrides?.uninstallDrive ?? uninstallDrive)(
        deploymentInstallerConfig(
          {
            ...config,
            apiGatewayId: config.apiGatewayId,
            authorizerId: config.authorizerId,
            s3Bucket: config.s3Bucket,
            auroraEndpoint: config.auroraEndpoint,
          },
          accountId,
          region,
        ),
        credentials,
      );
      driveUninstalled = true;
    } catch (err) {
      emit({
        type: "progress",
        message:
          `Warning: the Starkeep Drive uninstall failed: ${err instanceof Error ? err.message : String(err)}\n` +
          "Going on with the cloud data server; the Drive role may need removing by hand.",
      });
    }
  } else {
    emit({
      type: "progress",
      message: "Skipping the Starkeep Drive uninstall: the config holds no install outputs.",
    });
  }

  await (ctx.overrides?.uninstallCloudDataServer ?? uninstallCloudDataServer)({
    stackPrefix: config.stackPrefix,
    region,
    accountId,
    permissionsBoundaryArn: arns.permissionsBoundaryArn,
    foundationalPermissionsBoundaryArn: arns.foundationalPermissionsBoundaryArn,
    userDataOwnerPermissionsBoundaryArn: arns.userDataOwnerPermissionsBoundaryArn,
    managerRoleArn: arns.managerRoleArn,
    pulumiStateBucket: arns.pulumiStateBucket,
    userPoolId: config.userPoolId,
    adminUserPoolClientId: config.userPoolClientId,
    deviceUserPoolClientId: config.deviceUserPoolClientId ?? "",
    cognitoDomain: config.cognitoDomain ?? "",
    deploymentName: config.deploymentName ?? "",
    ...customDomainInstallInput(config),
  });

  // The uninstall deleted the distribution, the domain's records and every
  // certificate, and the old distribution's name would mislead a reinstall's
  // DNS check.
  const cleared = { ...loadInstallerConfig(ctx.starkeepDir) };
  delete cleared.customDomain;
  delete cleared.customDomainStatus;
  delete cleared.customDomainAttempted;
  delete cleared.customDomainKept;
  delete cleared.cloudfrontDomain;
  writeInstallerConfig(ctx.starkeepDir, cleared);
  emit({ type: "progress", message: "Uninstall complete." });
  return { uninstalled: true, driveUninstalled };
};
