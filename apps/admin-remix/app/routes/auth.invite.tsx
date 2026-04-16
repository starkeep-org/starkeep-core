import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { Container, Title, Text, TextInput, Button, Paper, Stack, Alert } from "@mantine/core";
import { AuthRepository } from "@starkeep/admin-db";
import { createInvitation, requireCustomerId, requireUserId } from "../lib/auth.server";

type ActionData =
  | { error: string }
  | { disabled: true }
  | { success: true };

async function requireAdminRole(userId: string, customerId: string) {
  const authRepo = new AuthRepository();
  const membership = await authRepo.findMembership(userId, customerId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    throw new Response("Forbidden", { status: 403 });
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const customerId = await requireCustomerId(request);
  await requireAdminRole(userId, customerId);
  return json({});
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const customerId = await requireCustomerId(request);
  await requireAdminRole(userId, customerId);

  const formData = await request.formData();
  const email = formData.get("email")?.toString() || "";
  if (!email) {
    return json<ActionData>({ error: "Email is required" }, { status: 400 });
  }

  try {
    const result = await createInvitation(request, {
      email,
      customerId,
      createdByUserId: userId,
    });
    if (result?.disabled) {
      return json<ActionData>({ disabled: true });
    }
    return json<ActionData>({ success: true });
  } catch (error) {
    return json<ActionData>(
      { error: error instanceof Error ? error.message : "Failed to send invite" },
      { status: 500 }
    );
  }
}

export default function InviteUser() {
  const actionData = useActionData<ActionData>();
  const disabled = actionData && "disabled" in actionData;
  const errorMessage = actionData && "error" in actionData ? actionData.error : null;
  const success = actionData && "success" in actionData;

  return (
    <Container size="xs" py="xl">
      <Paper p="xl" withBorder>
        <Title order={2} mb="sm">Invite a teammate</Title>
        <Text c="dimmed" mb="lg">Send an email invite to your workspace.</Text>

        {errorMessage && (
          <Alert color="red" mb="md">
            {errorMessage}
          </Alert>
        )}

        {disabled && (
          <Alert color="yellow" mb="md">
            Email invites are disabled. Configure `RESEND_API_KEY` and `EMAIL_FROM` to enable invites.
          </Alert>
        )}

        {success && (
          <Alert color="green" mb="md">
            Invite sent.
          </Alert>
        )}

        <Form method="post">
          <Stack gap="md">
            <TextInput label="Email" name="email" type="email" required />
            <Button type="submit" fullWidth>Send invite</Button>
          </Stack>
        </Form>
      </Paper>
    </Container>
  );
}
