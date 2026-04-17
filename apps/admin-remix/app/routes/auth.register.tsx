import type { ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData } from "@remix-run/react";
import { Container, Title, Text, TextInput, PasswordInput, Button, Paper, Stack, Alert } from "@mantine/core";
import { createSessionForUser, registerUser } from "../lib/auth.server";

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const email = formData.get("email")?.toString() || "";
  const password = formData.get("password")?.toString() || "";
  const confirmPassword = formData.get("confirmPassword")?.toString() || "";
  const customerName = formData.get("customerName")?.toString() || "";

  if (!email || !password || !confirmPassword || !customerName) {
    return json({ error: "All fields are required" }, { status: 400 });
  }
  if (password.length < 12) {
    return json({ error: "Password must be at least 12 characters" }, { status: 400 });
  }
  if (password !== confirmPassword) {
    return json({ error: "Passwords do not match" }, { status: 400 });
  }

  try {
    const { user } = await registerUser({ email, password, customerName });
    const setCookie = await createSessionForUser(request, user.id);
    return redirect("/", { headers: { "Set-Cookie": setCookie } });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Failed to create account" },
      { status: 400 }
    );
  }
}

export default function Register() {
  const actionData = useActionData<typeof action>();

  return (
    <Container size="xs" py="xl">
      <Paper p="xl" withBorder>
        <Title order={2} mb="sm">Create account</Title>
        <Text c="dimmed" mb="lg">Set up your Starkeeper workspace.</Text>

        {actionData?.error && (
          <Alert color="red" mb="md">
            {actionData.error}
          </Alert>
        )}

        <Form method="post">
          <Stack gap="md">
            <TextInput label="Workspace name" name="customerName" required />
            <TextInput label="Email" name="email" type="email" required />
            <PasswordInput label="Password" name="password" required />
            <PasswordInput label="Confirm password" name="confirmPassword" required />
            <Button type="submit" fullWidth>Create account</Button>
          </Stack>
        </Form>

        <Button component={Link} to="/auth/login" variant="subtle" mt="lg">
          Back to sign in
        </Button>
      </Paper>
    </Container>
  );
}
