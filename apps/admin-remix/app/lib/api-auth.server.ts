import crypto from "crypto";
import { AuthRepository } from "@starkeep/admin-db";

const API_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createApiToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const authRepo = new AuthRepository();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + API_TOKEN_TTL_MS);
  await authRepo.createSession(userId, expiresAt, hashToken(token));
  return { token: `sk_${token}`, expiresAt };
}

export async function resolveApiToken(
  request: Request,
): Promise<{ userId: string; customerId: string } | null> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer sk_")) return null;

  const rawToken = header.slice("Bearer sk_".length);
  const tokenHash = hashToken(rawToken);

  const authRepo = new AuthRepository();
  const session = await authRepo.findSessionByToken(tokenHash);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) return null;

  const memberships = await authRepo.getMembershipsForUser(session.user_id);
  if (memberships.length === 0) return null;

  return {
    userId: session.user_id,
    customerId: memberships[0]!.customer_id,
  };
}

export function apiError(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
