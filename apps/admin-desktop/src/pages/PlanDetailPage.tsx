import { useParams, Link, useNavigate } from "react-router-dom";
import {
  Container, Title, Paper, Group, Button, Text, Alert, Loader,
} from "@mantine/core";
import { StatusBadge, StackDetails, ParametersTable } from "@starkeep/admin-ui";
import { useInvoke } from "../hooks/use-invoke";
import { getPlan } from "../lib/api";

interface Plan {
  id: string;
  stack_name: string;
  region: string;
  environment: string | null;
  status: string;
  template_type: string | null;
  change_set_id: string | null;
  parameters: string | null;
  created_at: string;
}

export function PlanDetailPage() {
  const { planId } = useParams<{ planId: string }>();
  const navigate = useNavigate();
  const { data: plan, loading, error } = useInvoke<Plan | null>(() => getPlan(planId ?? ""));

  if (loading) {
    return (
      <Container size="md" py="xl">
        <Group justify="center" py="xl"><Loader /></Group>
      </Container>
    );
  }

  if (error || !plan) {
    return (
      <Container size="md" py="xl">
        <Alert color="red" title="Error">{error || "Plan not found"}</Alert>
        <Button component={Link} to="/deployments" mt="md" variant="subtle">
          Back to Deployments
        </Button>
      </Container>
    );
  }

  const parsedParams = plan.parameters ? JSON.parse(plan.parameters) as Record<string, unknown> : null;

  return (
    <Container size="md">
      <Button component={Link} to="/deployments" variant="subtle" size="sm" mb="md">
        &larr; Back to Deployments
      </Button>

      <Group justify="space-between" mb="lg">
        <Title order={1}>Deployment Plan</Title>
        <StatusBadge status={plan.status} size="lg" />
      </Group>

      <Paper p="xl" withBorder mb="xl">
        <Title order={2} size="h4" mb="md">Stack Details</Title>
        <StackDetails
          stackName={plan.stack_name}
          region={plan.region}
          environment={plan.environment}
          changeSetId={plan.change_set_id}
          createdAt={plan.created_at}
        />
      </Paper>

      {parsedParams && Object.keys(parsedParams).length > 0 && (
        <Paper p="xl" withBorder mb="xl">
          <Title order={2} size="h4" mb="md">Parameters</Title>
          <ParametersTable parameters={parsedParams} />
        </Paper>
      )}

      <Paper p="xl" withBorder>
        <Text c="dimmed" size="sm">
          To execute this deployment, connect to Starkeep Cloud or configure AWS credentials locally.
          The Plan &rarr; Approve &rarr; Deploy workflow will create a CloudFormation change set for review before execution.
        </Text>
      </Paper>
    </Container>
  );
}
