import { describe, expect, it } from "vitest";
import { textMetrics } from "../src/text-metrics.js";

describe("textMetrics", () => {
  it("counts nothing in an empty file", () => {
    expect(textMetrics("")).toEqual({ line_count: 0, word_count: 0, char_count: 0 });
  });

  it("counts a last line with or without its newline once", () => {
    expect(textMetrics("one two\nthree").line_count).toBe(2);
    expect(textMetrics("one two\nthree\n").line_count).toBe(2);
    expect(textMetrics("a\r\nb\rc").line_count).toBe(3);
  });

  it("counts words as runs of non-whitespace", () => {
    expect(textMetrics("  one\ttwo\n\nthree  ").word_count).toBe(3);
  });

  it("counts characters as code points", () => {
    expect(textMetrics("héllo 🌍").char_count).toBe(7);
  });
});
