import { createHash } from "node:crypto";

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
  const entries = sortedKeys.map(
    (key) =>
      JSON.stringify(key) +
      ":" +
      stableStringify((value as Record<string, unknown>)[key]),
  );
  return "{" + entries.join(",") + "}";
}

export function computeInputHash(
  dataRecordId: string,
  dependencyIds: string[],
  parameters: Record<string, unknown>,
): string {
  const input = stableStringify({
    dataRecordId,
    dependencyIds: [...dependencyIds].sort(),
    parameters,
  });

  return createHash("sha256").update(input).digest("hex");
}
