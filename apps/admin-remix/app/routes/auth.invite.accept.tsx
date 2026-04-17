import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Container, Title, Text, Button, Paper, Alert } from "@mantine/core";
import { AuthRepository } from "@starkeep/admin-db";
import {
  consumeInvitation,
  createSessionForUser,
  ensureMembership,
  getTotp,
  markEmailVerified,
  startTwoFactorChallenge,
} from "../lib/auth.server";
import { commitSession, getSession } from "../lib/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return json({ error: "Missing token" }, { status: 400 });
  }

  const invite = await consumeInvitation(token);
  if (!invite) {
    return json({ error: "This invite is invalid or has expired." }, { status: 400 });
  }

  const authRepo = new AuthRepository();
  let user = await authRepo.findUserByEmail(invite.email);
  if (!user) {
    user = await authRepo.createUser(invite.email);
  }

  await ensureMembership(user.id, invite.customer_id);
  await markEmailVerified(user.id);

  const password = await authRepo.getPassword(user.id);
  if (!password) {
    const session = await getSession(request);
    session.set("inviteUserId", user.id);
    return redirect("/auth/set-password", {
      headers: {
        "Set-Cookie": await commitSession(session),
      },
    });
  }

  const totp = await getTotp(user.id);
  if (totp) {
    const setCookie = await startTwoFactorChallenge(request, user.id);
    return redirect("/auth/2fa", { headers: { "Set-Cookie": setCookie } });
  }

  const setCookie = await createSessionForUser(request, user.id);
  return redirect("/", { headers: { "Set-Cookie": setCookie } });
}

export default function InviteAccept() {
  const loaderData = useLoaderData<typeof loader>();
  const error = "error" in loaderData ? loaderData.error : null;

  return (
    <Container size="xs" py="xl">
      <Paper p="xl" withBorder>
        {error ? (
          <>
            <Title order={2} mb="sm">Unable to accept invite</Title>
            <Alert color="red" mb="md">{error}</Alert>
            <Button component="a" href="/auth/login" variant="subtle">
              Back to sign in
            </Button>
          </>
        ) : (
          <>
            <Title order={2} mb="sm">Accepting invite...</Title>
            <Text c="dimmed" mb="lg">If this page doesn’t redirect, your invite may have expired.</Text>
            <Button component="a" href="/auth/login" variant="subtle">
              Back to sign in
            </Button>
          </>
        )}
      </Paper>
    </Container>
  );
}
