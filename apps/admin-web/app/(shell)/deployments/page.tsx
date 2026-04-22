"use client";

import { useState } from "react";
import {
  Container,
  Title,
  Button,
  Table,
  Group,
  Code,
  Text,
  Badge,
  Loader,
  Alert,
} from "@mantine/core";
import Link from "next/link";
import { StatusBadge, DeleteConfirmModal } from "@starkeep/admin-ui";
import { useInvoke } from "../../../src/hooks/use-invoke";
import { listPlans, deletePlan } from "../../../src/lib/api";

interface PlanWithDeployment {
  id: string;
  stack_name: string;
  region: string;
  environment: string | null;
  status: string;
  template_type: string | null;
  created_at: string;
  latest_deployment: {
    id: string;
    status: string;
    status_reason: string | null;
  } | null;
}

export default function DeploymentsPage() {
  const { data: plans, loading, error, refetch } = useInvoke<PlanWithDeployment[]>(listPlans);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [planToDelete, setPlanToDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDeleteClick = (planId: string) => {
    setPlanToDelete(planId);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!planToDelete) return;
    setDeleting(true);
    try {
      await deletePlan(planToDelete);
      refetch();
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(false);
      setDeleteModalOpen(false);
      setPlanToDelete(null);
    }
  };

  if (loading) {
    return (
      <Container size="xl" py="xl">
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      </Container>
    );
  }

  if (error) {
    return (
      <Container size="xl" py="xl">
        <Alert color="red" title="Error">
          {error}
        </Alert>
      </Container>
    );
  }

  return (
    <Container size="xl">
      <Group justify="space-between" mb="xl">
        <Title order={1}>Deployments</Title>
        <Button component={Link} href="/deployments/new">
          + New Deployment
        </Button>
      </Group>

      {!plans || plans.length === 0 ? (
        <Text c="dimmed">No deployments yet. Create your first deployment to get started.</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Stack Name</Table.Th>
              <Table.Th>Region</Table.Th>
              <Table.Th>Environment</Table.Th>
              <Table.Th>Template</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {plans.map((plan) => {
              const status = plan.latest_deployment?.status || plan.status;
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
                    {plan.template_type && (
                      <Badge variant="light">{plan.template_type}</Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={status} />
                  </Table.Td>
                  <Table.Td>{new Date(plan.created_at).toLocaleString()}</Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      <Button
                        component={Link}
                        href={`/deployments/${plan.id}`}
                        variant="subtle"
                        size="xs"
                      >
                        View
                      </Button>
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
        loading={deleting}
      />
    </Container>
  );
}
