import type { ActionFunctionArgs } from "@remix-run/node";
import { verifyPassword } from "../lib/auth.server";
import { createApiToken, apiError } from "../lib/api-auth.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return apiError(405, "Method not allowed");
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.password) {
    return apiError(400, "email and password are required");
  }

  const user = await verifyPassword(body.email, body.password);
  if (!user) {
    return apiError(401, "Invalid credentials");
  }

  const { token, expiresAt } = await createApiToken(user.id);

  return new Response(
    JSON.stringify({ token, expiresAt: expiresAt.toISOString(), userId: user.id }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
