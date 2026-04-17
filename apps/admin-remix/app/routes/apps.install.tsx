import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useNavigation } from "@remix-run/react";
import {
  Container, Title, Button, Stack, Alert, Text, Paper, Textarea,
  Badge, Group, Checkbox, Code,
} from "@mantine/core";
import { requireCustomerId } from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireCustomerId(request);
  return json({});
}

export async function action({ request }: ActionFunctionArgs) {
  const {
    AppRegistryRepository, TypeRegistryRepository, AccessPoliciesRepository,
  } = await import("@starkeep/admin-db");
  const { validateManifest, checkTypeConflicts } = await import("@starkeep/admin-manifest");

  await requireCustomerId(request);
  const formData = await request.formData();
  const manifestJson = formData.get("manifest");

  if (!manifestJson || typeof manifestJson !== "string") {
    return json({ step: "input", error: "Manifest JSON is required" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return json({ step: "input", error: "Invalid JSON" });
  }

  const validation = validateManifest(parsed);
  if (!validation.valid || !validation.manifest) {
    return json({
      step: "input",
      error: validation.errors.join("; "),
      warnings: validation.warnings,
    });
  }

  const manifest = validation.manifest;

  // Check if app is already installed
  const appRepo = new AppRegistryRepository();
  const existing = await appRepo.findByAppId(manifest.id);
  if (existing) {
    return json({ step: "input", error: `App "${manifest.id}" is already installed` });
  }

  // Check type conflicts
  const typeRepo = new TypeRegistryRepository();
  const existingTypes = await typeRepo.findAll();
  const conflicts = checkTypeConflicts(
    manifest.typeDefinitions,
    existingTypes.map((t) => ({ typeId: t.type_id, schemaVersion: t.schema_version })),
  );

  if (conflicts.length > 0) {
    return json({
      step: "input",
      error: conflicts.map((c) => c.reason).join("; "),
    });
  }

  // Register types
  const registeredTypeIds: string[] = [];
  for (const td of [...manifest.typeDefinitions, ...manifest.privateTypeDefinitions]) {
    const exists = await typeRepo.findByTypeId(td.typeId);
    if (!exists) {
      await typeRepo.create({
        type_id: td.typeId,
        schema_version: td.schemaVersion,
        description: td.description,
        schema: td.schema as Record<string, unknown> | undefined,
        registered_by_app_id: manifest.id,
      });
      registeredTypeIds.push(td.typeId);
    }
  }

  // Create access policies for approved permissions
  const policyRepo = new AccessPoliciesRepository();
  const policyIds: string[] = [];
  const approvedPermissions = [
    ...manifest.requiredPermissions,
    ...manifest.optionalPermissions.filter((_, i) => {
      const checked = formData.get(`optional_${i}`);
      return checked === "on";
    }),
  ];

  for (const perm of approvedPermissions) {
    const policy = await policyRepo.create({
      subject_type: perm.subjectType,
      subject_id: manifest.id,
      resource_type: perm.resourceType,
      resource_id: perm.resourceId,
      permissions: perm.permissions,
    });
    policyIds.push(policy.id);
  }

  // Create app registry entry
  await appRepo.create({
    app_id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    tier: manifest.tier,
    manifest: manifest as unknown as Record<string, unknown>,
    policy_ids: policyIds,
    registered_type_ids: registeredTypeIds,
  });

  return redirect("/apps");
}

export default function InstallApp() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <Container size="md" py="xl">
      <Button component={Link} to="/apps" variant="subtle" size="sm" mb="md">
        &larr; Back to Apps
      </Button>

      <Title order={1} mb="md">Install App</Title>
      <Text c="dimmed" mb="xl">
        Paste a starkeep.manifest.json to install an app. The manifest declares what types and permissions the app needs.
      </Text>

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Installation Error" mb="md">
          {actionData.error}
        </Alert>
      )}

      {(() => {
        const warnings = actionData && "warnings" in actionData ? actionData.warnings as string[] : [];
        return warnings.length > 0 ? (
          <Alert color="yellow" title="Warnings" mb="md">
            {warnings.map((w: string, i: number) => <Text key={i} size="sm">{w}</Text>)}
          </Alert>
        ) : null;
      })()}

      <Form method="post">
        <Stack gap="md">
          <Textarea
            label="App Manifest (JSON)"
            name="manifest"
            placeholder='{"id": "@starkeep/photos", "name": "Starkeep Photos", ...}'
            minRows={12}
            autosize
            required
            styles={{ input: { fontFamily: "monospace", fontSize: "0.85rem" } }}
          />

          <Paper p="md" withBorder>
            <Text size="sm" fw={600} mb="xs">What happens during installation:</Text>
            <Stack gap="xs">
              <Text size="sm" c="dimmed">1. Manifest is validated and checked for conflicts</Text>
              <Text size="sm" c="dimmed">2. New types are registered in the global type registry</Text>
              <Text size="sm" c="dimmed">3. Required permissions are granted automatically</Text>
              <Text size="sm" c="dimmed">4. App is added to the registry</Text>
            </Stack>
          </Paper>

          <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
            {isSubmitting ? "Installing..." : "Validate & Install"}
          </Button>
        </Stack>
      </Form>
    </Container>
  );
}
