import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData } from "@remix-run/react";
import { Container, Title, Text, TextInput, PasswordInput, Button, Paper, Stack, Alert } from "@mantine/core";
import { AuthRepository } from "@starkeep/admin-db";
import { getSession } from "../lib/session.server";
import { createSessionForUser, getTotp, startTwoFactorChallenge, verifyPassword } from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSession(request);
  const sessionId = session.get("sessionId");
  if (typeof sessionId === "string") {
    const authRepo = new AuthRepository();
    const activeSession = await authRepo.findSessionById(sessionId);
    if (activeSession) {
      return redirect("/");
    }
  }
  return json({});
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const email = formData.get("email")?.toString() || "";
  const password = formData.get("password")?.toString() || "";

  if (!email || !password) {
    return json({ error: "Email and password are required" }, { status: 400 });
  }

  const user = await verifyPassword(email, password);
  if (!user) {
    return json({ error: "Invalid email or password" }, { status: 400 });
  }

  const totp = await getTotp(user.id);
  if (totp) {
    const setCookie = await startTwoFactorChallenge(request, user.id);
    return redirect("/auth/2fa", { headers: { "Set-Cookie": setCookie } });
  }

  const setCookie = await createSessionForUser(request, user.id);
  return redirect("/", { headers: { "Set-Cookie": setCookie } });
}

export default function Login() {
  const actionData = useActionData<typeof action>();

  return (
    <Container size="xs" py="xl">
      <Paper p="xl" withBorder>
        <Title order={2} mb="sm">Sign in</Title>
        <Text c="dimmed" mb="lg">Use your email and password to continue.</Text>

        {actionData?.error && (
          <Alert color="red" mb="md">
            {actionData.error}
          </Alert>
        )}

        <Form method="post">
          <Stack gap="md">
            <TextInput label="Email" name="email" type="email" required />
            <PasswordInput label="Password" name="password" required />
            <Button type="submit" fullWidth>Sign in</Button>
          </Stack>
        </Form>

        <Stack gap="xs" mt="lg">
          <Button component={Link} to="/auth/magic-link" variant="subtle">
            Email me a login link
          </Button>
          <Button component={Link} to="/auth/register" variant="subtle">
            Create an account
          </Button>
        </Stack>
      </Paper>
    </Container>
  );
}
