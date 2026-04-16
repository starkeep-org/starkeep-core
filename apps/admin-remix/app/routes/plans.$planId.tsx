import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData, useActionData } from "@remix-run/react";
import { Container, Title, Paper, Table, Badge, Code, Button, Alert, Group, Text, List } from "@mantine/core";

export async function loader({ params }: LoaderFunctionArgs) {
  const planId = params.planId;

  if (!planId) {
    throw new Response("Plan ID is required", { status: 400 });
  }

  try {
    // Get plan metadata from store
    const { planStore } = await import("../lib/plan-store.server.js");
    const storedPlan = planStore.get(planId);

    if (!storedPlan) {
      throw new Response("Plan not found", { status: 404 });
    }

    // Get change set details using CloudFormation API
    const {
      CloudFormationClient,
      DescribeChangeSetCommand,
    } = await import("@aws-sdk/client-cloudformation");

    const cfnClient = new CloudFormationClient({ region: storedPlan.region });
    const response = await cfnClient.send(
      new DescribeChangeSetCommand({
        ChangeSetName: storedPlan.changeSetId,
        StackName: storedPlan.stackName,
      })
    );

    const plan = {
      id: planId,
      status: response.Status === "CREATE_COMPLETE" ? "READY" : response.Status,
      createdAt: storedPlan.createdAt,
      deployment: {
        template: storedPlan.template,
        environment: storedPlan.environment,
        region: storedPlan.region,
        stackName: storedPlan.stackName,
      },
      changes: (response.Changes || []).map((change) => ({
        action: change.ResourceChange?.Action || "Unknown",
        resourceType: change.ResourceChange?.ResourceType || "Unknown",
        logicalResourceId: change.ResourceChange?.LogicalResourceId || "",
        replacement: change.ResourceChange?.Replacement,
      })),
      changeSetId: storedPlan.changeSetId,
    };

    return json({ plan });
  } catch (error: any) {
    console.error("Failed to load plan:", error);
    throw new Response(`Failed to load plan: ${error.message}`, { status: 500 });
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const planId = params.planId;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "approve") {
    if (!planId) {
      return json({ error: "Plan ID is required" }, { status: 400 });
    }

    try {
      // Get plan metadata
      const { planStore } = await import("../lib/plan-store.server.js");
      const storedPlan = planStore.get(planId);

      if (!storedPlan) {
        return json({ error: "Plan not found" }, { status: 404 });
      }

      // Generate CloudFormation Quick Create link to execute the change set
      const region = storedPlan.region;
      const baseUrl = `https://${region}.console.aws.amazon.com/cloudformation/home`;

      // Navigate directly to execute the change set
      const executeUrl = `${baseUrl}?region=${region}#/stacks/changesets/execute?stackId=${encodeURIComponent(storedPlan.stackName)}&changeSetId=${encodeURIComponent(storedPlan.changeSetId)}`;

      return json({
        success: true,
        quickCreateUrl: executeUrl,
        stackName: storedPlan.stackName,
        region: storedPlan.region,
      });
    } catch (error: any) {
      console.error("Failed to approve plan:", error);
      return json(
        { error: `Failed to approve plan: ${error.message}` },
        { status: 500 }
      );
    }
  }

  return json({ error: "Invalid intent" }, { status: 400 });
}

