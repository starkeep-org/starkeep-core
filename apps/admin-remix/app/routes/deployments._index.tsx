import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useLoaderData, useFetcher } from "@remix-run/react";
import { Container, Title, Button, Table, Group, Code, Text, Badge } from "@mantine/core";
import { useState } from "react";
import { requireCustomerId } from "../lib/auth.server";
import { StatusBadge, DeleteConfirmModal } from "@starkeep/admin-ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const { PlansRepository, DeploymentsRepository } = await import("@starkeep/admin-db");

  const customerId = await requireCustomerId(request);

  const plansRepo = new PlansRepository();
  const deploymentsRepo = new DeploymentsRepository();

  const plans = await plansRepo.findByCustomerId(customerId);

  // Get latest deployment for each plan
  const plansWithDeployments = await Promise.all(
    plans.map(async (plan) => {
      const deployments = await deploymentsRepo.findByPlanId(plan.id);
      const latestDeployment = deployments[0] || null;
      return {
        ...plan,
        latestDeployment,
      };
    })
  );

  return json({ plans: plansWithDeployments });
}

export async function action({ request }: ActionFunctionArgs) {
  const { PlansRepository } = await import("@starkeep/admin-db");
  const formData = await request.formData();
  const planId = formData.get("planId") as string;

  if (request.method === "DELETE") {
    const customerId = await requireCustomerId(request);
    const plansRepo = new PlansRepository();
    const plan = await plansRepo.findById(planId);
    if (!plan || plan.customer_id !== customerId) {
      return redirect("/deployments");
    }
    await plansRepo.delete(planId);
    return redirect("/deployments");
  }

  return json({ error: "Invalid action" }, { status: 400 });
}

export default function DeploymentsIndex() {
  const { plans } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [planToDelete, setPlanToDelete] = useState<string | null>(null);

  const handleDeleteClick = (planId: string) => {
    setPlanToDelete(planId);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (planToDelete) {
      fetcher.submit(
        { planId: planToDelete },
        { method: "delete" }
      );
      setDeleteModalOpen(false);
      setPlanToDelete(null);
    }
  };

  return (
    <Container size="xl" py="xl">
      <Group justify="space-between" mb="xl">
        <Title order={1}>Deployments</Title>
        <Group>
          <Button
            component={Link}
            to="/settings/aws"
            variant="subtle"
          >
            AWS Settings
          </Button>
          <Button
            component={Link}
            to="/deployments/new"
            size="md"
          >
            + New Deployment
          </Button>
        </Group>
      </Group>

      {plans.length === 0 ? (
        <Text c="dimmed">No deployments yet. Create your first deployment to get started.</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Stack Name</Table.Th>
              <Table.Th>Region</Table.Th>
              <Table.Th>Environment</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {plans.map((plan) => {
              const status = plan.latestDeployment?.status || plan.status;
              const isDeployed = !!plan.latestDeployment;

              return (
                <Table.Tr key={plan.id}>
                  <Table.Td>
                    <Code>{plan.stack_name}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Code>{plan.region}</Code>
                  </Table.Td>
                  <Table.Td>
                    {plan.environment && <Badge>{plan.environment}</Badge>}
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={status} />
                  </Table.Td>
                  <Table.Td>{new Date(plan.created_at).toLocaleString()}</Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      <Button
                        component={Link}
                        to={`/deployments/${plan.id}`}
                        variant="subtle"
                        size="xs"
                      >
                        View Plan
                      </Button>
                      {isDeployed && (
                        <Button
                          component={Link}
                          to={`/deployments/${plan.id}/status`}
                          variant="light"
                          size="xs"
                          color={status === "IN_PROGRESS" ? "blue" : status === "FAILED" ? "red" : "green"}
                        >
                          View Status
                        </Button>
                      )}
                      <Button
                        onClick={() => handleDeleteClick(plan.id)}
                        variant="subtle"
                        size="xs"
                        color="red"
                      >
                        Delete
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}

      <DeleteConfirmModal
        opened={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={handleDeleteConfirm}
        loading={fetcher.state === "submitting"}
      />
    </Container>
  );
}
