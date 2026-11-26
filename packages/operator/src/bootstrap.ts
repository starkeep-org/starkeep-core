/**
 * The AWS account owner lane: the bootstrap stack and nothing else. Setup
 * creates the stack here, and `starkeep cloud bootstrap-update` (which
 * `scripts/update-bootstrap.sh` runs) updates it here.
 *
 * This is the only module that reads the terminal's own AWS credentials (a
 * profile, SSO or environment variables), through the SDK's default chain.
 * The bootstrap stack creates the admin's role and the user pool that signs
 * the admin in, so it cannot run as the admin. Everything else runs in the
 * admin lane, with credentials minted from the admin's Cognito sign-in
 * (`admin-session.ts`), and a test holds every other module to that.
 *
 * Before any write here, the CLI shows the account, the caller and the region,
 * refuses an account that differs from `config.json`'s `accountId`, warns on
 * the root user, and asks.
 */
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  waitUntilChangeSetCreateComplete,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
  type Change,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { structuredPatch } from "diff";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { generateBootstrapTemplate, inlineTemplateBody } from "@starkeep/aws-bootstrap";

export interface CallerIdentity {
  account: string;
  arn: string;
  /** The account's root user, which should not run day-to-day operations. */
  isRoot: boolean;
}

export interface OwnerClients {
  sts?: Pick<STSClient, "send">;
  cloudFormation?: Pick<CloudFormationClient, "send">;
  /** Waits for a stack create to finish. Tests pass one that returns at once. */
  waitForCreate?: (stackName: string) => Promise<void>;
}

/** Who the terminal's AWS credentials are, or a message that says how to sign in. */
export async function callerIdentity(
  region: string,
  clients: OwnerClients = {},
): Promise<CallerIdentity> {
  const sts = clients.sts ?? new STSClient({ region });
  let res;
  try {
    res = await sts.send(new GetCallerIdentityCommand({}));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `This terminal has no working AWS credentials (${reason}). ` +
        "Sign in to the AWS account with `aws configure sso` or `aws sso login`, or set AWS_PROFILE, then run the command again.",
    );
  }
  if (!res.Account || !res.Arn)
    throw new Error("AWS did not say which account these credentials belong to.");
  return { account: res.Account, arn: res.Arn, isRoot: res.Arn.endsWith(":root") };
}

export function bootstrapStackName(stackPrefix: string): string {
  return `${stackPrefix}-bootstrap`;
}

/** The bootstrap stack, or null when none exists with this prefix. */
export async function describeBootstrapStack(
  stackPrefix: string,
  region: string,
  clients: OwnerClients = {},
): Promise<Stack | null> {
  const cf = clients.cloudFormation ?? new CloudFormationClient({ region });
  try {
    const res = await cf.send(
      new DescribeStacksCommand({ StackName: bootstrapStackName(stackPrefix) }),
    );
    return res.Stacks?.[0] ?? null;
  } catch (err) {
    // DescribeStacks signals "no such stack" as a ValidationError.
    if ((err as { name?: string }).name === "ValidationError") return null;
    throw err;
  }
}

/** A stack state that holds the outputs setup needs. */
export function isUsableStack(stack: Stack): boolean {
  return ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(
    stack.StackStatus ?? "",
  );
}

/**
 * The bootstrap outputs `config.json` records, under the names the wizard and
 * the installer use.
 */
export interface BootstrapConfigOutputs {
  userPoolId: string;
  userPoolClientId: string;
  deviceUserPoolClientId: string;
  cognitoDomain: string;
  identityPoolId: string;
  managerRoleArn?: string;
  permissionsBoundaryArn?: string;
  foundationalPermissionsBoundaryArn?: string;
  userDataOwnerPermissionsBoundaryArn?: string;
  installDdlRoleArn?: string;
  installInfraRoleArn?: string;
  pulumiStateBucket?: string;
}

const REQUIRED_OUTPUTS: Record<string, keyof BootstrapConfigOutputs> = {
  UserPoolId: "userPoolId",
  UserPoolClientId: "userPoolClientId",
  DeviceUserPoolClientId: "deviceUserPoolClientId",
  CognitoDomain: "cognitoDomain",
  IdentityPoolId: "identityPoolId",
};

