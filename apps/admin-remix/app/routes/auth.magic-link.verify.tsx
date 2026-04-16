import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Container, Title, Text, Button, Paper, Alert } from "@mantine/core";
import { consumeMagicLink, createSessionForUser, getTotp, markEmailVerified, startTwoFactorChallenge } from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return json({ error: "Missing token" }, { status: 400 });
  }

  const record = await consumeMagicLink(token);
  if (!record) {
    return json({ error: "This link is invalid or has expired." }, { status: 400 });
  }

  await markEmailVerified(record.user_id);
  const totp = await getTotp(record.user_id);
  if (totp) {
    const setCookie = await startTwoFactorChallenge(request, record.user_id);
    return redirect("/auth/2fa", { headers: { "Set-Cookie": setCookie } });
  }

  const setCookie = await createSessionForUser(request, record.user_id);
  return redirect("/", { headers: { "Set-Cookie": setCookie } });
}

export default function MagicLinkVerify() {
  const loaderData = useLoaderData<typeof loader>();
  const error = "error" in loaderData ? loaderData.error : null;

  return (
    <Container size="xs" py="xl">
      <Paper p="xl" withBorder>
        {error ? (
          <>
            <Title order={2} mb="sm">Unable to sign in</Title>
            <Alert color="red" mb="md">{error}</Alert>
            <Button component="a" href="/auth/login" variant="subtle">
              Back to sign in
            </Button>
          </>
        ) : (
          <>
            <Title order={2} mb="sm">Signing you in...</Title>
            <Text c="dimmed" mb="lg">If this page doesn’t redirect, your link may have expired.</Text>
            <Button component="a" href="/auth/login" variant="subtle">
              Back to sign in
            </Button>
          </>
        )}
      </Paper>
    </Container>
  );
}
