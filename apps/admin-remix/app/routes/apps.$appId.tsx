import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useLoaderData, useFetcher } from "@remix-run/react";
import {
  Container, Title, Text, Paper, Stack, Button, Group,
  Badge, Code, Table, Alert,
} from "@mantine/core";
import { useState } from "react";
import { requireCustomerId } from "../lib/auth.server";
import { DeleteConfirmModal } from "@starkeep/admin-ui";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const {
    AppRegistryRepository, AccessPoliciesRepository, TypeRegistryRepository,
  } = await import("@starkeep/admin-db");

  await requireCustomerId(request);
  const appId = decodeURIComponent(params.appId!);

  const appRepo = new AppRegistryRepository();
  const app = await appRepo.findByAppId(appId);
  if (!app) throw new Response("App not found", { status: 404 });

  const policyRepo = new AccessPoliciesRepository();
  const policies = await policyRepo.findBySubject("app", appId);

  const typeRepo = new TypeRegistryRepository();
  const types = await Promise.all(
    app.registered_type_ids.map(async (typeId) => {
      const t = await typeRepo.findByTypeId(typeId);
      return t ? { type_id: t.type_id, schema_version: t.schema_version, description: t.description } : null;
    }),
  );

  return json({
    app,
    policies,
    types: types.filter(Boolean),
  });
}

export async function action({ params, request }: ActionFunctionArgs) {
  const {
    AppRegistryRepository, AccessPoliciesRepository,
  } = await import("@starkeep/admin-db");

  await requireCustomerId(request);
  const appId = decodeURIComponent(params.appId!);

  if (request.method === "DELETE") {
    const appRepo = new AppRegistryRepository();
    const app = await appRepo.findByAppId(appId);
    if (!app) return redirect("/apps");

    // Revoke all policies
    if (app.policy_ids.length > 0) {
      const policyRepo = new AccessPoliciesRepository();
      await policyRepo.revokeAll(app.policy_ids);
    }

    // Remove app from registry (type registrations are preserved per architecture)
    await appRepo.delete(appId);

    return redirect("/apps");
  }

  return json({ error: "Invalid action" }, { status: 400 });
}

export default function AppDetail() {
  const { app, policies, types } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [uninstallOpen, setUninstallOpen] = useState(false);

  const tierColor = app.tier === "official" ? "blue" : app.tier === "verified" ? "teal" : "orange";

  return (
    <Container size="md" py="xl">
      <Button component={Link} to="/apps" variant="subtle" size="sm" mb="md">
        &larr; Back to Apps
      </Button>

      <Group justify="space-between" mb="lg">
        <Group gap="sm">
          <Title order={1}>{app.name}</Title>
          <Badge color={tierColor}>{app.tier}</Badge>
          <Badge variant="light" color={app.status === "active" ? "green" : "yellow"}>
            {app.status}
          </Badge>
        </Group>
        <Code>{app.version}</Code>
      </Group>

      <Stack gap="md">
        <Paper p="lg" withBorder>
          <Title order={3} size="h4" mb="sm">Details</Title>
          <Table>
            <Table.Tbody>
              <Table.Tr><Table.Td fw={600} w={140}>App ID</Table.Td><Table.Td><Code fz="xs">{app.app_id}</Code></Table.Td></Table.Tr>
              <Table.Tr><Table.Td fw={600}>Version</Table.Td><Table.Td>{app.version}</Table.Td></Table.Tr>
              <Table.Tr><Table.Td fw={600}>Tier</Table.Td><Table.Td><Badge color={tierColor} size="sm">{app.tier}</Badge></Table.Td></Table.Tr>
              <Table.Tr><Table.Td fw={600}>Installed</Table.Td><Table.Td>{new Date(app.installed_at).toLocaleString()}</Table.Td></Table.Tr>
              <Table.Tr><Table.Td fw={600}>Policies</Table.Td><Table.Td>{app.policy_ids.length}</Table.Td></Table.Tr>
              <Table.Tr><Table.Td fw={600}>Types</Table.Td><Table.Td>{app.registered_type_ids.length}</Table.Td></Table.Tr>
            </Table.Tbody>
          </Table>
        </Paper>

        {types.length > 0 && (
          <Paper p="lg" withBorder>
            <Title order={3} size="h4" mb="sm">Registered Types</Title>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Type ID</Table.Th>
                  <Table.Th>Version</Table.Th>
                  <Table.Th>Description</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {types.map((t: any) => (
                  <Table.Tr key={t.type_id}>
                    <Table.Td><Code>{t.type_id}</Code></Table.Td>
                    <Table.Td><Badge variant="light" size="sm">{t.schema_version}</Badge></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{t.description || "\u2014"}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
        )}

        {policies.length > 0 && (
          <Paper p="lg" withBorder>
            <Title order={3} size="h4" mb="sm">Access Policies</Title>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Resource</Table.Th>
                  <Table.Th>Permissions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {policies.map((p) => (
                  <Table.Tr key={p.id}>
                    <Table.Td>
                      <Badge variant="light" size="sm" mr="xs">{p.resource_type}</Badge>
                      <Code fz="xs">{p.resource_id}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {p.permissions.map((perm) => (
                          <Badge key={perm} size="xs" variant="dot">{perm}</Badge>
                        ))}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
        )}

        <Paper p="lg" withBorder style={{ borderColor: "var(--mantine-color-red-4)" }}>
          <Title order={3} size="h4" mb="sm" c="red">Danger Zone</Title>
          <Text size="sm" c="dimmed" mb="md">
            Uninstalling revokes all access policies. Type registrations and existing data are preserved.
          </Text>
          <Button color="red" variant="outline" onClick={() => setUninstallOpen(true)}>
            Uninstall {app.name}
          </Button>
        </Paper>
      </Stack>

      <DeleteConfirmModal
        opened={uninstallOpen}
        onClose={() => setUninstallOpen(false)}
        onConfirm={() => {
          fetcher.submit({}, { method: "delete" });
          setUninstallOpen(false);
        }}
        title={`Uninstall ${app.name}?`}
        message={`This will revoke all ${app.policy_ids.length} access policies for this app. Type registrations and data records will be preserved. This cannot be undone.`}
        loading={fetcher.state === "submitting"}
      />
    </Container>
  );
}
