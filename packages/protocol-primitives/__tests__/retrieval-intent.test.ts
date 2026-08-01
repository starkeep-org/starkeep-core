import { describe, it, expect } from "vitest";
import {
  isRetrievalIntent,
  tagsForIntent,
  DEFAULT_RETRIEVAL_INTENT,
  RETRIEVAL_INTENTS,
  INTENT_TAG_KEY,
  LADDER_TAG_KEY,
  LADDER_TAG_COMPLETE,
} from "../src/storage/retrieval-intent.js";

describe("retrieval intent vocabulary", () => {
  // The cost of a wrong default in one direction is money; in the other it is
  // a user waiting half a day for a photo, having never asked for that trade.
  it("defaults to instant", () => {
    expect(DEFAULT_RETRIEVAL_INTENT).toBe("instant");
  });

  it("accepts exactly the two declared intents", () => {
    expect([...RETRIEVAL_INTENTS].sort()).toEqual(["archive", "instant"]);
    expect(isRetrievalIntent("instant")).toBe(true);
    expect(isRetrievalIntent("archive")).toBe(true);
  });

  // The vocabulary is deliberately about tolerable latency, not about tiers.
  // A caller reaching for a provider concept is a caller that has escaped the
  // abstraction, and must be refused rather than accommodated.
  it.each(["INSTANT", "Archive", "glacier", "DEEP_ARCHIVE", "cool", "standard", ""])(
    "rejects %s",
    (value) => {
      expect(isRetrievalIntent(value)).toBe(false);
    },
  );
});

describe("tagsForIntent", () => {
  it("tags an archive write with the intent tag", () => {
    expect(tagsForIntent("archive")).toEqual({ [INTENT_TAG_KEY]: "archive" });
  });

  // An untagged object is *structurally* ineligible for the archive lifecycle
  // rule, which is a stronger guarantee than one depending on a rule reading a
  // value correctly. Tagging `intent=instant` would make the safety of every
  // instant object depend on the rule's filter being written the right way
  // round.
  it("gives an instant write no tag at all", () => {
    expect(tagsForIntent("instant")).toEqual({});
  });
});

describe("tag vocabulary", () => {
  // These strings are written by the presign path and read by the bucket's
  // lifecycle rule, which live in different packages. A drift is silent in both
  // directions: objects that never transition (a bill nobody notices) or —
  // worse — objects that transition before their ladder is complete, putting
  // the only readable copy of something behind a 48-hour thaw.
  it("namespaces both tags so they cannot collide with a user's own", () => {
    expect(INTENT_TAG_KEY).toBe("starkeep:intent");
    expect(LADDER_TAG_KEY).toBe("starkeep:ladder");
  });

  it("names the ladder-complete value the lifecycle rule will filter on", () => {
    expect(LADDER_TAG_COMPLETE).toBe("complete");
  });
});
