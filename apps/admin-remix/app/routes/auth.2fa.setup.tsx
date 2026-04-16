import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { Container, Title, Text, TextInput, Button, Paper, Stack, Alert, Code } from "@mantine/core";
import { AuthRepository } from "@starkeep/admin-db";
import {
  createRecoveryCodes,
  enableTotp,
  generateTotpSecret,
  requireUserId,
  verifyTotp,
} from "../lib/auth.server";
import { commitSession, getSession } from "../lib/session.server";

type LoaderData =
  | { enabled: true }
  | { enabled: false; otpauth: string; secret: string }
  | { error: string };

type ActionData =
  | { error: string }
  | { success: true; recoveryCodes: string[] };

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const authRepo = new AuthRepository();
  const user = await authRepo.findUserById(userId);
  if (!user) {
    return json<LoaderData>({ error: "User not found" }, { status: 404 });
  }

  const existing = await authRepo.getTotp(userId);
  if (existing) {
    return json<LoaderData>({ enabled: true });
  }

  const { secret, otpauth } = generateTotpSecret(user.email);
  const session = await getSession(request);
  session.set("totpSetupSecret", secret);

  return json<LoaderData>(
    { enabled: false, otpauth, secret },
    {
      headers: {
        "Set-Cookie": await commitSession(session),
      },
    }
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const session = await getSession(request);
  const secret = session.get("totpSetupSecret");
  if (typeof secret !== "string") {
    return json<ActionData>(
      { error: "Setup session expired. Please reload this page." },
      { status: 400 }
    );
  }

  const formData = await request.formData();
  const code = formData.get("code")?.toString().trim() || "";
  if (!code) {
    return json<ActionData>({ error: "Enter the verification code" }, { status: 400 });
  }

  const valid = verifyTotp(code, secret);
  if (!valid) {
    return json<ActionData>({ error: "Invalid verification code" }, { status: 400 });
  }

  await enableTotp(userId, secret);
  const recoveryCodes = await createRecoveryCodes(userId);

  session.unset("totpSetupSecret");
  return json<ActionData>(
    { success: true, recoveryCodes },
    {
      headers: {
        "Set-Cookie": await commitSession(session),
      },
    }
  );
}

export default function TwoFactorSetup() {
  const loaderData = useLoaderData<LoaderData>();
  const actionData = useActionData<ActionData>();
  const loaderError = "error" in loaderData ? loaderData.error : null;
  const actionError = actionData && "error" in actionData ? actionData.error : null;
  const actionSuccess = actionData && "success" in actionData ? actionData : null;

  if ("enabled" in loaderData && loaderData.enabled) {
    return (
      <Container size="xs" py="xl">
        <Paper p="xl" withBorder>
          <Title order={2} mb="sm">Two-factor already enabled</Title>
          <Text c="dimmed">You already have an authenticator configured.</Text>
        </Paper>
      </Container>
    );
  }

  return (
    <Container size="xs" py="xl">
      <Paper p="xl" withBorder>
        <Title order={2} mb="sm">Enable two-factor authentication</Title>
        <Text c="dimmed" mb="lg">
          Scan the setup code in your authenticator app, then confirm with a code.
        </Text>

        {loaderError && (
          <Alert color="red" mb="md">
            {loaderError}
          </Alert>
        )}

        {"otpauth" in loaderData && (
          <Stack gap="xs" mb="lg">
            <Text size="sm">Setup URL (for manual entry):</Text>
            <Code block>{loaderData.otpauth}</Code>
            <Text size="sm">Secret:</Text>
            <Code>{loaderData.secret}</Code>
          </Stack>
        )}

        {actionError && (
          <Alert color="red" mb="md">
            {actionError}
          </Alert>
        )}

        {actionSuccess && actionSuccess.recoveryCodes ? (
          <Stack gap="xs">
            <Alert color="green">
              Two-factor authentication is now enabled. Save these recovery codes.
            </Alert>
            {actionSuccess.recoveryCodes.map((code: string) => (
              <Code key={code}>{code}</Code>
            ))}
          </Stack>
        ) : (
          <Form method="post">
            <Stack gap="md">
              <TextInput label="Verification code" name="code" required />
              <Button type="submit" fullWidth>Enable 2FA</Button>
            </Stack>
          </Form>
        )}
      </Paper>
    </Container>
  );
}
