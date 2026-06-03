export type StarkeepId = string & { readonly __brand: unique symbol };

export function createStarkeepId(value: string): StarkeepId {
  return value as StarkeepId;
}

export function isStarkeepId(value: unknown): value is StarkeepId {
  return typeof value === "string" && value.length === 26;
}
