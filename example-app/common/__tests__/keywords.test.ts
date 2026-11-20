import { describe, expect, it } from "vitest";
import { keywordsOf } from "../src/keywords.js";

describe("keywordsOf", () => {
  it("ranks words by count, and breaks a tie by first appearance", () => {
    expect(keywordsOf("Flour and water. More flour, then water, then flour. Salt.")).toEqual([
      "flour",
      "water",
      "more",
    ]);
  });

  it("skips short words and stop words, and ignores case", () => {
    expect(keywordsOf("The cat sat with THAT Kettle; the kettle hums.")).toEqual([
      "kettle",
      "hums",
    ]);
  });

  it("keeps an apostrophe inside a word, and letters outside ASCII", () => {
    expect(keywordsOf("Don't panic. Crème brûlée, crème fraîche.")).toEqual([
      "crème",
      "don't",
      "panic",
    ]);
  });

  it("answers no keywords for text without a long enough word", () => {
    expect(keywordsOf("")).toEqual([]);
    expect(keywordsOf("a b c 1234 the cat")).toEqual([]);
  });
});
