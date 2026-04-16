import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Container, Title, Table, Code, Text, Badge, Button, Group } from "@mantine/core";
import { requireCustomerId } from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { AccessPoliciesRepository } = await import("@starkeep/admin-db");
  await requireCustomerId(request);

  const policyRepo = new AccessPoliciesRepository();
  const policies = await policyRepo.findAll();

  return json({ policies });
}

export async function action({ request }: ActionFunctionArgs) {
  const { AccessPoliciesRepository } = await import("@starkeep/admin-db");
  await requireCustomerId(request);

  const formData = await request.formData();
  const policyId = formData.get("policyId");

  if (request.method === "DELETE" && typeof policyId === "string") {
    const policyRepo = new AccessPoliciesRepository();
    await policyRepo.revoke(policyId);
  }

  return json({ ok: true });
}

export default function PermissionsIndex() {
  const { policies } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  return (
    <Container size="xl" py="xl">
      <Title order={1} mb="xl">Access Policies</Title>
      <Text c="dimmed" mb="lg">
        Active access policies controlling which apps can read, write, or delete which data types.
        Policies are created during app installation and revoked on uninstall.
      </Text>

      {policies.length === 0 ? (
        <Text c="dimmed">No active policies. Install an app to create access policies.</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Subject</Table.Th>
              <Table.Th>Resource</Table.Th>
              <Table.Th>Permissions</Table.Th>
              <Table.Th>Granted</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {policies.map((policy) => (
              <Table.Tr key={policy.id}>
                <Table.Td>
                  <Badge variant="light" size="sm" mr="xs">{policy.subject_type}</Badge>
                  <Code fz="xs">{policy.subject_id}</Code>
                </Table.Td>
                <Table.Td>
                  <Badge variant="light" size="sm" mr="xs">{policy.resource_type}</Badge>
                  <Code fz="xs">{policy.resource_id}</Code>
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {policy.permissions.map((p) => (
                      <Badge key={p} size="xs" variant="dot">{p}</Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>{new Date(policy.granted_at).toLocaleDateString()}</Table.Td>
                <Table.Td>
                  <fetcher.Form method="delete">
                    <input type="hidden" name="policyId" value={policy.id} />
                    <Button
                      type="submit"
                      variant="subtle"
                      size="xs"
                      color="red"
                      loading={fetcher.state === "submitting"}
                    >
                      Revoke
                    </Button>
                  </fetcher.Form>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Container>
  );
}
