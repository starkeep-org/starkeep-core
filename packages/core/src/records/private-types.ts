/**
 * Helpers for the private-type naming convention.
 *
 * Private records use the type pattern `<normalizedAppId>:private:<subtype>`.
 * Examples:
 *   makePrivateType("@starkeep/photos", "settings") → "starkeep-photos:private:settings"
 *   makePrivateType("starkeep-photos", "settings")  → "starkeep-photos:private:settings"
 */

const PRIVATE_SEGMENT = ":private:";

/**
 * Normalize an app ID to the prefix used in private type strings.
 * "@starkeep/photos" → "starkeep-photos"
 * "starkeep-photos"  → "starkeep-photos"  (idempotent)
 */
export function normalizeAppId(appId: string): string {
  return appId.replace(/^@/, "").replace(/\//g, "-");
}

/**
 * Build a private type string for the given app and subtype.
 * makePrivateType("@starkeep/photos", "settings") → "starkeep-photos:private:settings"
 */
export function makePrivateType(appId: string, subtype: string): string {
  return `${normalizeAppId(appId)}${PRIVATE_SEGMENT}${subtype}`;
}

/** Return true if `type` matches the private-type pattern. */
export function isPrivateType(type: string): boolean {
  return type.includes(PRIVATE_SEGMENT);
}

/**
 * Extract the normalized app-ID prefix from a private type string.
 * Returns `null` if the string is not a private type.
 * "starkeep-photos:private:settings" → "starkeep-photos"
 */
export function getPrivateTypeOwner(type: string): string | null {
  const idx = type.indexOf(PRIVATE_SEGMENT);
  if (idx === -1) return null;
  return type.slice(0, idx);
}
