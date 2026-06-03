import { ulid, monotonicFactory } from "ulidx";
import type { StarkeepId } from "./types.js";
import { createStarkeepId } from "./types.js";

const monotonic = monotonicFactory();

export function generateId(): StarkeepId {
  return createStarkeepId(monotonic());
}

export function generateIdAt(timestamp: number): StarkeepId {
  return createStarkeepId(ulid(timestamp));
}
