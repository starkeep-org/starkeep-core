import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { Container, Title, Button, TextInput, Stack, Alert, Paper, Text, Code, Stepper } from "@mantine/core";
import { useState } from "react";
import { requireCustomerId } from "../lib/auth.server";

type ExistingSettings = {
  accountId: string;
  externalId: string;
  stackPrefix: string;
  defaultRegion: string;
  allowedRegions: string[] | null;
  roleArn: string;
  executionRoleArn: string | null;
  permissionBoundaryArn: string | null;
};

type LoaderData = {
  controlPlaneAccountId: string;
  existingSettings: ExistingSettings | null;
};

type ActionData =
  | { error: string }
  | {
      success: true;
      template: string;
      externalId: string;
      controlPlaneAccountId: string;
      stackPrefix: string;
      allowedRegions: string[];
      quickCreateLink: string;
      templateUrl: string;
    };

export async function loader({ request }: LoaderFunctionArgs) {
  const customerId = await requireCustomerId(request);
  // Get control plane account ID from env
  const controlPlaneAccountId = process.env.AWS_ACCOUNT_ID || "123456789012";
  const { AwsSettingsRepository } = await import("@starkeep/admin-db");
  const awsSettingsRepo = new AwsSettingsRepository();
  const settings = await awsSettingsRepo.findByCustomerId(customerId);

  const existingSettings = settings
    ? {
        accountId: settings.account_id,
        externalId: settings.external_id,
        stackPrefix: settings.stack_prefix,
        defaultRegion: settings.default_region,
        allowedRegions: settings.allowed_regions,
        roleArn: settings.role_arn,
        executionRoleArn: settings.execution_role_arn,
        permissionBoundaryArn: settings.permission_boundary_arn,
      }
    : null;

  return json<LoaderData>({ controlPlaneAccountId, existingSettings });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const action = formData.get("action");

  if (action === "generate-template") {
    const { generateBootstrapTemplate, generateExternalId, generateBootstrapQuickCreateLink } = await import("@starkeep/admin-core");
    const { AwsSettingsRepository, uploadTemplate } = await import("@starkeep/admin-db");

    const customerId = await requireCustomerId(request);
    const awsSettingsRepo = new AwsSettingsRepository();
    const existingSettings = await awsSettingsRepo.findByCustomerId(customerId);
    const controlPlaneAccountId = process.env.AWS_ACCOUNT_ID || "123456789012";
    const region = formData.get("region")?.toString() || existingSettings?.default_region || "us-east-1";
    const stackPrefix = formData.get("stackPrefix")?.toString() || existingSettings?.stack_prefix || "app";
    const allowedRegionsRaw = formData.get("allowedRegions")?.toString() || "";
    const allowedRegions = allowedRegionsRaw.split(",").map(r => r.trim()).filter(Boolean);
    const artifactsBucket = process.env.ARTIFACTS_BUCKET;

    if (!artifactsBucket) {
      return json(
        { error: "ARTIFACTS_BUCKET not configured" },
        { status: 500 }
      );
    }

    // Generate external ID
    const externalId = existingSettings?.external_id || generateExternalId();

    // Generate CloudFormation template
    const template = generateBootstrapTemplate({
      controlPlaneAccountId,
      externalId,
      customerAccountId: "CUSTOMER_ACCOUNT_ID", // Customer will fill this in
      stackPrefix,
      allowedRegions: allowedRegions.length > 0 ? allowedRegions : undefined,
    });

    // Upload bootstrap template to S3
    const uploadResult = await uploadTemplate({
      customerId,
      templateName: `bootstrap-${Date.now()}`,
      templateContent: template,
      bucketName: artifactsBucket,
      region,
    });

    // Generate Quick Create link with real S3 URL
    const quickCreateLink = generateBootstrapQuickCreateLink({
      region,
      templateUrl: uploadResult.url,
      controlPlaneAccountId,
      externalId,
      stackPrefix,
    });

    return json<ActionData>({
      success: true,
      template,
      externalId,
      controlPlaneAccountId,
      stackPrefix,
      allowedRegions,
      quickCreateLink,
      templateUrl: uploadResult.url,
    });
  }

  if (action === "save-connection") {
    const roleArn = formData.get("roleArn");
    const executionRoleArn = formData.get("executionRoleArn");
    const permissionBoundaryArn = formData.get("permissionBoundaryArn");
    const externalId = formData.get("externalId");
    const accountId = formData.get("accountId");
    const stackPrefix = formData.get("stackPrefix");

    if (!roleArn || !externalId || !accountId) {
      return json<ActionData>(
        { error: "Role ARN, External ID, and Account ID are required" },
        { status: 400 }
      );
    }

    const { AwsSettingsRepository } = await import("@starkeep/admin-db");
    const customerId = await requireCustomerId(request);

    const awsSettingsRepo = new AwsSettingsRepository();

    // Create or update AWS settings with cross-account role
    await awsSettingsRepo.upsert({
      customer_id: customerId,
      account_id: accountId.toString(),
      role_arn: roleArn.toString(),
      external_id: externalId.toString(),
      execution_role_arn: executionRoleArn?.toString(),
      permission_boundary_arn: permissionBoundaryArn?.toString(),
      stack_prefix: stackPrefix?.toString() || "app",
    });

    // Redirect to deployments page after successful connection
    return redirect("/deployments/new");
  }

  return json<ActionData>({ error: "Invalid action" }, { status: 400 });
}

