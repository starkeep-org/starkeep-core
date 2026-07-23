/**
 * The platform-owned capability registry (see plan §3.1).
 *
 * Capabilities are metered AWS-service powers the cloud broker lends to apps —
 * the wired one being `bedrock.invoke` (on-demand Bedrock model calls). Like the
 * type/category registry, this set is **hardcoded and platform-owned**: apps
 * declare which capabilities they need in their manifest but cannot invent new
 * ones. Manifest validation rejects any capability name not listed here, and
 * reserves the privileged names below so a third-party app can't claim them.
 *
 * The broker route, grant model, and capability role are all capability-keyed so
 * additional Bin-1 capabilities (Rekognition, Textract, Polly, …) are a later
 * increment — but only `bedrock.invoke` is wired now.
 */

/** The one wired capability: on-demand Bedrock `InvokeModel` / Converse. */
export const CAPABILITY_BEDROCK_INVOKE = "bedrock.invoke";

export interface CapabilitySpec {
  name: string;
  /** Human-readable summary shown nowhere security-critical (docs/UI only). */
  description: string;
  /**
   * True if the capability's requests carry a `model` the app must be granted.
   * `bedrock.invoke` is model-keyed; a future non-model capability would set
   * this false.
   */
  modelKeyed: boolean;
}

export const CAPABILITY_REGISTRY: readonly CapabilitySpec[] = [
  {
    name: CAPABILITY_BEDROCK_INVOKE,
    description: "On-demand Amazon Bedrock model invocation (text/vision).",
    modelKeyed: true,
  },
];

const REGISTRY_BY_NAME = new Map<string, CapabilitySpec>(
  CAPABILITY_REGISTRY.map((c) => [c.name, c]),
);

/**
 * Privileged capability names reserved so no third-party app can declare them,
 * even before they are wired — mirrors how `fileAccessAll` / `brokerPower` are
 * reserved. Reserved names are rejected by manifest validation regardless of
 * whether they appear in `CAPABILITY_REGISTRY` yet.
 */
export const RESERVED_CAPABILITY_NAMES: readonly string[] = [
  // Bin-2/Bin-3 powers that would carry standing/provisioned resources; kept
  // unclaimable until they are designed and gated.
  "bedrock.knowledgeBase",
  "bedrock.agent",
  "infra.provision",
];

/** True if `name` is a known, wired capability. */
export function isKnownCapability(name: string): boolean {
  return REGISTRY_BY_NAME.has(name);
}

/** True if `name` is a reserved (unclaimable) privileged capability name. */
export function isReservedCapabilityName(name: string): boolean {
  return RESERVED_CAPABILITY_NAMES.includes(name);
}

export function lookupCapability(name: string): CapabilitySpec | undefined {
  return REGISTRY_BY_NAME.get(name);
}
