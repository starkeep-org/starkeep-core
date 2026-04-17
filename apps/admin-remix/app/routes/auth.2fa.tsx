import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { Container, Title, Text, TextInput, Button, Paper, Stack, Alert } from "@mantine/core";
import {
  consumeRecoveryCode,
  createSessionForUser,
  decryptTotpSecret,
  getPendingTwoFactorUserId,
  getTotp,
  verifyTotp,
} from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const pendingUserId = await getPendingTwoFactorUserId(request);
  if (!pendingUserId) {
    return redirect("/auth/login");
  }
  return json({});
}

export async function action({ request }: ActionFunctionArgs) {
  const pendingUserId = await getPendingTwoFactorUserId(request);
  if (!pendingUserId) {
    return redirect("/auth/login");
  }

  const formData = await request.formData();
  const code = formData.get("code")?.toString().trim() || "";

  if (!code) {
    return json({ error: "Enter your authentication code" }, { status: 400 });
  }

  const totp = await getTotp(pendingUserId);
  if (!totp) {
    return json({ error: "Two-factor authentication is not configured" }, { status: 400 });
  }

  const secret = decryptTotpSecret(totp.secret_encrypted);
  const isTotpValid = verifyTotp(code, secret);
  if (isTotpValid) {
    const setCookie = await createSessionForUser(request, pendingUserId);
    return redirect("/", { headers: { "Set-Cookie": setCookie } });
  }

  const recovery = await consumeRecoveryCode(pendingUserId, code);
  if (recovery) {
    const setCookie = await createSessionForUser(request, pendingUserId);
    return redirect("/", { headers: { "Set-Cookie": setCookie } });
  }

  return json({ error: "Invalid authentication code" }, { status: 400 });
}

export default function TwoFactor() {
  const actionData = useActionData<typeof action>();

  return (
    <Container size="xs" py="xl">
      <Paper p="xl" withBorder>
        <Title order={2} mb="sm">Two-factor authentication</Title>
        <Text c="dimmed" mb="lg">
          Enter a code from your authenticator app or a recovery code.
        </Text>

        {actionData?.error && (
          <Alert color="red" mb="md">
            {actionData.error}
          </Alert>
        )}

        <Form method="post">
          <Stack gap="md">
            <TextInput label="Authentication code" name="code" required />
            <Button type="submit" fullWidth>Verify</Button>
          </Stack>
        </Form>
      </Paper>
    </Container>
  );
}
