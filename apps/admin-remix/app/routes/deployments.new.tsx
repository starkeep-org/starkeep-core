import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { Container, Title, Button, Select, Alert, Stack, Text, TextInput, PasswordInput } from "@mantine/core";
import { requireCustomerId } from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { AwsSettingsRepository } = await import("@starkeep/admin-db");
  const { getAvailableAppTypes } = await import("@starkeep/admin-core");

  const customerId = await requireCustomerId(request);

  const awsSettingsRepo = new AwsSettingsRepository();

  // Get available app types from template generator
  const availableTemplates = getAvailableAppTypes();

  // Fetch AWS settings for customer
  const settings = await awsSettingsRepo.findByCustomerId(customerId);
  const awsSettings = settings ? {
    accountId: settings.account_id,
    defaultRegion: settings.default_region,
    stackPrefix: settings.stack_prefix,
  } : {
    accountId: "123456789012",
    defaultRegion: "us-east-1",
    stackPrefix: "app",
  };

  return json({ availableTemplates, awsSettings });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();

  const appType = formData.get("template");
  const environment = formData.get("environment");
  const region = formData.get("region");

  if (!appType || !environment || !region) {
    return json(
      { error: "All fields are required" },
      { status: 400 }
    );
  }

  // Collect template-specific parameters (prefixed with "param_")
  const extraParams: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("param_") && typeof value === "string" && value) {
      extraParams[key.replace("param_", "")] = value;
    }
  }

  const { TemplatesRepository, PlansRepository, AwsSettingsRepository, uploadTemplate } = await import("@starkeep/admin-db");
  const { generateTemplate } = await import("@starkeep/admin-core");
  const { AwsProvider } = await import("@starkeep/admin-providers");

  const customerId = await requireCustomerId(request);

  const artifactsBucket = process.env.ARTIFACTS_BUCKET;
  if (!artifactsBucket) {
    return json(
      { error: "ARTIFACTS_BUCKET not configured" },
      { status: 500 }
    );
  }

  try {
    // Get AWS settings for customer
    const awsSettingsRepo = new AwsSettingsRepository();
    const settings = await awsSettingsRepo.findByCustomerId(customerId);

    if (!settings) {
      return json(
        { error: "AWS account not connected. Please connect your AWS account first." },
        { status: 400 }
      );
    }

    // Generate CloudFormation template based on app type
    const templateContent = generateTemplate({
      appType: appType.toString(),
      params: {
        environment: environment.toString(),
      },
    });

    // Generate unique template name with timestamp
    const timestamp = Date.now();
    const templateName = `${appType}-${environment}-${timestamp}`;

    // Upload template to S3 in customer-specific location
    const uploadResult = await uploadTemplate({
      customerId,
      templateName,
      templateContent,
      bucketName: artifactsBucket,
      region: region.toString(),
    });

    // Store template metadata in database
    const templatesRepo = new TemplatesRepository();
    const template = await templatesRepo.create({
      customer_id: customerId,
      name: templateName,
      description: `${appType} deployment for ${environment}`,
      s3_bucket: uploadResult.bucket,
      s3_key: uploadResult.key,
      version: "1.0.0",
    });

    // Generate stack name
    const stackName = `${settings.stack_prefix}-${appType}-${environment}`;

    // Only pass PermissionBoundaryArn if the template defines that parameter
    const cfnParams: Record<string, string> = {
      Environment: environment.toString(),
      ...(templateContent.includes('PermissionBoundaryArn:') ? { PermissionBoundaryArn: settings.permission_boundary_arn || '' } : {}),
      ...extraParams,
    };

    // Create initial plan record
    const plansRepo = new PlansRepository();
    const plan = await plansRepo.create({
      customer_id: customerId,
      template_id: template.id,
      stack_name: stackName,
      region: region.toString(),
      environment: environment.toString(),
      parameters: cfnParams,
      created_by: customerId,
    });

    // Initialize AWS provider with customer's cross-account role
    const awsProvider = new AwsProvider({
      roleArn: settings.role_arn,
      externalId: settings.external_id,
      executionRoleArn: settings.execution_role_arn || undefined,
      permissionBoundaryArn: settings.permission_boundary_arn || undefined,
    });

    // Create CloudFormation change set
    const changeSetResult = await awsProvider.planDeployment({
      connectionId: settings.id,
      stackName,
      region: region.toString(),
      templateUrl: uploadResult.url,
      parameters: cfnParams,
    });

    // Update plan with change set details
    await plansRepo.update(plan.id, {
      change_set_id: changeSetResult.changeSetId,
      change_set_arn: changeSetResult.changeSetArn,
      status: changeSetResult.status,
    });

    // Redirect to plan review page
    return redirect(`/deployments/${plan.id}`);
  } catch (error) {
    console.error("Failed to create deployment:", error);
    return json(
      { error: error instanceof Error ? error.message : "Failed to create deployment" },
      { status: 500 }
    );
  }
}

