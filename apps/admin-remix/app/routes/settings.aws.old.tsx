import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { Container, Title, Text, TextInput, Button, Alert, Stack, Paper, Code } from "@mantine/core";

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const accountId = formData.get("accountId");
  const defaultRegion = formData.get("defaultRegion");
  const allowedRegions = formData.get("allowedRegions");
  const stackPrefix = formData.get("stackPrefix");

  // Validation
  if (!accountId) {
    return json(
      { error: "AWS account ID is required" },
      { status: 400 }
    );
  }

  if (typeof accountId !== "string" || accountId.length !== 12) {
    return json(
      { error: "AWS account ID must be exactly 12 digits" },
      { status: 400 }
    );
  }

  // TODO: Save AWS deployment settings to database
  // This stores the user's preferences for generating deployment links
  const settingsId = "settings-" + Math.random().toString(36).slice(2);

  const settings = {
    id: settingsId,
    accountId,
    defaultRegion: defaultRegion || "us-east-1",
    allowedRegions: allowedRegions?.toString().split(",").map(r => r.trim()) || [],
    stackPrefix: stackPrefix?.toString() || "app",
    createdAt: new Date().toISOString(),
  };

  // TODO: Store settings in database
  // await db.awsSettings.create(settings);

  return json({
    success: true,
    settings,
  });
}

export default function AwsSettings() {
  const actionData = useActionData<typeof action>();

  if (actionData && "success" in actionData && actionData.success) {
    return (
      <Container size="md" py="xl">
        <Title order={1} mb="lg">AWS Settings Saved</Title>

        <Alert variant="light" color="green" title="Settings Configured" mb="xl">
          <Text>
            Your AWS deployment settings have been saved. You can now create deployments using Quick Create links.
          </Text>
        </Alert>

        <Paper p="xl" withBorder mb="xl">
          <Title order={2} size="h4" mb="md">Your Settings</Title>
          <Stack gap="sm">
            <div>
              <Text size="sm" fw={700}>AWS Account ID:</Text>
              <Code>{actionData.settings.accountId}</Code>
            </div>
            <div>
              <Text size="sm" fw={700}>Default Region:</Text>
              <Code>{actionData.settings.defaultRegion}</Code>
            </div>
            <div>
              <Text size="sm" fw={700}>Stack Prefix:</Text>
              <Code>{actionData.settings.stackPrefix}</Code>
            </div>
            {actionData.settings.allowedRegions.length > 0 && (
              <div>
                <Text size="sm" fw={700}>Allowed Regions:</Text>
                <Code>{actionData.settings.allowedRegions.join(", ")}</Code>
              </div>
            )}
          </Stack>
        </Paper>

        <Button component="a" href="/deployments/new" size="lg" color="blue" fullWidth>
          Create Your First Deployment
        </Button>
      </Container>
    );
  }

  return (
    <Container size="sm" py="xl">
      <Title order={1} mb="md">Configure AWS Settings</Title>
      <Text c="dimmed" mb="xl">
        Set up your AWS deployment preferences. These settings will be used to generate
        CloudFormation Quick Create links for deploying applications in your AWS account.
      </Text>

      {actionData && "error" in actionData && (
        <Alert variant="light" color="red" title="Error" mb="md">
          {actionData.error}
        </Alert>
      )}

      <Form method="post">
        <Stack gap="md">
          <TextInput
            label="AWS Account ID"
            placeholder="123456789012"
            name="accountId"
            required
            withAsterisk
            description="Your AWS account ID (12 digits)"
            pattern="[0-9]{12}"
            styles={{ input: { fontFamily: "monospace" } }}
          />

          <TextInput
            label="Default Region"
            placeholder="us-east-1"
            name="defaultRegion"
            defaultValue="us-east-1"
            description="Default AWS region for deployments"
            styles={{ input: { fontFamily: "monospace" } }}
          />

          <TextInput
            label="Allowed Regions"
            placeholder="us-east-1,us-west-2,eu-west-1"
            name="allowedRegions"
            description="(Optional) Comma-separated list of allowed regions"
            styles={{ input: { fontFamily: "monospace" } }}
          />

          <TextInput
            label="Stack Prefix"
            placeholder="app"
            name="stackPrefix"
            defaultValue="app"
            description="Prefix for all CloudFormation stack names"
            styles={{ input: { fontFamily: "monospace" } }}
          />

          <Button type="submit" size="lg" fullWidth>
            Save AWS Settings
          </Button>
        </Stack>
      </Form>
    </Container>
  );
}
