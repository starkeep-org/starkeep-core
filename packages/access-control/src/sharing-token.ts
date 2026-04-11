function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generateToken(): Promise<{ token: string; tokenHash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = bytesToHex(bytes);
  const tokenHash = await hashToken(token);
  return { token, tokenHash };
}

export async function hashToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(new Uint8Array(buf));
}
