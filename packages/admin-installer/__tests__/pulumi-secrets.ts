/**
 * Pulumi's mocks hand a resource's inputs back with every secret wrapped in
 * an envelope (`{ [SIG]: SECRET_SIG, value }`), and an input that holds a
 * secret anywhere inside is wrapped whole. Tests that read inputs unwrap them.
 */
const SIG_KEY = "4dabf18193072939515e22adb298388d";
const SECRET_SIG = "1b47061264138c4ac30d75fd1eb44270";

export function unwrapSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(unwrapSecrets) as T;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj[SIG_KEY] === SECRET_SIG && "value" in obj) return unwrapSecrets(obj.value) as T;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, unwrapSecrets(v)])) as T;
  }
  return value;
}
