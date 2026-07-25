/**
 * Install-time capability consent (plan §3.2).
 *
 * The admin UI approves the capabilities an app declares in its manifest and
 * passes the OPTIONAL ones the operator denied to the installer via the
 * `STARKEEP_DENIED_CAPABILITIES` env var (comma-separated capability names).
 * A denied OPTIONAL capability is simply dropped before install — no grant row
 * is written and the app runs degraded. A denied REQUIRED capability is a hard
 * error: the app can't function without it, so the install must abort rather
 * than silently ship a broken install.
 *
 * This is kept as a pure function (no env / no process side effects) so the
 * security-relevant rule — *required capabilities can never be silently
 * dropped* — is unit-testable independent of the CLI.
 */

/** Parse the `STARKEEP_DENIED_CAPABILITIES` env value into a set of names. */
export function parseDeniedCapabilities(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export interface CapabilityDenialResult<T> {
  /** Capabilities to install (declared minus denied-optional). */
  kept: T[];
  /** Names of OPTIONAL capabilities the operator denied (app runs degraded). */
  droppedOptional: string[];
  /** Names of denied capabilities that are REQUIRED — denying these must abort
   * the install. Empty when the denial set is valid. */
  droppedRequired: string[];
}

/**
 * Apply operator denials to a manifest's declared capabilities. `required` is
 * already defaulted to `true` by the manifest schema, so an omitted flag is
 * treated as required here too. Returns the kept set plus the classification of
 * what was denied; the caller aborts when `droppedRequired` is non-empty.
 */
export function applyCapabilityDenials<T extends { name: string; required: boolean }>(
  capabilities: T[],
  denied: Set<string>,
): CapabilityDenialResult<T> {
  const droppedRequired: string[] = [];
  const droppedOptional: string[] = [];
  const kept: T[] = [];
  for (const cap of capabilities) {
    if (!denied.has(cap.name)) {
      kept.push(cap);
      continue;
    }
    if (cap.required) droppedRequired.push(cap.name);
    else droppedOptional.push(cap.name);
  }
  return { kept, droppedOptional, droppedRequired };
}

export interface ConsentResolution<T> {
  /** Abort message when a REQUIRED capability was denied; null when the denial
   * set is installable. The caller prints this and exits non-zero. */
  abortMessage: string | null;
  /** The capability set to install (unchanged when nothing was denied). */
  kept: T[];
  /** Denied OPTIONAL capabilities — the app installs and runs degraded. */
  droppedOptional: string[];
}

/**
 * The whole install-time consent decision, from the raw env value to the set the
 * installer should persist. Kept here (rather than inline in the CLI) so the
 * security-relevant outcome — *a denied REQUIRED capability aborts the install,
 * it is never silently installed nor silently dropped* — is unit-testable
 * without running the CLI.
 */
export function resolveConsentedCapabilities<T extends { name: string; required: boolean }>(
  capabilities: T[],
  rawDenied: string | undefined,
  appId: string,
): ConsentResolution<T> {
  const denied = parseDeniedCapabilities(rawDenied);
  if (denied.size === 0) {
    return { abortMessage: null, kept: capabilities, droppedOptional: [] };
  }
  const { kept, droppedOptional, droppedRequired } = applyCapabilityDenials(capabilities, denied);
  if (droppedRequired.length > 0) {
    return {
      abortMessage:
        `Cannot deny required capabilit${droppedRequired.length > 1 ? "ies" : "y"} ` +
        `${droppedRequired.map((n) => `"${n}"`).join(", ")} — marked required by ` +
        `${appId}'s manifest. Aborting install.`,
      kept: capabilities,
      droppedOptional,
    };
  }
  return { abortMessage: null, kept, droppedOptional };
}
