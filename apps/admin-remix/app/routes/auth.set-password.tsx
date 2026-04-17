import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { Container, Title, Text, PasswordInput, Button, Paper, Stack, Alert } from "@mantine/core";
import { validate as validateUuid } from "uuid";
import argon2 from "argon2";
import { AuthRepository } from "@starkeep/admin-db";
import { createSessionForUser } from "../lib/auth.server";
import { getSession } from "../lib/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSession(request);
  const inviteUserId = session.get("inviteUserId");
  if (typeof inviteUserId !== "string" || !validateUuid(inviteUserId)) {
    return redirect("/auth/login");
  }
  return json({});
}

export async function action({ request }: ActionFunctionArgs) {
  const session = await getSession(request);
  const inviteUserId = session.get("inviteUserId");
  if (typeof inviteUserId !== "string" || !validateUuid(inviteUserId)) {
    return redirect("/auth/login");
  }

  const formData = await request.formData();
  const password = formData.get("password")?.toString() || "";
  const confirmPassword = formData.get("confirmPassword")?.toString() || "";

  if (!password || !confirmPassword) {
    return json({ error: "All fields are required" }, { status: 400 });
  }
  if (password.length < 12) {
    return json({ error: "Password must be at least 12 characters" }, { status: 400 });
  }
  if (password !== confirmPassword) {
    return json({ error: "Passwords do not match" }, { status: 400 });
  }

  const authRepo = new AuthRepository();
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await authRepo.upsertPassword(inviteUserId, hash);

  const setCookie = await createSessionForUser(request, inviteUserId);
  return redirect("/", { headers: { "Set-Cookie": setCookie } });
}

export default function SetPassword() {
  const actionData = useActionData<typeof action>();

  return (
    <Container size="xs" py="xl">
      <Paper p="xl" withBorder>
        <Title order={2} mb="sm">Set your password</Title>
        <Text c="dimmed" mb="lg">Create a password for your account.</Text>

        {actionData?.error && (
          <Alert color="red" mb="md">
            {actionData.error}
          </Alert>
        )}

        <Form method="post">
          <Stack gap="md">
            <PasswordInput label="Password" name="password" required />
            <PasswordInput label="Confirm password" name="confirmPassword" required />
            <Button type="submit" fullWidth>Save password</Button>
          </Stack>
        </Form>
      </Paper>
    </Container>
  );
}
