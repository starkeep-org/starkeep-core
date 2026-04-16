import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { Container, Title, Button, Alert, Text, Paper, Group } from "@mantine/core";
import { requireCustomerId, requireUserId } from "../lib/auth.server";
import { StatusBadge, ChangeSetTable, StackDetails, ParametersTable } from "@starkeep/admin-ui";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const { PlansRepository, AwsSettingsRepository } = await import("@starkeep/admin-db");
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

  // Get AWS settings to initialize provider
  const awsSettingsRepo = new AwsSettingsRepository();
  const settings = await awsSettingsRepo.findByCustomerId(plan.customer_id);

  if (!settings) {
    throw new Response("AWS settings not found", { status: 404 });
  }

  // Get change set details if available
  let changeSetDetails = null;
  if (plan.change_set_id) {
    const awsProvider = new AwsProvider({
      roleArn: settings.role_arn,
      externalId: settings.external_id,
      executionRoleArn: settings.execution_role_arn || undefined,
      permissionBoundaryArn: settings.permission_boundary_arn || undefined,
    });

    changeSetDetails = await awsProvider.getChangeSetDetails({
      connectionId: settings.id,
      changeSetId: plan.change_set_id,
      stackName: plan.stack_name,
      region: plan.region,
    });
  }

  return json({ plan, changeSetDetails });
}

export async function action({ params, request }: ActionFunctionArgs) {
  const { PlansRepository, AwsSettingsRepository, DeploymentsRepository } = await import("@starkeep/admin-db");
  const { AwsProvider } = await import("@starkeep/admin-providers");

  const planId = params.id;
  if (!planId) {
    return json({ error: "Plan ID is required" }, { status: 400 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  const userId = await requireUserId(request);
  const customerId = await requireCustomerId(request);
  const plansRepo = new PlansRepository();
  const plan = await plansRepo.findById(planId);

  if (!plan) {
    return json({ error: "Plan not found" }, { status: 404 });
  }
  if (plan.customer_id !== customerId) {
    return json({ error: "Forbidden" }, { status: 403 });
  }

  if (intent === "approve") {
    try {
      // Get AWS settings
      const awsSettingsRepo = new AwsSettingsRepository();
      const settings = await awsSettingsRepo.findByCustomerId(plan.customer_id);

      if (!settings) {
        return json({ error: "AWS settings not found" }, { status: 404 });
      }

      if (!plan.change_set_id) {
        return json({ error: "No change set found for this plan" }, { status: 400 });
      }

      // Initialize AWS provider
      const awsProvider = new AwsProvider({
        roleArn: settings.role_arn,
        externalId: settings.external_id,
        executionRoleArn: settings.execution_role_arn || undefined,
        permissionBoundaryArn: settings.permission_boundary_arn || undefined,
      });

      // Execute the change set
      const result = await awsProvider.executeChangeSet({
        connectionId: settings.id,
        changeSetId: plan.change_set_id,
        stackName: plan.stack_name,
        region: plan.region,
      });

      // Create deployment record
      const deploymentsRepo = new DeploymentsRepository();
      const deployment = await deploymentsRepo.create({
        plan_id: plan.id,
        customer_id: plan.customer_id,
        stack_name: plan.stack_name,
        region: plan.region,
        status: "IN_PROGRESS",
      });

      // Update plan status
      await plansRepo.update(plan.id, {
        status: "EXECUTING",
        approved_by: customerId,
        approved_at: new Date(),
      });

      return redirect(`/deployments/${plan.id}/status`);
    } catch (error) {
      console.error("Failed to execute change set:", error);
      return json(
        { error: error instanceof Error ? error.message : "Failed to execute change set" },
        { status: 500 }
      );
    }
  }

  return json({ error: "Invalid intent" }, { status: 400 });
}

export default function DeploymentPlan() {
  const { plan, changeSetDetails } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const statusColor = plan.status === "READY" ? "green" : plan.status === "FAILED" ? "red" : "blue";

  return (
    <Container size="md" py="xl">
      <Button
        component={Link}
        to="/deployments"
        variant="subtle"
        size="sm"
        mb="md"
      >
        ← Back to Deployments
      </Button>

      <Group justify="space-between" mb="lg">
        <Title order={1}>Deployment Plan</Title>
        <StatusBadge status={plan.status} size="lg" />
      </Group>

      {actionData && "error" in actionData && (
        <Alert variant="light" color="red" title="Error" mb="md">
          {actionData.error}
        </Alert>
      )}

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

      {changeSetDetails && changeSetDetails.changes && changeSetDetails.changes.length > 0 && (
        <Paper p="xl" withBorder mb="xl">
          <Title order={2} size="h4" mb="md">Proposed Changes</Title>
          <Text c="dimmed" size="sm" mb="md">
            The following resources will be created or modified when this plan is executed:
          </Text>
          <ChangeSetTable changes={changeSetDetails.changes} />
        </Paper>
      )}

      {plan.parameters && Object.keys(plan.parameters).length > 0 && (
        <Paper p="xl" withBorder mb="xl">
          <Title order={2} size="h4" mb="md">Parameters</Title>
          <ParametersTable parameters={plan.parameters as Record<string, unknown>} />
        </Paper>
      )}

      {plan.status === "READY" && (
        <Paper p="xl" withBorder style={{ borderColor: "#fd7e14" }}>
          <Title order={2} size="h4" mb="md">Ready to Deploy</Title>
          <Text mb="md">
            Review the proposed changes above. When you're ready, approve this plan to execute the deployment.
          </Text>
          <Form method="post">
            <input type="hidden" name="intent" value="approve" />
            <Button type="submit" size="lg" color="orange" fullWidth>
              Approve & Execute Deployment
            </Button>
          </Form>
        </Paper>
      )}

      {plan.status === "EXECUTING" && (
        <Alert variant="light" color="blue" title="Deployment in Progress">
          This deployment is currently executing. Check the status page for real-time updates.
        </Alert>
      )}

      {plan.status === "FAILED" && (
        <Alert variant="light" color="red" title="Deployment Failed">
          This deployment failed. Check the logs for more information.
        </Alert>
      )}
    </Container>
  );
}
