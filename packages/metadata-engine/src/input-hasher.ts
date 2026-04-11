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

export async function computeInputHash(
  dataRecordId: string,
  dependencyIds: string[],
  parameters: Record<string, unknown>,
): Promise<string> {
  const input = stableStringify({
    dataRecordId,
    dependencyIds: [...dependencyIds].sort(),
    parameters,
  });
  const encoded = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