export default function AwsConnect() {
  const { controlPlaneAccountId, existingSettings } = useLoaderData<LoaderData>();
  const actionData = useActionData<ActionData>();
  const templateData = actionData && "template" in actionData ? actionData : null;
  const actionError = actionData && "error" in actionData ? actionData.error : null;
  const [activeStep, setActiveStep] = useState(0);
  const defaultRegion = existingSettings?.defaultRegion || "us-east-1";
  const defaultStackPrefix = existingSettings?.stackPrefix || "app";
  const defaultAllowedRegions = existingSettings?.allowedRegions?.join(", ") || "";

  return (
    <Container size="lg" py="xl">
      <Title order={1} mb="xl">Connect Your AWS Account</Title>

      <Text mb="xl" size="lg">
        To allow Starkeeper to manage infrastructure in your AWS account, you need to create a cross-account IAM role.
        This works whether you're managing your own accounts or customer accounts.
      </Text>

      {existingSettings && (
        <Alert color="blue" mb="xl">
          Existing AWS connection detected. Generating a new bootstrap template will reuse your current external ID and stack prefix.
        </Alert>
      )}

      <Stepper active={activeStep} onStepClick={setActiveStep} mb="xl">
        <Stepper.Step label="Step 1" description="Generate CloudFormation template">
          <Paper p="md" withBorder mt="md">
            <Text mb="md">
              Configure your bootstrap settings and generate a CloudFormation template that creates the necessary IAM roles in your AWS account.
            </Text>

            <Form method="post">
              <input type="hidden" name="action" value="generate-template" />
              <Stack gap="md">
                <TextInput
                  label="AWS Region"
                  name="region"
                  defaultValue={defaultRegion}
                  required
                  description="Region where the bootstrap stack will be created"
                />

                <TextInput
                  label="Stack Prefix"
                  name="stackPrefix"
                  defaultValue={defaultStackPrefix}
                  required
                  description="Stack name prefix that Starkeeper is allowed to manage (e.g., 'app', 'myapp')"
                />

                <TextInput
                  label="Allowed Regions (optional)"
                  name="allowedRegions"
                  placeholder="us-east-1, us-west-2"
                  defaultValue={defaultAllowedRegions}
                  description="Comma-separated list of regions where Starkeeper can deploy stacks. Leave blank for all regions."
                />

                <Button type="submit" size="md">
                  Generate CloudFormation Template
                </Button>
              </Stack>
            </Form>

            {templateData && (
              <Stack mt="xl" gap="md">
                <Alert color="green">
                  Template generated! Use the Quick Create link below for one-click deployment.
                </Alert>

                <Paper p="md" withBorder>
                  <Text fw={500} mb="xs">Quick Create Link (Recommended):</Text>
                  <Button
                    component="a"
                    href={templateData.quickCreateLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    fullWidth
                    size="lg"
                  >
                    Deploy to AWS Console (One-Click)
                  </Button>
                  <Text size="xs" c="dimmed" mt="xs">
                    This link will open AWS CloudFormation console with all parameters pre-filled.
                  </Text>
                </Paper>

                <Paper p="md" withBorder>
                  <Text fw={500} mb="xs">Or copy the template manually:</Text>
                  <Code block style={{ maxHeight: "400px", overflow: "auto" }}>
                    {templateData.template}
                  </Code>
                </Paper>

                <Alert color="blue">
                  <Text fw={500} mb="xs">External ID (keep this secure):</Text>
                  <Code>{templateData.externalId}</Code>
                  <Text size="sm" mt="xs">
                    You'll need this in Step 3. Stack Prefix: <Code>{templateData.stackPrefix}</Code>
                  </Text>
                </Alert>

                <Button onClick={() => setActiveStep(1)}>
                  Next: Deploy Template
                </Button>
              </Stack>
            )}
          </Paper>
        </Stepper.Step>

        <Stepper.Step label="Step 2" description="Deploy in your AWS account">
          <Paper p="md" withBorder mt="md">
            <Text mb="md">
              Deploy or update the bootstrap stack in your AWS account:
            </Text>

            {templateData ? (
              <Alert color="blue" mb="md">
                <Text fw={500}>Recommended: Use the Quick Create link from Step 1</Text>
                <Text size="sm" mt="xs">
                  The Quick Create link will open AWS CloudFormation console with all parameters pre-filled.
                </Text>
              </Alert>
            ) : (
              <Alert color="yellow" mb="md">
                Generate the template in Step 1 first, then return here to deploy or update the stack.
              </Alert>
            )}

            <Text fw={500} mb="sm">Manual deployment steps:</Text>
            <ol>
              <li>Log into your AWS Console</li>
              <li>Go to CloudFormation service</li>
              <li>If this is your first time: click "Create Stack" → "With new resources"</li>
              <li>If you already have <Code>StarkeeperBootstrap</Code>: select it and choose "Update stack"</li>
              <li>Choose "Replace current template" and provide the template URL or upload the template</li>
              <li>Fill in parameters (ControlPlaneAccountId, ExternalId, StackPrefix)</li>
              <li>Acknowledge IAM capabilities checkbox</li>
              <li>Create/update the stack and wait for completion (status: CREATE_COMPLETE/UPDATE_COMPLETE)</li>
            </ol>

            {templateData && (
              <Paper p="md" withBorder mt="md">
                <Text fw={500} mb="xs">Template URL (for update):</Text>
                <Code block>{templateData.templateUrl}</Code>
              </Paper>
            )}

            <Button onClick={() => setActiveStep(2)} mt="md">
              Next: Connect Account
            </Button>
          </Paper>
        </Stepper.Step>

        <Stepper.Step label="Step 3" description="Provide role details">
          <Paper p="md" withBorder mt="md">
            <Text mb="md">
              After deploying the CloudFormation stack, copy the outputs and paste them below:
            </Text>

            <Form method="post">
              <input type="hidden" name="action" value="save-connection" />
              <Stack gap="md">
                <TextInput
                  label="Role ARN (required)"
                  name="roleArn"
                  defaultValue={existingSettings?.roleArn || ""}
                  placeholder="arn:aws:iam::123456789012:role/StarkeeperAccess"
                  required
                  description="Found in CloudFormation stack outputs as 'RoleArn'"
                />

                <TextInput
                  label="Execution Role ARN (recommended)"
                  name="executionRoleArn"
                  defaultValue={existingSettings?.executionRoleArn || ""}
                  placeholder="arn:aws:iam::123456789012:role/StarkeeperCloudFormationExecution"
                  description="Found in CloudFormation stack outputs as 'ExecutionRoleArn'"
                />

                <TextInput
                  label="Permission Boundary ARN (recommended)"
                  name="permissionBoundaryArn"
                  defaultValue={existingSettings?.permissionBoundaryArn || ""}
                  placeholder="arn:aws:iam::123456789012:policy/StarkeeperPermissionBoundary"
                  description="Found in CloudFormation stack outputs as 'PermissionBoundaryArn'"
                />

                <TextInput
                  label="External ID (required)"
                  name="externalId"
                  defaultValue={templateData?.externalId || existingSettings?.externalId || ""}
                  required
                  description="The external ID from Step 1"
                />

                <TextInput
                  label="AWS Account ID (required)"
                  name="accountId"
                  defaultValue={existingSettings?.accountId || ""}
                  placeholder="123456789012"
                  required
                  description="Your 12-digit AWS account ID"
                />

                <TextInput
                  label="Stack Prefix"
                  name="stackPrefix"
                  defaultValue={templateData?.stackPrefix || existingSettings?.stackPrefix || "app"}
                  required
                  description="The stack prefix from Step 1"
                />

                <Button type="submit" size="md">
                  Connect AWS Account
                </Button>
              </Stack>
            </Form>

            {actionError && (
              <Alert color="red" mt="md">
                {actionError}
              </Alert>
            )}
          </Paper>
        </Stepper.Step>
      </Stepper>
    </Container>
  );
}
