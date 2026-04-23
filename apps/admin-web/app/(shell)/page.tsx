"use client";

import {
  Container,
  Title,
  Text,
  Paper,
  Stack,
  Group,
  SimpleGrid,
  Badge,
  Code,
  Loader,
  Alert,
} from "@mantine/core";
import Link from "next/link";
import { StatusBadge } from "@starkeep/admin-ui";
import { useInvoke } from "../../src/hooks/use-invoke";
import { listPlans } from "../../src/lib/api";
import { useState, useEffect } from "react";

interface PlanWithDeployment {
  id: string;
  stack_name: string;
  status: string;
  created_at: string;
  latest_deployment: { status: string } | null;
}

interface DataServerTypes {
  types: { record_type: string; count: number }[];
  total: number;
}

function useDataServerStats() {
  const [data, setData] = useState<DataServerTypes | null>(null);
  useEffect(() => {
    fetch("http://127.0.0.1:9820/data/types")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, []);
  return data;
}

export default function DashboardPage() {
  const { data: plans, loading } = useInvoke<PlanWithDeployment[]>(listPlans);
  const dataStats = useDataServerStats();

  if (loading) {
    return (
      <Container size="lg">
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      </Container>
    );
  }

  const deploymentCount = plans?.length ?? 0;
  const recentPlans = (plans ?? []).slice(0, 5);

  return (
    <Container size="lg">
      <Title order={1} mb="xs">
        Dashboard
      </Title>
      <Text c="dimmed" mb="xl">
        Starkeep Admin
      </Text>

      <SimpleGrid cols={{ base: 2, sm: 4 }} mb="xl">
        <StatCard label="Deployments" value={deploymentCount} />
        <StatCard label="Data Types" value={dataStats?.types.length ?? 0} />
        <StatCard label="Records" value={dataStats?.total ?? 0} />
        <StatCard
          label="Data Server"
          value={dataStats ? "Online" : "Offline"}
          color={dataStats ? "green" : "red"}
        />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Paper p="lg" withBorder>
          <Title order={3} size="h4" mb="md">
            Recent Deployments
          </Title>
          {recentPlans.length === 0 ? (
            <Text c="dimmed" size="sm">
              No deployments yet
            </Text>
          ) : (
            <Stack gap="xs">
              {recentPlans.map((p) => (
                <Group key={p.id} justify="space-between">
                  <Code fz="xs">{p.stack_name}</Code>
                  <StatusBadge status={p.latest_deployment?.status || p.status} size="sm" />
                </Group>
              ))}
            </Stack>
          )}
        </Paper>

        <Paper p="lg" withBorder>
          <Title order={3} size="h4" mb="md">
            Data Store
          </Title>
          {!dataStats ? (
            <Alert color="yellow" title="Data server offline">
              Start it: cd ~/starkeep-protocol && pnpm --filter @starkeep/data-server start
            </Alert>
          ) : dataStats.types.length === 0 ? (
            <Text c="dimmed" size="sm">
              No data records yet
            </Text>
          ) : (
            <Stack gap="xs">
              {dataStats.types.map((t) => (
                <Group key={t.record_type} justify="space-between">
                  <Code fz="xs">{t.record_type}</Code>
                  <Badge variant="light">{t.count}</Badge>
                </Group>
              ))}
            </Stack>
          )}
        </Paper>
      </SimpleGrid>
    </Container>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color?: string;
}) {
  return (
    <Paper p="md" withBorder>
      <Text size="xl" fw={700} c={color}>
        {value}
      </Text>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
    </Paper>
  );
}
