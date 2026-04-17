import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Container, Title, Table, Code, Text, Badge, Group } from "@mantine/core";
import { requireCustomerId } from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { InfraCatalogRepository } = await import("@starkeep/admin-db");
  await requireCustomerId(request);

  const infraRepo = new InfraCatalogRepository();
  const resources = await infraRepo.findAll();

  return json({ resources });
}

export default function InfrastructureIndex() {
  const { resources } = useLoaderData<typeof loader>();

  const sourceColor = (source: string) =>
    source === "core" ? "blue" : "teal";

  return (
    <Container size="xl" py="xl">
      <Title order={1} mb="xl">Infrastructure Catalog</Title>
      <Text c="dimmed" mb="lg">
        All managed AWS resources. Core resources (DSQL, S3) are shared across apps.
        App-specific resources are deployed during installation.
      </Text>

      {resources.length === 0 ? (
        <Text c="dimmed">No infrastructure resources registered. Deploy core infrastructure or install an app.</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Resource ID</Table.Th>
              <Table.Th>Source</Table.Th>
              <Table.Th>Used By</Table.Th>
              <Table.Th>Created</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {resources.map((resource) => (
              <Table.Tr key={resource.id}>
                <Table.Td><Text fw={600}>{resource.name}</Text></Table.Td>
                <Table.Td><Badge variant="light">{resource.resource_type}</Badge></Table.Td>
                <Table.Td><Code fz="xs" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{resource.resource_id}</Code></Table.Td>
                <Table.Td><Badge color={sourceColor(resource.source)}>{resource.source}</Badge></Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {resource.resolved_for_apps.map((appId) => (
                      <Badge key={appId} size="xs" variant="outline">{appId}</Badge>
                    ))}
                    {resource.resolved_for_apps.length === 0 && <Text size="xs" c="dimmed">—</Text>}
                  </Group>
                </Table.Td>
                <Table.Td>{new Date(resource.created_at).toLocaleDateString()}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Container>
  );
}
