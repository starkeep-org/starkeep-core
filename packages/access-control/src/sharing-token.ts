import { randomBytes, createHash } from "node:crypto";

export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  return { token, tokenHash };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