const OPTIONAL_OUTPUTS: Record<string, keyof BootstrapConfigOutputs> = {
  ManagerRoleArn: "managerRoleArn",
  AppPermissionsBoundaryArn: "permissionsBoundaryArn",
  AppFoundationalPermissionsBoundaryArn: "foundationalPermissionsBoundaryArn",
  UserDataOwnerPermissionsBoundaryArn: "userDataOwnerPermissionsBoundaryArn",
  InstallDdlRoleArn: "installDdlRoleArn",
  InstallInfraRoleArn: "installInfraRoleArn",
  PulumiStateBucketName: "pulumiStateBucket",
};

export function bootstrapOutputs(stack: Stack): BootstrapConfigOutputs {
  const byKey = new Map((stack.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue] as const));
  const out: Partial<BootstrapConfigOutputs> = {};
  const missing: string[] = [];
  for (const [key, field] of Object.entries(REQUIRED_OUTPUTS)) {
    const value = byKey.get(key);
    if (value) out[field] = value;
    else missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `The bootstrap stack ${stack.StackName} has no ${missing.join(", ")} output. ` +
        "Update it with scripts/update-bootstrap.sh --apply, then run setup again.",
    );
  }
  for (const [key, field] of Object.entries(OPTIONAL_OUTPUTS)) {
    const value = byKey.get(key);
    if (value) out[field] = value;
  }
  return out as BootstrapConfigOutputs;
}

export interface CreateBootstrapInput {
  stackPrefix: string;
  region: string;
  deploymentName: string;
  /** The first admin. Cognito emails this address a temporary password. */
  adminEmail: string;
}

/**
 * Create the bootstrap stack and wait for it. The template goes inline,
 * without its comments, which count toward CloudFormation's inline cap.
 */
export async function createBootstrapStack(
  input: CreateBootstrapInput,
  clients: OwnerClients = {},
): Promise<Stack> {
  const cf = clients.cloudFormation ?? new CloudFormationClient({ region: input.region });
  const stackName = bootstrapStackName(input.stackPrefix);
  const template = inlineTemplateBody(
    generateBootstrapTemplate({
      stackPrefix: input.stackPrefix,
      deploymentName: input.deploymentName,
      adminEmail: input.adminEmail,
    }),
  );
  await cf.send(
    new CreateStackCommand({
      StackName: stackName,
      TemplateBody: template,
      Parameters: [
        { ParameterKey: "StackPrefix", ParameterValue: input.stackPrefix },
        { ParameterKey: "AdminEmail", ParameterValue: input.adminEmail },
      ],
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      Tags: [{ Key: "starkeep:managed", Value: "true" }],
    }),
  );
  if (clients.waitForCreate) await clients.waitForCreate(stackName);
  else
    await waitUntilStackCreateComplete(
      { client: cf as CloudFormationClient, maxWaitTime: 20 * 60 },
      { StackName: stackName },
    );
  const created = await describeBootstrapStack(input.stackPrefix, input.region, {
    cloudFormation: cf,
  });
  if (!created) throw new Error(`The stack ${stackName} vanished after it was created.`);
  return created;
}

// ── Updating the stack ───────────────────────────────────────────────────────

/** CloudFormation's limit on an inline `TemplateBody`. */
export const MAX_INLINE_TEMPLATE_BYTES = 51_200;

export interface BootstrapUpdateTarget {
  stackPrefix: string;
  region: string;
  /** The template bakes the name into the invitation email as literal text. */
  deploymentName: string;
}

/** The template this checkout renders for an update, without comments. */
export function renderUpdateTemplate(target: BootstrapUpdateTarget): string {
  const body = inlineTemplateBody(
    generateBootstrapTemplate({
      stackPrefix: target.stackPrefix,
      deploymentName: target.deploymentName,
    }),
  );
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_INLINE_TEMPLATE_BYTES) {
    throw new Error(
      `Error: the template is ${bytes} bytes, over CloudFormation's 51,200-byte inline limit.`,
    );
  }
  return body;
}

export interface ResourceChangeRow {
  action: string;
  resource: string;
  type: string;
  replacement: string;
  scope: string;
}

export type BootstrapPreview =
  | { kind: "no-changes" }
  | {
      kind: "changes";
      changeSetName: string;
      changes: ResourceChangeRow[];
      /** Changes that remove or replace a resource, or may replace one. */
      risky: number;
      /** With `verbose`: each changed property and the template diff. */
      details?: string[];
    };

export interface UpdateClients extends OwnerClients {
  waitForChangeSet?: (stackName: string, changeSetName: string) => Promise<void>;
  waitForUpdate?: (stackName: string) => Promise<void>;
  /** For tests: the change set's name, which otherwise carries the time. */
  changeSetName?: string;
}

