import { describe, it, expect } from "vitest";
import {
  parseDeniedCapabilities,
  applyCapabilityDenials,
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
