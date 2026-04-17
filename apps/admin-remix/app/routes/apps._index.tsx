import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { Container, Title, Button, Group, Table, Badge, Code, Text } from "@mantine/core";
import { requireCustomerId } from "../lib/auth.server";
import { StatusBadge } from "@starkeep/admin-ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const { AppRegistryRepository } = await import("@starkeep/admin-db");
  await requireCustomerId(request);

  const appRepo = new AppRegistryRepository();
  const apps = await appRepo.findAll();

  return json({ apps });
}

export default function AppsIndex() {
  const { apps } = useLoaderData<typeof loader>();

  const tierColor = (tier: string) => {
    switch (tier) {
      case "official": return "blue";
      case "verified": return "teal";
      case "community": return "orange";
      default: return "gray";
    }
  };

  return (
    <Container size="xl" py="xl">
      <Group justify="space-between" mb="xl">
        <Title order={1}>Installed Apps</Title>
        <Button component={Link} to="/apps/install">
          + Install App
        </Button>
      </Group>

      {apps.length === 0 ? (
        <Text c="dimmed">No apps installed yet. Install your first app to get started.</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>App</Table.Th>
              <Table.Th>Version</Table.Th>
              <Table.Th>Tier</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Types</Table.Th>
              <Table.Th>Installed</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {apps.map((app) => (
              <Table.Tr key={app.id}>
                <Table.Td>
                  <Text fw={600}>{app.name}</Text>
                  <Code fz="xs">{app.app_id}</Code>
                </Table.Td>
                <Table.Td><Code>{app.version}</Code></Table.Td>
                <Table.Td><Badge color={tierColor(app.tier)}>{app.tier}</Badge></Table.Td>
                <Table.Td><StatusBadge status={app.status.toUpperCase()} /></Table.Td>
                <Table.Td>{app.registered_type_ids.length}</Table.Td>
                <Table.Td>{new Date(app.installed_at).toLocaleDateString()}</Table.Td>
                <Table.Td>
                  <Button
                    component={Link}
                    to={`/apps/${encodeURIComponent(app.app_id)}`}
                    variant="subtle"
                    size="xs"
                  >
                    Details
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Container>
  );
}
