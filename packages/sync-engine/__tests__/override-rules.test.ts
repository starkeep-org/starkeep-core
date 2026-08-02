/**
 * Per-record residency overrides as rules over labels.
 *
 * The reason these exist rather than a list of pinned ids: "keep every photo of
 * my daughter offline" is one sentence and five thousand records, and pinning
 * ids evaluates that intent once, at pin time — so every photo taken afterwards
 * silently falls outside it. A rule is evaluated against whatever the record
 * carries now.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateOverrides,
  validateOverrideRules,
  NO_OVERRIDES,
  type OverrideRule,
  type RecordLabel,
} from "../src/override-rules.js";

const label = (key: string, value?: string | null): RecordLabel => ({
  appId: "photos",
  key,
  ...(value !== undefined ? { value } : {}),
});

const rule = (over: Partial<OverrideRule> = {}): OverrideRule => ({
  appId: "photos",
  key: "faces",
  value: "Alice",
  effect: "pin",
  ...over,
});

describe("matching a rule against labels", () => {
  it("pins a record carrying the labelled value", () => {
    const verdict = evaluateOverrides([rule()], [label("faces", "Alice")]);
    expect(verdict.pinned).toBe(true);
    expect(verdict.matched).toHaveLength(1);
  });

  it("ignores a record with a different value of the same key", () => {
    expect(evaluateOverrides([rule()], [label("faces", "Bob")])).toEqual(NO_OVERRIDES);
  });

  it("ignores an identical key from another app", () => {
    // Another app's `faces` says nothing about Photos' people.
    const other: RecordLabel = { appId: "someotherapp", key: "faces", value: "Alice" };
    expect(evaluateOverrides([rule()], [other]).pinned).toBe(false);
  });

  // The distinction is load-bearing. `face-count` is published only when a
  // photo has faces, so a keyless rule means "any photo with a face"; `faces`
  // carries a person's name, so a keyless rule there would match every photo of
  // anybody — emphatically not what somebody writing a rule about one person
  // meant.
  it("matches a key's presence when the rule names no value", () => {
    const anyFace = rule({ key: "face-count", value: undefined });
    expect(evaluateOverrides([anyFace], [label("face-count", "3")]).pinned).toBe(true);
    expect(evaluateOverrides([anyFace], [label("face-count", "1")]).pinned).toBe(true);
  });

  it("does not treat a valueless label as matching a rule that names a value", () => {
    // "has no value" is not "has this value".
    expect(evaluateOverrides([rule()], [label("faces", null)]).pinned).toBe(false);
    expect(evaluateOverrides([rule()], [label("faces")]).pinned).toBe(false);
  });

  it("reports nothing for a record with no labels", () => {
    expect(evaluateOverrides([rule()], [])).toEqual(NO_OVERRIDES);
  });

  it("reports nothing when there are no rules", () => {
    expect(evaluateOverrides([], [label("faces", "Alice")])).toEqual(NO_OVERRIDES);
  });
});

describe("excluding", () => {
  it("excludes a record matching an exclude rule", () => {
    const verdict = evaluateOverrides(
      [rule({ key: "face-count", value: undefined, effect: "exclude" })],
      [label("face-count", "2")],
    );
    expect(verdict.excluded).toBe(true);
    expect(verdict.pinned).toBe(false);
  });

  // Restrictive wins — the same ordering decideResidency already applies
  // between record constraints and pins, for the same reason: the direction
  // holding fewer bytes cannot surprise anybody with a full disk.
  it("lets exclude beat pin when both match", () => {
    const verdict = evaluateOverrides(
      [rule(), rule({ key: "screenshots", value: undefined, effect: "exclude" })],
      [label("faces", "Alice"), label("screenshots", "true")],
    );
    expect(verdict.excluded).toBe(true);
    expect(verdict.pinned, "a pinned-and-excluded record must not report as pinned").toBe(false);
  });

  // Reporting both and leaving the caller to re-derive precedence is how two
  // callers end up disagreeing about the same record.
  it("resolves the precedence rather than reporting both", () => {
    const verdict = evaluateOverrides(
      [rule(), rule({ effect: "exclude" })],
      [label("faces", "Alice")],
    );
    expect(verdict.pinned).toBe(false);
    expect(verdict.excluded).toBe(true);
  });
});

describe("explaining a decision", () => {
  // `matched` is what lets the residency inspector answer "why is this record
  // still here". A list that stopped at the first hit would name a rule that
  // might not be the one that decided the outcome.
  it("reports every rule that matched, not just the first", () => {
    const verdict = evaluateOverrides(
      [rule(), rule({ key: "face-count", value: undefined })],
      [label("faces", "Alice"), label("face-count", "1")],
    );
    expect(verdict.matched).toHaveLength(2);
  });
});

describe("validating a rule set", () => {
  it("accepts a well-formed set", () => {
    expect(validateOverrideRules([rule()])).toEqual([]);
  });

  it("requires an app and a key", () => {
    expect(validateOverrideRules([rule({ appId: "" })])[0]).toMatch(/appId/);
    expect(validateOverrideRules([rule({ key: "" })])[0]).toMatch(/key/);
  });

  // Almost always a UI that submitted a blank field, and it means something
  // quite different from omitting it: it matches only labels whose value is
  // literally empty, which nothing writes. A rule that silently matches nothing
  // is worse than one that is rejected.
  it("rejects an empty-string value rather than saving a rule that matches nothing", () => {
    expect(validateOverrideRules([rule({ value: "" })])[0]).toMatch(/omit it entirely/);
  });

  it("names a duplicate rather than applying it twice", () => {
    expect(validateOverrideRules([rule(), rule()]).some((p) => /duplicate/.test(p))).toBe(true);
  });

  // The exclude wins, so the pin is dead. Better to say so than to let an
  // operator believe something is being kept when it is not.
  it("warns when a pin is shadowed by an exclude on the same selector", () => {
    const problems = validateOverrideRules([rule(), rule({ effect: "exclude" })]);
    expect(problems.some((p) => /no effect/.test(p))).toBe(true);
  });

  it("names the rule by its note when it has one, so a list is readable", () => {
    expect(validateOverrideRules([rule({ appId: "", note: "Keep Alice offline" })])[0]).toContain(
      "Keep Alice offline",
    );
  });

  // Returned rather than thrown so a UI can show every problem at once instead
  // of making the operator fix them one save at a time.
  it("reports every problem, not the first", () => {
    expect(validateOverrideRules([rule({ appId: "", key: "" })]).length).toBeGreaterThan(1);
  });
});
