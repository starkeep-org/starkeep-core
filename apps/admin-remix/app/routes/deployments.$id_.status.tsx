import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useLoaderData, useRevalidator, useFetcher, useNavigate } from "@remix-run/react";
import { Container, Title, Button, Alert, Stack, Text, Paper, Group, Loader } from "@mantine/core";
import { useEffect, useState } from "react";
import { requireCustomerId } from "../lib/auth.server";
import type { DeploymentEvent, StackOutput } from "@starkeep/admin-providers";
import { StatusBadge, EventTimeline, StackOutputs, StackDetails, DeleteConfirmModal } from "@starkeep/admin-ui";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const { PlansRepository, DeploymentsRepository, AwsSettingsRepository } = await import("@starkeep/admin-db");
  const { AwsProvider } = await import("@starkeep/admin-providers");

  const planId = params.id;
  if (!planId) {
    throw new Response("Plan ID is required", { status: 400 });
  }

  const customerId = await requireCustomerId(request);
  const plansRepo = new PlansRepository();
  const plan = await plansRepo.findById(planId);

  if (!plan) {
    throw new Response("Plan not found", { status: 404 });
  }
  if (plan.customer_id !== customerId) {
    throw new Response("Forbidden", { status: 403 });
  }

  // Get deployment records
  const deploymentsRepo = new DeploymentsRepository();
  const deployments = await deploymentsRepo.findByPlanId(planId);
  const latestDeployment = deployments[0] || null;

  // Get real-time stack events, status, and outputs if deployment exists
  let events: DeploymentEvent[] = [];
  let outputs: StackOutput[] = [];
  let updatedDeployment = latestDeployment;

  if (latestDeployment) {
    const awsSettingsRepo = new AwsSettingsRepository();
    const settings = await awsSettingsRepo.findByCustomerId(plan.customer_id);

    if (settings) {
      const awsProvider = new AwsProvider({
        roleArn: settings.role_arn,
        externalId: settings.external_id,
        executionRoleArn: settings.execution_role_arn || undefined,
        permissionBoundaryArn: settings.permission_boundary_arn || undefined,
      });

      try {
        // Get stack events
        events = await awsProvider.getDeploymentEvents({
          connectionId: settings.id,
          stackName: plan.stack_name,
          region: plan.region,
          limit: 50,
        });

        // Get stack outputs if deployment succeeded
        if (latestDeployment.status === "COMPLETED" || latestDeployment.status === "IN_PROGRESS") {
          outputs = await awsProvider.getStackOutputs({
            stackName: plan.stack_name,
            region: plan.region,
          });
        }

        // Check stack status and update deployment if it's in a terminal state
        if (latestDeployment.status === "IN_PROGRESS") {
          const stackStatus = await awsProvider.getStackStatus({
            stackName: plan.stack_name,
            region: plan.region,
          });

          // Map CloudFormation stack status to deployment status
          let newStatus = latestDeployment.status;
          const statusReason = stackStatus.statusReason ?? null;
          if (stackStatus.status.includes("COMPLETE") && !stackStatus.status.includes("ROLLBACK")) {
            newStatus = "COMPLETED";
          } else if (stackStatus.status.includes("FAILED") || stackStatus.status.includes("ROLLBACK")) {
            newStatus = "FAILED";
          }

          // Update deployment record if status changed
          if (newStatus !== latestDeployment.status) {
            await deploymentsRepo.update(latestDeployment.id, {
              status: newStatus,
              status_reason: statusReason,
              completed_at: new Date(),
            });

            updatedDeployment = {
              ...latestDeployment,
              status: newStatus,
              status_reason: statusReason,
              completed_at: new Date(),
            };
          }
        }
      } catch (error) {
        console.error("Failed to fetch deployment status:", error);
      }
    }
  }

  return json({ plan, deployment: updatedDeployment, events, outputs });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { PlansRepository } = await import("@starkeep/admin-db");
  const formData = await request.formData();

  if (request.method === "DELETE") {
    const planId = params.id;
    if (planId) {
      const customerId = await requireCustomerId(request);
      const plansRepo = new PlansRepository();
      const plan = await plansRepo.findById(planId);
      if (!plan || plan.customer_id !== customerId) {
        return redirect("/deployments");
      }
      await plansRepo.delete(planId);
    }
    return redirect("/deployments");
  }

  return json({ error: "Invalid action" }, { status: 400 });
}

