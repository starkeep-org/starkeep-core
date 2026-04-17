import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import {
  Container, Title, Text, Paper, Stack, Button, Group,
  SimpleGrid, Badge, Code,
} from "@mantine/core";
import { requireCustomerId } from "../lib/auth.server";
import { StatusBadge } from "@starkeep/admin-ui";

export const meta: MetaFunction = () => {
  return [
    { title: "Starkeep Admin" },
    { name: "description", content: "Control plane for the Starkeep data protocol" },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const {
    PlansRepository, DeploymentsRepository, AppRegistryRepository,
    TypeRegistryRepository, AccessPoliciesRepository, InfraCatalogRepository,
  } = await import("@starkeep/admin-db");

  const customerId = await requireCustomerId(request);

  const [plans, apps, types, policies, infra] = await Promise.all([
    new PlansRepository().findByCustomerId(customerId),
    new AppRegistryRepository().findAll(),
    new TypeRegistryRepository().findAll(),
    new AccessPoliciesRepository().findAll(),
    new InfraCatalogRepository().findAll(),
  ]);

  // Get latest deployment for each of the 5 most recent plans
  const deploymentsRepo = new DeploymentsRepository();
  const recentPlans = plans.slice(0, 5);
  const recentWithStatus = await Promise.all(
    recentPlans.map(async (plan) => {
      const deployments = await deploymentsRepo.findByPlanId(plan.id);
      return {
        id: plan.id,
        stack_name: plan.stack_name,
        status: deployments[0]?.status || plan.status,
        created_at: plan.created_at,
      };
    }),
  );

  return json({
    stats: {
      deployments: plans.length,
      apps: apps.length,
      types: types.length,
      policies: policies.length,
      infra: infra.length,
    },
    recentDeployments: recentWithStatus,
    activeApps: apps.filter((a) => a.status === "active").slice(0, 5),
  });
}

export default function Index() {
  const { stats, recentDeployments, activeApps } = useLoaderData<typeof loader>();

  return (
    <Container size="lg" py="xl">
      <Title order={1} mb="xs">Starkeep Admin</Title>
      <Text c="dimmed" mb="xl">Control plane for the Starkeep data protocol</Text>

      <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} mb="xl">
        <StatCard label="Deployments" value={stats.deployments} href="/deployments" />
        <StatCard label="Apps" value={stats.apps} href="/apps" />
        <StatCard label="Types" value={stats.types} href="/types" />
        <StatCard label="Policies" value={stats.policies} href="/permissions" />
        <StatCard label="Resources" value={stats.infra} href="/infrastructure" />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, md: 2 }} mb="xl">
        <Paper p="lg" withBorder>
          <Group justify="space-between" mb="md">
            <Title order={3} size="h4">Recent Deployments</Title>
            <Button component={Link} to="/deployments" variant="subtle" size="xs">
              View all
            </Button>
          </Group>
          {recentDeployments.length === 0 ? (
            <Text c="dimmed" size="sm">No deployments yet</Text>
          ) : (
            <Stack gap="xs">
              {recentDeployments.map((d) => (
                <Group key={d.id} justify="space-between">
                  <Group gap="xs">
                    <Code fz="xs">{d.stack_name}</Code>
                  </Group>
                  <StatusBadge status={d.status} size="sm" />
                </Group>
              ))}
            </Stack>
          )}
        </Paper>

        <Paper p="lg" withBorder>
          <Group justify="space-between" mb="md">
            <Title order={3} size="h4">Installed Apps</Title>
            <Button component={Link} to="/apps" variant="subtle" size="xs">
              View all
            </Button>
          </Group>
          {activeApps.length === 0 ? (
            <Stack gap="sm">
              <Text c="dimmed" size="sm">No apps installed</Text>
              <Button component={Link} to="/apps/install" variant="light" size="sm">
                Install your first app
              </Button>
            </Stack>
          ) : (
            <Stack gap="xs">
              {activeApps.map((app) => (
                <Group key={app.id} justify="space-between">
                  <Group gap="xs">
                    <Text size="sm" fw={500}>{app.name}</Text>
                    <Badge size="xs" variant="light">{app.tier}</Badge>
                  </Group>
                  <Code fz="xs">{app.version}</Code>
                </Group>
              ))}
            </Stack>
          )}
        </Paper>
      </SimpleGrid>

      <Paper p="lg" withBorder>
        <Title order={3} size="h4" mb="sm">Quick Actions</Title>
        <Group>
          <Button component={Link} to="/deployments/new" variant="light">
            New Deployment
          </Button>
          <Button component={Link} to="/apps/install" variant="light">
            Install App
          </Button>
          <Button component={Link} to="/settings/aws" variant="subtle">
            AWS Settings
          </Button>
        </Group>
      </Paper>
    </Container>
  );
}

function StatCard({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Paper
      component={Link}
      to={href}
      p="md"
      withBorder
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <Text size="xl" fw={700}>{value}</Text>
      <Text size="sm" c="dimmed">{label}</Text>
    </Paper>
  );
}
