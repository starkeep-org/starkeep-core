/**
 * The vault's routes, under `/apps/<appId>/vault`, and who may call each.
 *
 * | Route                    | Caller                                 | Answer              |
 * | ------------------------ | -------------------------------------- | ------------------- |
 * | `GET /vault`             | the user, through the app's server     | names and times     |
 * | `PUT /vault/<name>`      | the user, or a job run for its user    | 204                 |
 * | `DELETE /vault/<name>`   | the user                               | 204                 |
 * | `GET /vault/<name>`      | a job run only                         | the value           |
 *
 * The browser never reads a secret back: a person types a credential once, and
 * from then on only the app's scheduled jobs, running for that person, read
 * it. An outside client's delegation, a device and a mobile key reach no
 * vault route; the delegation and device allowlists name none, and the
 * handler refuses them here as well.
 */
import {
  deleteSecret,
  getSecret,
  listSecrets,
  putSecret,
  SECRET_NAME_PATTERN,
  secretValueRefusal,
  type VaultTarget,
} from "./vault.js";

/** Who is calling, as the data server's gate established it. */
export type VaultCaller = "user" | "job" | "other";

export type VaultRoute =
  | { kind: "list" }
  | { kind: "secret"; method: "GET" | "PUT" | "DELETE"; name: string }
  | { kind: "unknown" };

/** Which vault route a request names, or null when the path is not the vault's. */
export function vaultRouteOf(method: string, subPath: string): VaultRoute | null {
  if (subPath === "/vault") return method === "GET" ? { kind: "list" } : { kind: "unknown" };
  if (!subPath.startsWith("/vault/")) return null;
  const name = subPath.slice("/vault/".length);
  if (!SECRET_NAME_PATTERN.test(name)) return { kind: "unknown" };
  if (method === "GET" || method === "PUT" || method === "DELETE") {
    return { kind: "secret", method, name };
  }
  return { kind: "unknown" };
}

/** Which callers each route admits. */
function admits(route: VaultRoute, caller: VaultCaller): boolean {
  if (route.kind === "list") return caller === "user";
  if (route.kind !== "secret") return false;
  if (route.method === "PUT") return caller === "user" || caller === "job";
  if (route.method === "DELETE") return caller === "user";
  return caller === "job";
}

interface Answer {
  status: number;
  body: unknown;
}

/** Answer one vault route for the caller. The caller already passed the data server's gate. */
export async function handleVaultRoute(
  route: VaultRoute,
  caller: VaultCaller,
  target: VaultTarget,
  body: Buffer,
): Promise<Answer> {
  if (route.kind === "unknown") return { status: 404, body: { error: "Not found" } };
  if (!admits(route, caller)) {
    return {
      status: 403,
      body: {
        error:
          route.kind === "secret" && route.method === "GET"
            ? "Only the app's scheduled jobs read a secret"
            : "This caller may not reach the vault this way",
      },
    };
  }
  if (route.kind === "list") return { status: 200, body: { secrets: await listSecrets(target) } };
  if (route.method === "GET") {
    const value = await getSecret(target, route.name);
    return value === null
      ? { status: 404, body: { error: `No secret called ${route.name}` } }
      : { status: 200, body: { value } };
  }
  if (route.method === "DELETE") {
    await deleteSecret(target, route.name);
    return { status: 204, body: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "Body is not valid JSON" } };
  }
  const value = (parsed as { value?: unknown } | null)?.value;
  const refusal = secretValueRefusal(value);
  if (refusal) return { status: 400, body: { error: refusal } };
  await putSecret(target, route.name, value as string);
  return { status: 204, body: null };
}