function cfnClient(region: string, clients: OwnerClients): Pick<CloudFormationClient, "send"> {
  return clients.cloudFormation ?? new CloudFormationClient({ region });
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Preview an update of the bootstrap stack as a change set. Every parameter
 * the live stack has keeps its previous value, so the update never touches
 * AdminEmail and never replaces the first admin.
 *
 * Leaves the change set in place when it holds changes, so the caller can
 * apply it or delete it. Deletes it when it holds none.
 */
export async function previewBootstrapUpdate(
  target: BootstrapUpdateTarget,
  options: { verbose?: boolean } = {},
  clients: UpdateClients = {},
): Promise<BootstrapPreview> {
  const cf = cfnClient(target.region, clients);
  const stackName = bootstrapStackName(target.stackPrefix);
  const template = renderUpdateTemplate(target);
  const stack = await describeBootstrapStack(target.stackPrefix, target.region, {
    cloudFormation: cf,
  });
  if (!stack) throw new Error(`No stack named ${stackName} exists in ${target.region}.`);
  const changeSetName = clients.changeSetName ?? `update-bootstrap-${stamp()}`;
  await cf.send(
    new CreateChangeSetCommand({
      StackName: stackName,
      ChangeSetName: changeSetName,
      ChangeSetType: "UPDATE",
      TemplateBody: template,
      Parameters: (stack.Parameters ?? []).map((p) => ({
        ParameterKey: p.ParameterKey,
        UsePreviousValue: true,
      })),
      Capabilities: ["CAPABILITY_NAMED_IAM"],
    }),
  );
  try {
    if (clients.waitForChangeSet) await clients.waitForChangeSet(stackName, changeSetName);
    else
      await waitUntilChangeSetCreateComplete(
        { client: cf as CloudFormationClient, maxWaitTime: 10 * 60 },
        { StackName: stackName, ChangeSetName: changeSetName },
      );
  } catch {
    const described = await cf.send(
      new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }),
    );
    await deleteChangeSet(target, changeSetName, clients);
    const reason = described.StatusReason ?? "";
    if (
      reason.includes("didn't contain changes") ||
      reason.includes("No updates are to be performed")
    )
      return { kind: "no-changes" };
    throw new Error(`Error: the change set failed: ${reason}`);
  }
  const changes = await allChanges(cf, stackName, changeSetName, false);
  const rows: ResourceChangeRow[] = changes.map((c) => {
    const rc = c.ResourceChange ?? {};
    return {
      action: rc.Action ?? "",
      resource: rc.LogicalResourceId ?? "",
      type: rc.ResourceType ?? "",
      replacement: rc.Replacement ?? "",
      scope: (rc.Scope ?? []).join(","),
    };
  });
  const risky = rows.filter(
    (r) => r.action === "Remove" || r.replacement === "True" || r.replacement === "Conditional",
  ).length;
  const preview: BootstrapPreview = { kind: "changes", changeSetName, changes: rows, risky };
  if (options.verbose) {
    const withValues = await allChanges(cf, stackName, changeSetName, true);
    const live = await cf.send(
      new GetTemplateCommand({ StackName: stackName, TemplateStage: "Original" }),
    );
    preview.details = verboseDetails(changes, withValues, live.TemplateBody ?? "", template);
  }
  return preview;
}

async function allChanges(
  cf: Pick<CloudFormationClient, "send">,
  stackName: string,
  changeSetName: string,
  includePropertyValues: boolean,
): Promise<Change[]> {
  const out: Change[] = [];
  let token: string | undefined;
  do {
    const page = await cf.send(
      new DescribeChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ...(includePropertyValues ? { IncludePropertyValues: true } : {}),
        ...(token ? { NextToken: token } : {}),
      }),
    );
    out.push(...(page.Changes ?? []));
    token = page.NextToken;
  } while (token);
  return out;
}

