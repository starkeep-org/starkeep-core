import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Container, Title, Paper, Table, Badge, Code, Alert, Group, Text } from "@mantine/core";

export async function loader({ params }: LoaderFunctionArgs) {
  const deploymentId = params.deploymentId;

  // TODO: Fetch deployment status and events from API
  // GET /deployments/:deploymentId/events
  const deployment = {
    id: deploymentId,
    status: "DEPLOYING",
    stackName: "web-app-prod",
    region: "us-east-1",
    startedAt: new Date().toISOString(),
    events: [
      {
        timestamp: new Date(Date.now() - 120000).toISOString(),
        resourceType: "AWS::CloudFormation::Stack",
        logicalResourceId: "web-app-prod",
        resourceStatus: "CREATE_IN_PROGRESS",
        resourceStatusReason: "User Initiated",
      },
      {
        timestamp: new Date(Date.now() - 90000).toISOString(),
        resourceType: "AWS::S3::Bucket",
        logicalResourceId: "WebsiteBucket",
        resourceStatus: "CREATE_IN_PROGRESS",
        resourceStatusReason: undefined,
      },
      {
        timestamp: new Date(Date.now() - 60000).toISOString(),
        resourceType: "AWS::S3::Bucket",
        logicalResourceId: "WebsiteBucket",
        resourceStatus: "CREATE_COMPLETE",
        resourceStatusReason: undefined,
      },
      {
        timestamp: new Date(Date.now() - 45000).toISOString(),
        resourceType: "AWS::Lambda::Function",
        logicalResourceId: "ApiFunction",
        resourceStatus: "CREATE_IN_PROGRESS",
        resourceStatusReason: undefined,
      },
      {
        timestamp: new Date(Date.now() - 30000).toISOString(),
        resourceType: "AWS::Lambda::Function",
        logicalResourceId: "ApiFunction",
        resourceStatus: "CREATE_COMPLETE",
        resourceStatusReason: undefined,
      },
      {
        timestamp: new Date(Date.now() - 15000).toISOString(),
        resourceType: "AWS::DynamoDB::Table",
        logicalResourceId: "DataTable",
        resourceStatus: "CREATE_IN_PROGRESS",
        resourceStatusReason: undefined,
      },
    ],
  };

  return json({ deployment });
}

export default function DeploymentStatus() {
  const { deployment } = useLoaderData<typeof loader>();

  const getStatusColor = (status: string) => {
    if (status.includes("COMPLETE")) return "green";
    if (status.includes("IN_PROGRESS")) return "blue";
    if (status.includes("FAILED") || status.includes("ROLLBACK")) return "red";
    return "gray";
  };

  const getStatusIcon = (status: string) => {
    if (status.includes("COMPLETE")) return "✓";
    if (status.includes("IN_PROGRESS")) return "⟳";
    if (status.includes("FAILED")) return "✗";
    return "•";
  };

  return (
    <Container size="xl" py="xl">
      <Title order={1} mb="xl">Deployment Status</Title>

      <Paper p="xl" mb="xl" withBorder style={{ borderColor: "#228be6", borderWidth: 2 }}>
        <Group gap="md" mb="sm">
          <Text size="2rem">⟳</Text>
          <div>
            <Title order={2} size="h3" mb={4}>Deploying...</Title>
            <Text c="blue">
              Stack: <Code>{deployment.stackName}</Code> in {deployment.region}
            </Text>
          </div>
        </Group>
      </Paper>

      <Title order={2} size="h3" mb="md">Stack Events</Title>
      <Table striped highlightOnHover withTableBorder mb="xl">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Time</Table.Th>
            <Table.Th>Resource Type</Table.Th>
            <Table.Th>Logical ID</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Reason</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {deployment.events.map((event, idx) => (
            <Table.Tr key={idx}>
              <Table.Td>
                <Text size="sm">{new Date(event.timestamp).toLocaleTimeString()}</Text>
              </Table.Td>
              <Table.Td>
                <Code>{event.resourceType}</Code>
              </Table.Td>
              <Table.Td>
                <Code>{event.logicalResourceId}</Code>
              </Table.Td>
              <Table.Td>
                <Badge
                  color={getStatusColor(event.resourceStatus)}
                  leftSection={getStatusIcon(event.resourceStatus)}
                >
                  {event.resourceStatus}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">{event.resourceStatusReason || "-"}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Alert variant="light" color="blue" title="Audit Trail">
        <Text size="sm">
          This page auto-refreshes every 5 seconds. You can also check CloudTrail in your AWS account
          for detailed audit logs using role session name:{" "}
          <Code>customer/{"{customerId}"}/plan/{"{planId}"}/actor/{"{userId}"}</Code>
        </Text>
      </Alert>
    </Container>
  );
}
