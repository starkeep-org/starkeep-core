/**
 * Install, reinstall or update the cloud data server: the foundational
 * infrastructure (DSQL, the files bucket, Lambda, API Gateway, CloudFront)
 * and the shared schema. Writes the install's outputs to `config.json`.
 */
import { isDeploymentName } from "@starkeep/aws-bootstrap";
import { deriveInstallerArns } from "../app-cli-config";
import { installCloudDataServer, type CloudDataServerInstallOutputs } from "../builtin-installs";
import { customDomainInstallInput, nextCustomDomainConfig } from "../custom-domain";
import { ensurePulumiPassphrase } from "../pulumi-passphrase";
import type { Operation } from "./context";
import {
  deploymentBanner,
  installerConfigPath,
  loadInstallerConfig,
  regionOf,
  requireConfigFields,
  resolveAccountId,
  writeInstallerConfig,
  type InstallerFileConfig,
} from "./config";
import { OperationError } from "./errors";
import { runCommand, workspaceRoot } from "./steps";

export interface InstallCloudDataServerInput {
  /**
   * Provision disposable infrastructure without the production
   * data-protection hardening. Only the cloud e2e harness sets it. It travels
   * in the operation's input, never in an inherited environment variable, so
   * a real install cannot pick it up by accident.
   */
  ephemeral?: boolean;
}

export interface InstallCloudDataServerResult {
  apiGatewayUrl: string;
  publicBaseUrl: string;
  cloudfrontDomain: string;
  s3Bucket: string;
  auroraEndpoint: string;
  customDomain?: CloudDataServerInstallOutputs["customDomain"];
}

const SIGN_IN_REMEDY =
  "Run `starkeep setup --cloud`, or the Stack outputs step of admin-web's cloud setup. If the field stays missing, update the bootstrap stack first.";

export const installCloudDataServerOp: Operation<
  InstallCloudDataServerInput,
  InstallCloudDataServerResult
