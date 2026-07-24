/**
 * Wire types shared by the capability model-registry API routes and the
 * operator editor UI (plan §3.6). The registry is two-layered — a read-only
 * PLATFORM registry shipped in `@starkeep/protocol-primitives` plus sparse
 * OPERATOR OVERRIDES in DSQL — and `effective = override ?? platformDefault`.
 *
 * Token pricing crosses the wire as human-facing **$/MTok** (the DB stores
 * $/token); the route converts in both directions.
 */

/** A model's resolved (or platform-default) values, in display units. */
export interface ModelRowValues {
  provider: string;
  /** Cross-region inference profile id, or null when none. */
  inferenceProfileId: string | null;
  vision: boolean;
  /** Input token price in $/MTok; null when the model has no token pricing. */
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  /** Per-image token estimate used to reserve against gates pre-call. */
  imageTokens: number | null;
}

/** The operator's sparse override for one model. A present key means "override
 * this field"; an absent key means "inherit the platform default". */
export interface ModelOverrideInput {
  provider?: string;
  /** string = set profile; null = explicitly cleared (no profile); absent = inherit. */
  inferenceProfileId?: string | null;
  vision?: boolean;
  /** Set together — a pricing override supplies both. */
  inputPerMTok?: number;
  outputPerMTok?: number;
  imageTokens?: number;
}

export interface ModelRow {
  modelId: string;
  /** "platform" = the platform registry knows this model; "user" = defined
   * solely by an operator override (no platform row). */
  source: "platform" | "user";
  /** Merged values shown in the table. */
  effective: ModelRowValues;
  /** Platform defaults (for showing the inherited value of un-overridden
   * fields in the editor); null for an operator-defined model. */
  platform: ModelRowValues | null;
  /** The raw sparse override, so the editor knows which fields are overridden. */
  override: ModelOverrideInput;
}

export interface ModelRegistryResponse {
  models: ModelRow[];
}

/** Provider ids the platform registry recognizes (for the new-model dropdown). */
export const MODEL_PROVIDERS = [
  "anthropic",
  "amazon",
  "openai",
  "qwen",
  "kimi",
  "glm",
] as const;
export type ModelProviderId = (typeof MODEL_PROVIDERS)[number];