export default function DeploymentStatus() {
  const { plan, deployment, events, outputs } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  // Auto-refresh every 5 seconds if deployment is in progress
  useEffect(() => {
    if (deployment?.status === "IN_PROGRESS") {
      const interval = setInterval(() => {
        revalidator.revalidate();
      }, 5000);

      return () => clearInterval(interval);
    }
  }, [deployment?.status, revalidator]);

  const statusColor =
    deployment?.status === "COMPLETED" ? "green" :
    deployment?.status === "FAILED" ? "red" :
    "blue";

  const isInProgress = deployment?.status === "IN_PROGRESS";
  const isFailed = deployment?.status === "FAILED";

  const handleDeleteConfirm = () => {
    fetcher.submit({}, { method: "delete" });
    setDeleteModalOpen(false);
  };

  return (
    <Container size="md" py="xl">
      <Button
        component={Link}
        to={`/deployments/${plan.id}`}
        variant="subtle"
        size="sm"
        mb="md"
      >
        ← Back to Plan
      </Button>

      <Group justify="space-between" mb="lg">
        <Title order={1}>Deployment Status</Title>
        <StatusBadge status={deployment?.status || "NOT_STARTED"} size="lg" />
      </Group>

      {isInProgress && (
        <Alert variant="light" color="blue" mb="xl" icon={<Loader size="sm" />}>
          Deployment in progress. This page will auto-refresh every 5 seconds.
        </Alert>
      )}

      {deployment?.status === "COMPLETED" && (
        <Alert variant="light" color="green" mb="xl" title="Deployment Completed">
          Your stack has been successfully deployed!
        </Alert>
      )}

      {outputs && outputs.length > 0 && deployment?.status === "COMPLETED" && (
        <Paper p="xl" withBorder mb="xl">
          <Title order={2} size="h4" mb="md">Application Outputs</Title>
          <StackOutputs outputs={outputs} />
        </Paper>
      )}

      {isFailed && (
        <Alert variant="light" color="red" mb="xl" title="Deployment Failed">
          <Text mb="xs">
            {deployment.status_reason || "The deployment failed and was automatically rolled back by CloudFormation."}
          </Text>
          <Text size="sm" c="dimmed">
            Check the events below to see which resource failed and why. Common issues include AWS account limits,
            missing permissions, or resource conflicts.
          </Text>
        </Alert>
      )}

      <Paper p="xl" withBorder mb="xl">
        <Title order={2} size="h4" mb="md">Stack Details</Title>
        <StackDetails
          stackName={plan.stack_name}
          region={plan.region}
          environment={plan.environment}
          stackId={deployment?.stack_id}
          startedAt={deployment?.started_at}
          completedAt={deployment?.completed_at}
        />
      </Paper>

      {events && events.length > 0 && (
        <Paper p="xl" withBorder>
          <Title order={2} size="h4" mb="md">Deployment Events</Title>
          <Text c="dimmed" size="sm" mb="md">
            Real-time events from CloudFormation stack deployment:
          </Text>
          <EventTimeline events={events} />
        </Paper>
      )}

      {!deployment && (
        <Alert variant="light" color="yellow" title="No Deployment Found">
          This plan has not been executed yet. Return to the plan page to approve and execute it.
        </Alert>
      )}

      <Group justify="center" mt="xl" gap="md">
        <Button component={Link} to="/deployments" variant="outline">
          Back to All Deployments
        </Button>
        <Button
          color="red"
          variant="subtle"
          onClick={() => setDeleteModalOpen(true)}
        >
          Delete Deployment
        </Button>
      </Group>

      <DeleteConfirmModal
        opened={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={handleDeleteConfirm}
        loading={fetcher.state === "submitting"}
      />
    </Container>
  );
}