export default function PlanDetails() {
  const { plan } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const getChangeColor = (action: string) => {
    switch (action) {
      case "Add":
        return "green";
      case "Modify":
        return "yellow";
      case "Remove":
        return "red";
      default:
        return "gray";
    }
  };

  const getReplacementWarning = (replacement?: string) => {
    if (replacement === "True") {
      return "⚠️ Resource will be replaced";
    }
    if (replacement === "Conditional") {
      return "⚠️ May require replacement";
    }
    return "";
  };

  return (
    <Container size="xl" py="xl">
      <Title order={1} mb="xl">Deployment Plan</Title>

      <Paper p="xl" mb="xl" withBorder>
        <Title order={2} size="h3" mb="md">Plan Details</Title>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "1rem" }}>
          <div>
            <Text fw={700} span>Plan ID:</Text> <Code>{plan.id}</Code>
          </div>
          <div>
            <Text fw={700} span>Status:</Text> <Badge color="green" ml="xs">{plan.status}</Badge>
          </div>
          <div>
            <Text fw={700} span>Template:</Text> <Text span ml="xs">{plan.deployment.template}</Text>
          </div>
          <div>
            <Text fw={700} span>Environment:</Text> <Text span ml="xs">{plan.deployment.environment}</Text>
          </div>
          <div>
            <Text fw={700} span>Region:</Text> <Text span ml="xs">{plan.deployment.region}</Text>
          </div>
          <div>
            <Text fw={700} span>Stack Name:</Text> <Code>{plan.deployment.stackName}</Code>
          </div>
          <div>
            <Text fw={700} span>Created:</Text> <Text span ml="xs">{new Date(plan.createdAt).toLocaleString()}</Text>
          </div>
        </div>
      </Paper>

      <Title order={2} size="h3" mb="md">Change Set Preview</Title>
      <Table striped highlightOnHover withTableBorder mb="xl">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Action</Table.Th>
            <Table.Th>Resource Type</Table.Th>
            <Table.Th>Logical ID</Table.Th>
            <Table.Th>Notes</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {plan.changes.map((change, idx) => (
            <Table.Tr key={idx}>
              <Table.Td>
                <Badge color={getChangeColor(change.action)}>
                  {change.action}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Code>{change.resourceType}</Code>
              </Table.Td>
              <Table.Td>
                <Code>{change.logicalResourceId}</Code>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="yellow.7">{getReplacementWarning(change.replacement)}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Alert variant="light" color="yellow" title="Summary" mb="xl">
        <List size="sm">
          <List.Item>
            <Text fw={700} span>{plan.changes.filter((c) => c.action === "Add").length}</Text> resources will be created
          </List.Item>
          <List.Item>
            <Text fw={700} span>{plan.changes.filter((c) => c.action === "Modify").length}</Text> resources will be modified
          </List.Item>
          <List.Item>
            <Text fw={700} span>{plan.changes.filter((c) => c.action === "Remove").length}</Text> resources will be removed
          </List.Item>
        </List>
      </Alert>

      {actionData && "error" in actionData && (
        <Alert variant="light" color="red" title="Error" mb="md">
          {actionData.error}
        </Alert>
      )}

      {actionData && "success" in actionData && actionData.success ? (
        <Paper p="xl" withBorder style={{ borderColor: "#37b24d" }} mb="md">
          <Title order={2} size="h4" mb="md">✓ Plan Approved!</Title>
          <Text mb="md">
            Click the button below to open AWS Console and execute the change set:
          </Text>
          <Button
            component="a"
            href={actionData.quickCreateUrl}
            target="_blank"
            rel="noopener noreferrer"
            size="xl"
            color="orange"
            fullWidth
            mb="md"
          >
            🚀 Execute Change Set in AWS Console
          </Button>
          <Alert variant="light" color="blue" title="What happens next">
            <Text size="sm">
              1. AWS Console will open with the change set pre-selected
              <br />
              2. Review the changes one more time
              <br />
              3. Click "Execute change set" to deploy
              <br />
              4. Monitor the deployment progress in CloudFormation
            </Text>
          </Alert>
        </Paper>
      ) : (
        <>
          <Form method="post">
            <input type="hidden" name="intent" value="approve" />
            <Button type="submit" size="lg" color="green" mb="md">
              ✓ Approve &amp; Generate Deploy Link
            </Button>
          </Form>

          <Text size="sm" c="dimmed">
            This will generate a link to execute the CloudFormation change set in AWS Console.
          </Text>
        </>
      )}
    </Container>
  );
}