export default function NewDeployment() {
  const { availableTemplates, awsSettings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);

  const isSubmitting = navigation.state === "submitting";

  const selectedTpl = availableTemplates.find((t) => t.id === selectedTemplate);
  const templateParams = (selectedTpl as any)?.parameters as
    | { name: string; label: string; description?: string; required?: boolean; secret?: boolean; defaultValue?: string; options?: string[] }[]
    | undefined;

  return (
    <Container size="sm" py="xl">
      <Button
        component={Link}
        to="/deployments"
        variant="subtle"
        size="sm"
        mb="md"
      >
        ← Back to Deployments
      </Button>

      <Title order={1} mb="md">Create Deployment</Title>
      <Text c="dimmed" mb="xl">
        Select a template and environment to deploy. No AWS credentials needed - you'll deploy directly in AWS Console.
      </Text>

      {actionData && "error" in actionData && (
        <Alert variant="light" color="red" title="Error" mb="md">
          {actionData.error}
        </Alert>
      )}

      <Form method="post">
        <Stack gap="md">
          <Select
            label="Template"
            placeholder="Select a template..."
            name="template"
            required
            withAsterisk
            value={selectedTemplate}
            onChange={setSelectedTemplate}
            data={availableTemplates.map((tpl) => ({
              value: tpl.id,
              label: `${tpl.name} - ${tpl.description}`,
            }))}
            description="Select the type of application you want to deploy"
          />

          <Select
            label="Environment"
            placeholder="Select environment..."
            name="environment"
            required
            withAsterisk
            data={[
              { value: "dev", label: "Development" },
              { value: "staging", label: "Staging" },
              { value: "prod", label: "Production" },
            ]}
          />

          <Select
            label="AWS Region"
            placeholder="Select region..."
            name="region"
            required
            withAsterisk
            defaultValue={awsSettings.defaultRegion}
            data={[
              { value: "us-east-1", label: "us-east-1 (N. Virginia)" },
              { value: "us-east-2", label: "us-east-2 (Ohio)" },
              { value: "us-west-1", label: "us-west-1 (N. California)" },
              { value: "us-west-2", label: "us-west-2 (Oregon)" },
              { value: "ca-central-1", label: "ca-central-1 (Canada)" },
              { value: "eu-west-1", label: "eu-west-1 (Ireland)" },
              { value: "eu-west-2", label: "eu-west-2 (London)" },
              { value: "eu-central-1", label: "eu-central-1 (Frankfurt)" },
              { value: "eu-north-1", label: "eu-north-1 (Stockholm)" },
              { value: "ap-southeast-1", label: "ap-southeast-1 (Singapore)" },
              { value: "ap-southeast-2", label: "ap-southeast-2 (Sydney)" },
              { value: "ap-northeast-1", label: "ap-northeast-1 (Tokyo)" },
              { value: "ap-northeast-2", label: "ap-northeast-2 (Seoul)" },
              { value: "ap-south-1", label: "ap-south-1 (Mumbai)" },
              { value: "sa-east-1", label: "sa-east-1 (São Paulo)" },
            ]}
          />

          {templateParams?.map((param) =>
            param.secret ? (
              <PasswordInput
                key={param.name}
                label={param.label}
                name={`param_${param.name}`}
                description={param.description}
                required={param.required}
                withAsterisk={param.required}
                defaultValue={param.defaultValue}
              />
            ) : param.options ? (
              <Select
                key={param.name}
                label={param.label}
                name={`param_${param.name}`}
                description={param.description}
                required={param.required}
                withAsterisk={param.required}
                defaultValue={param.defaultValue}
                data={param.options}
              />
            ) : (
              <TextInput
                key={param.name}
                label={param.label}
                name={`param_${param.name}`}
                description={param.description}
                required={param.required}
                withAsterisk={param.required}
                defaultValue={param.defaultValue}
              />
            )
          )}

          <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
            {isSubmitting ? "Creating Deployment..." : "Generate Plan"}
          </Button>
        </Stack>
      </Form>
    </Container>
  );
}
