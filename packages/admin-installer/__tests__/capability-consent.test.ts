import { describe, it, expect } from "vitest";
import {
  parseDeniedCapabilities,
  applyCapabilityDenials,
  resolveConsentedCapabilities,
} from "../src/capability-consent";

type Cap = { name: string; required: boolean };

const caps: Cap[] = [
  { name: "bedrock.invoke", required: false },
  { name: "rekognition.detect", required: true },
  { name: "polly.synthesize", required: false },
];

describe("parseDeniedCapabilities", () => {
  it("splits, trims, and drops empties", () => {
    expect([...parseDeniedCapabilities(" a , b ,,c ")]).toEqual(["a", "b", "c"]);
  });

  it("returns an empty set for undefined / blank", () => {
    expect(parseDeniedCapabilities(undefined).size).toBe(0);
    expect(parseDeniedCapabilities("   ").size).toBe(0);
  });
});

describe("applyCapabilityDenials", () => {
  it("keeps everything when nothing is denied", () => {
    const r = applyCapabilityDenials(caps, new Set());
    expect(r.kept).toEqual(caps);
    expect(r.droppedOptional).toEqual([]);
    expect(r.droppedRequired).toEqual([]);
  });

  it("drops a denied OPTIONAL capability and reports it", () => {
    const r = applyCapabilityDenials(caps, new Set(["bedrock.invoke"]));
    expect(r.kept.map((c) => c.name)).toEqual(["rekognition.detect", "polly.synthesize"]);
    expect(r.droppedOptional).toEqual(["bedrock.invoke"]);
    expect(r.droppedRequired).toEqual([]);
  });

  it("flags a denied REQUIRED capability rather than silently dropping it (must abort)", () => {
    const r = applyCapabilityDenials(caps, new Set(["rekognition.detect"]));
    // Surfaced in droppedRequired so the caller aborts the install; it is never
    // reported as a plain optional drop that the install would proceed past.
    expect(r.droppedRequired).toEqual(["rekognition.detect"]);
    expect(r.droppedOptional).toEqual([]);
  });

  it("classifies a mixed denial set (optional dropped, required flagged)", () => {
    const r = applyCapabilityDenials(
      caps,
      new Set(["bedrock.invoke", "rekognition.detect", "polly.synthesize"]),
    );
    expect(r.droppedOptional.sort()).toEqual(["bedrock.invoke", "polly.synthesize"]);
    expect(r.droppedRequired).toEqual(["rekognition.detect"]);
  });

  it("ignores denial names that don't match any declared capability", () => {
    const r = applyCapabilityDenials(caps, new Set(["nonexistent.cap"]));
    expect(r.kept).toEqual(caps);
    expect(r.droppedOptional).toEqual([]);
    expect(r.droppedRequired).toEqual([]);
  });
});

/**
 * The whole CLI-side decision: raw env value in, the set to install (or an abort)
 * out. This is what `cli-install-app.ts` runs; the abort branch is the only thing
 * standing between "operator denied a required capability" and an install that
 * quietly ships without it.
 */
describe("resolveConsentedCapabilities (the installer's consent step)", () => {
  it("passes the declared set straight through when the env var is unset", () => {
    const r = resolveConsentedCapabilities(caps, undefined, "photos");
    expect(r.abortMessage).toBeNull();
    expect(r.kept).toBe(caps); // untouched, not a rebuilt copy
    expect(r.droppedOptional).toEqual([]);
  });

  it("treats a blank / comma-only env value as no denials", () => {
    for (const raw of ["", "   ", ",,,"]) {
      const r = resolveConsentedCapabilities(caps, raw, "photos");
      expect(r.abortMessage).toBeNull();
      expect(r.kept).toEqual(caps);
    }
  });

  it("drops a denied OPTIONAL capability so no grant row is written", () => {
    const r = resolveConsentedCapabilities(caps, "bedrock.invoke", "photos");
    expect(r.abortMessage).toBeNull();
    expect(r.kept.map((c) => c.name)).toEqual(["rekognition.detect", "polly.synthesize"]);
    expect(r.droppedOptional).toEqual(["bedrock.invoke"]);
  });

  it("parses a comma-separated list with whitespace", () => {
    const r = resolveConsentedCapabilities(caps, " bedrock.invoke , polly.synthesize ", "photos");
    expect(r.kept.map((c) => c.name)).toEqual(["rekognition.detect"]);
    expect(r.droppedOptional).toEqual(["bedrock.invoke", "polly.synthesize"]);
  });

  it("ABORTS on a denied REQUIRED capability, naming the app and the capability", () => {
    const r = resolveConsentedCapabilities(caps, "rekognition.detect", "photos");
    expect(r.abortMessage).toContain("Cannot deny required capability");
    expect(r.abortMessage).toContain('"rekognition.detect"');
    expect(r.abortMessage).toContain("photos");
    expect(r.abortMessage).toContain("Aborting install");
  });

  it("does NOT silently install-minus-required: the kept set is never the trimmed one on abort", () => {
    const r = resolveConsentedCapabilities(caps, "rekognition.detect", "photos");
    // The caller exits on abortMessage; even if it didn't, `kept` is the full
    // declared set, so a required capability can never be silently dropped.
    expect(r.kept).toEqual(caps);
  });

  it("aborts when a mixed denial set touches even one required capability", () => {
    const r = resolveConsentedCapabilities(caps, "bedrock.invoke,rekognition.detect", "photos");
    expect(r.abortMessage).not.toBeNull();
  });

  it("pluralizes the abort message for multiple required denials", () => {
    const twoRequired = [
      { name: "a.one", required: true },
      { name: "b.two", required: true },
    ];
    const r = resolveConsentedCapabilities(twoRequired, "a.one,b.two", "photos");
    expect(r.abortMessage).toContain("Cannot deny required capabilities");
    expect(r.abortMessage).toContain('"a.one", "b.two"');
  });

  it("handles an app that declares no capabilities at all", () => {
    const r = resolveConsentedCapabilities([], "bedrock.invoke", "photos");
    expect(r.abortMessage).toBeNull();
    expect(r.kept).toEqual([]);
    expect(r.droppedOptional).toEqual([]);
  });

  it("ignores a denial for a capability the app never declared", () => {
    const r = resolveConsentedCapabilities(caps, "nonexistent.cap", "photos");
    expect(r.abortMessage).toBeNull();
    expect(r.kept).toEqual(caps);
    expect(r.droppedOptional).toEqual([]);
  });
});