function valueLines(value: string | undefined): string[] {
  if (value === undefined) return [];
  try {
    return JSON.stringify(sortKeys(JSON.parse(value)), null, 2).split("\n");
  } catch {
    return value.split("\n");
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function diffLines(before: string[], after: string[], indent: string): string[] {
  const patch = structuredPatch(
    "before",
    "after",
    before.join("\n") + "\n",
    after.join("\n") + "\n",
    "",
    "",
    {
      context: 3,
    },
  );
  const out: string[] = [];
  for (const hunk of patch.hunks) {
    out.push(
      `${indent}@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) out.push(`${indent}${line}`);
  }
  return out;
}

/**
 * Each changed resource with its changed properties and a diff of each old
 * and new value, then the deployed template against the new one.
 * CloudFormation leaves the values it resolves only during the update out of
 * the property values, so the plain listing supplies those changes.
 */
export function verboseDetails(
  plain: Change[],
  withValues: Change[],
  liveTemplate: string,
  newTemplate: string,
): string[] {
  const byId = new Map(withValues.map((c) => [c.ResourceChange?.LogicalResourceId, c]));
  const out: string[] = [];
  let truncated = false;
  for (const change of plain) {
    const id = change.ResourceChange?.LogicalResourceId;
    const rc = (byId.get(id) ?? change).ResourceChange ?? {};
    out.push("");
    out.push(
      `== ${rc.LogicalResourceId} (${rc.ResourceType}): ${rc.Action}, replacement ${rc.Replacement ?? "n/a"}`,
    );
    const seen = new Set<string>();
    for (const detail of rc.Details ?? []) {
      const t = detail.Target ?? {};
      const path = t.Path ?? t.Name ?? t.Attribute;
      const key = JSON.stringify([path, detail.Evaluation, t.BeforeValue, t.AfterValue]);
      if (seen.has(key)) continue;
      seen.add(key);
      const cause = detail.CausingEntity ?? detail.ChangeSource ?? "";
      out.push(
        `  ${path}: ${t.AttributeChangeType ?? "Modify"}, ${detail.Evaluation}, recreation ${t.RequiresRecreation}, caused by ${cause}`,
      );
      if (!byId.has(id)) {
        out.push(
          "    (CloudFormation resolves this value during the update and lists no before or after)",
        );
        continue;
      }
      const before = valueLines(t.BeforeValue);
      const after = valueLines(t.AfterValue);
      if ([before, after].some((v) => v[0]?.startsWith("(Truncated-Signature)"))) {
        truncated = true;
        out.push(
          "    (CloudFormation truncated this value; the template diff below shows the change)",
        );
        continue;
      }
      if (before.join("\n") === after.join("\n")) {
        if (before.length > 0)
          out.push(
            "    (value unchanged in the preview; CloudFormation resolves it during the update)",
          );
        continue;
      }
      out.push(...diffLines(before, after, "    "));
    }
  }
  // The deployed template can hold "?" where the source has a non-ASCII
  // character, so both sides drop those characters to "?" before the diff.
  const ascii = (text: string) => text.replace(/[^\x00-\x7f]/g, "?").split("\n");
  out.push("");
  out.push(`== Template diff (deployed → new)${truncated ? "" : ", for reference"}`);
  out.push(...diffLines(ascii(liveTemplate), ascii(newTemplate), "  "));
  return out;
}

export async function deleteChangeSet(
  target: BootstrapUpdateTarget,
  changeSetName: string,
  clients: OwnerClients = {},
): Promise<void> {
  await cfnClient(target.region, clients).send(
    new DeleteChangeSetCommand({
      StackName: bootstrapStackName(target.stackPrefix),
      ChangeSetName: changeSetName,
    }),
  );
}

/**
 * Apply a previewed change set and wait for the stack. A failed update
 * throws with the stack's final status: CloudFormation rolls it back to the
 * previous template.
 */
export async function applyChangeSet(
  target: BootstrapUpdateTarget,
  changeSetName: string,
  clients: UpdateClients = {},
): Promise<void> {
  const cf = cfnClient(target.region, clients);
  const stackName = bootstrapStackName(target.stackPrefix);
  await cf.send(
    new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }),
  );
  try {
    if (clients.waitForUpdate) await clients.waitForUpdate(stackName);
    else
      await waitUntilStackUpdateComplete(
        { client: cf as CloudFormationClient, maxWaitTime: 30 * 60 },
        { StackName: stackName },
      );
  } catch {
    const stack = await describeBootstrapStack(target.stackPrefix, target.region, {
      cloudFormation: cf,
    });
    throw new BootstrapUpdateFailed(target, stack?.StackStatus ?? "an unknown state");
  }
}

export class BootstrapUpdateFailed extends Error {
  constructor(
    target: BootstrapUpdateTarget,
    readonly status: string,
  ) {
    const stackName = bootstrapStackName(target.stackPrefix);
    super(
      [
        `Error: the update ended in ${status}. CloudFormation rolls a failed update back to the previous template.`,
        "The stack's events name the failing resource:",
        `  aws cloudformation describe-stack-events --stack-name ${stackName} --region ${target.region} --max-items 20`,
      ].join("\n"),
    );
    this.name = "BootstrapUpdateFailed";
  }
}