> = async (ctx, input, emit) => {
  const dir = ctx.starkeepDir;
  const config = loadInstallerConfig(dir);
  requireConfigFields(dir, config, ["deviceUserPoolClientId", "cognitoDomain"], SIGN_IN_REMEDY);
  // The sign-in page shows the deployment's name under the star.
  if (!config.deploymentName || !isDeploymentName(config.deploymentName)) {
    throw new OperationError(
      "CONFIG_INCOMPLETE",
      `${installerConfigPath(dir)} has no valid deploymentName. Name the deployment with \`starkeep setup --cloud --name\`, or on step 1 of admin-web's cloud setup.`,
    );
  }
  const region = regionOf(config);
  await ctx.adminLane(region);
  const accountId = await resolveAccountId(ctx, config, region);
  const arns = deriveInstallerArns(config, accountId, region);

  emit({
    type: "progress",
    message: deploymentBanner("Starkeep cloud data server install", {
      region,
      stackPrefix: config.stackPrefix,
      accountId,
    }),
  });

  // Rebuild dist.zip first. Otherwise the install uploads whatever zip was
  // built last, and when its hash matches what Lambda holds, Pulumi skips the
  // code update without a word.
  emit({ type: "progress", message: "Building the cloud data server bundle…" });
  const run = ctx.overrides?.runCommand ?? runCommand;
  const built = await run(
    {
      command: "pnpm",
      args: ["--filter", "@starkeep/builtin-cloud-data-server", "build"],
      cwd: workspaceRoot(),
    },
    emit,
  );
  if (built !== 0) {
    throw new OperationError(
      "BUNDLE_FAILED",
      `The cloud data server's build failed (exit ${built ?? "without a code"}).`,
    );
  }

  // CloudFormation cannot create a SecureString, so the installer creates the
  // Pulumi state passphrase once and never changes it.
  emit({ type: "progress", message: "Checking the Pulumi state passphrase…" });
  const ensure = ctx.overrides?.ensurePulumiPassphrase ?? ensurePulumiPassphrase;
  const passphrase = await ensure({ stackPrefix: config.stackPrefix, region });
  emit({
    type: "progress",
    message:
      passphrase === "created"
        ? "  Created the passphrase with a fresh random value."
        : "  The passphrase exists; leaving it as it is.",
  });

  // Record the domain this run attaches before anything touches AWS. A run
  // that fails part-way can leave the domain's certificate and records
  // behind, and the next run's grants must still cover them.
  let starting: InstallerFileConfig;
  try {
    starting = nextCustomDomainConfig(config, { stage: "starting" });
  } catch (err) {
    throw new OperationError("REFUSED", err instanceof Error ? err.message : String(err));
  }
  writeInstallerConfig(dir, starting);

  emit({ type: "progress", message: "Installing the cloud data server…" });
  const install = ctx.overrides?.installCloudDataServer ?? installCloudDataServer;
  const outputs = await install({
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
    deviceUserPoolClientId: config.deviceUserPoolClientId,
    cognitoDomain: config.cognitoDomain,
    deploymentName: config.deploymentName,
    ephemeral: input.ephemeral === true,
    ...(config.deploymentSettings !== undefined
      ? { deploymentSettings: config.deploymentSettings }
      : {}),
    // The domain to attach, and the earlier ones whose records and
    // certificate this run may need to delete.
    ...customDomainInstallInput(config),
  });

  const updated: InstallerFileConfig = {
    ...nextCustomDomainConfig(config, {
      stage: "succeeded",
      status: outputs.customDomain,
      kept: outputs.keptCertificate,
    }),
    accountId,
    permissionsBoundaryArn: arns.permissionsBoundaryArn,
    foundationalPermissionsBoundaryArn: arns.foundationalPermissionsBoundaryArn,
    userDataOwnerPermissionsBoundaryArn: arns.userDataOwnerPermissionsBoundaryArn,
    managerRoleArn: arns.managerRoleArn,
    pulumiStateBucket: arns.pulumiStateBucket,
    apiGatewayUrl: outputs.apiGatewayUrl,
    publicBaseUrl: outputs.publicBaseUrl,
    cloudfrontDomain: outputs.cloudfrontDomain,
    apiGatewayId: outputs.apiGatewayId,
    apiGatewayExecutionArn: outputs.apiGatewayExecutionArn,
    authorizerId: outputs.authorizerId,
    sessionAuthorizerId: outputs.sessionAuthorizerId,
    originAuthorizerId: outputs.originAuthorizerId,
    delegatedAuthorizerId: outputs.delegatedAuthorizerId,
    s3Bucket: outputs.bucketName,
    auroraEndpoint: outputs.auroraHostname,
    cloudAppsUserPoolClientId: outputs.cloudAppsUserPoolClientId,
    mobileAppsUserPoolClientId: outputs.mobileAppsUserPoolClientId,
  };
  writeInstallerConfig(dir, updated);

  const lines = [
    `Install complete. Updated ${installerConfigPath(dir)}:`,
    `  apiGatewayUrl  : ${outputs.apiGatewayUrl}`,
    `  publicBaseUrl  : ${outputs.publicBaseUrl}`,
  ];
  const domain = outputs.customDomain;
  if (domain?.status === "pending-validation") {
    lines.push(`  customDomain   : ${domain.name} awaits certificate validation.`);
    const record = domain.validationRecord;
    if (record)
      lines.push(`    Add ${record.type} ${record.name} -> ${record.value}, then install again.`);
  } else if (domain?.status === "awaiting-dns") {
    lines.push(`  customDomain   : ${domain.name} attached, but does not point at the cloud yet.`);
    lines.push(
      `    Point a CNAME at ${outputs.cloudfrontDomain}, then install again to make it canonical.`,
    );
  } else if (domain?.mode === "external") {
    lines.push(
      `  customDomain   : ${domain.name} attached. Point a CNAME at ${outputs.cloudfrontDomain}.`,
    );
  } else if (domain) {
    lines.push(`  customDomain   : ${domain.name} attached.`);
  }
  if (outputs.keptCertificate) {
    lines.push(
      `  customDomain   : the certificate for ${outputs.keptCertificate.name} stays on the ` +
        "distribution, with no alias, until another domain replaces it.",
    );
  }
  lines.push(`  s3Bucket       : ${outputs.bucketName}`);
  lines.push(`  auroraEndpoint : ${outputs.auroraHostname}`);
  emit({ type: "progress", message: lines.join("\n") });

  return {
    apiGatewayUrl: outputs.apiGatewayUrl,
    publicBaseUrl: outputs.publicBaseUrl,
    cloudfrontDomain: outputs.cloudfrontDomain,
    s3Bucket: outputs.bucketName,
    auroraEndpoint: outputs.auroraHostname,
    ...(outputs.customDomain ? { customDomain: outputs.customDomain } : {}),
  };
};
