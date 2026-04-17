import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Container, Title, Table, Code, Text, Badge } from "@mantine/core";
import { requireCustomerId } from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { TypeRegistryRepository } = await import("@starkeep/admin-db");
  await requireCustomerId(request);

  const typeRepo = new TypeRegistryRepository();
  const types = await typeRepo.findAll();

  return json({ types });
}

export default function TypesIndex() {
  const { types } = useLoaderData<typeof loader>();

  return (
    <Container size="xl" py="xl">
      <Title order={1} mb="xl">Type Registry</Title>
      <Text c="dimmed" mb="lg">
        Globally registered data types. Types are shared across all installed apps — any app with the appropriate
        permissions can read or write records of these types.
      </Text>

      {types.length === 0 ? (
        <Text c="dimmed">No types registered yet. Install an app to register types.</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Type ID</Table.Th>
              <Table.Th>Schema Version</Table.Th>
              <Table.Th>Description</Table.Th>
              <Table.Th>Registered By</Table.Th>
              <Table.Th>Created</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {types.map((type) => (
              <Table.Tr key={type.id}>
                <Table.Td><Code>{type.type_id}</Code></Table.Td>
                <Table.Td><Badge variant="light">{type.schema_version}</Badge></Table.Td>
                <Table.Td><Text size="sm" lineClamp={1}>{type.description || "—"}</Text></Table.Td>
                <Table.Td>
                  {type.registered_by_app_id
                    ? <Code fz="xs">{type.registered_by_app_id}</Code>
                    : <Text size="sm" c="dimmed">system</Text>}
                </Table.Td>
                <Table.Td>{new Date(type.created_at).toLocaleDateString()}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Container>
  );
}
