import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData } from "@remix-run/react";
import { Container, Title, Text, TextInput, Button, Paper, Stack, Alert } from "@mantine/core";
import { sendMagicLink } from "../lib/auth.server";

type ActionData =
  | { error: string }
  | { disabled: true }
  | { success: true };

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const email = formData.get("email")?.toString() || "";

  if (!email) {
    return json<ActionData>({ error: "Email is required" }, { status: 400 });
  }

  try {
    const result = await sendMagicLink(request, email);
    if (result?.disabled) {
      return json<ActionData>({ disabled: true });
    }
    return json<ActionData>({ success: true });
  } catch (error) {
    return json<ActionData>(
      { error: error instanceof Error ? error.message : "Failed to send login link" },
      { status: 500 }
    );
  }
}

export default function MagicLink() {
  const actionData = useActionData<ActionData>();
  const success = actionData && "success" in actionData;
  const disabled = actionData && "disabled" in actionData;
  const errorMessage = actionData && "error" in actionData ? actionData.error : null;

  return (
    <Container size="xs" py="xl">
      <Paper p="xl" withBorder>
        <Title order={2} mb="sm">Email login link</Title>
        <Text c="dimmed" mb="lg">We will send a one-time sign-in link.</Text>

        {errorMessage && (
          <Alert color="red" mb="md">
            {errorMessage}
          </Alert>
        )}

        {disabled ? (
          <Alert color="yellow" mb="md">
            Email login is disabled. Configure `RESEND_API_KEY` and `EMAIL_FROM` to enable magic links.
          </Alert>
        ) : success ? (
          <Alert color="green" mb="md">
            If the email exists, a login link has been sent.
          </Alert>
        ) : (
          <Form method="post">
            <Stack gap="md">
              <TextInput label="Email" name="email" type="email" required />
              <Button type="submit" fullWidth>Send link</Button>
            </Stack>
          </Form>
        )}

        <Button component={Link} to="/auth/login" variant="subtle" mt="lg">
          Back to sign in
        </Button>
      </Paper>
    </Container>
  );
}
