/**
 * The deprecation notice for the flat `order` spelling (STA-101).
 *
 * Both data servers call `flatOrderDeprecation` once per request, so its
 * answer decides the `Deprecation` header and the log line on both.
 */

import { describe, it, expect } from "vitest";
import { FLAT_ORDER_DEPRECATED_AT, flatOrderDeprecation } from "../src/query/index.js";

function collect(): { warn: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (message) => lines.push(message), lines };
}

describe("flatOrderDeprecation", () => {
  it("answers the flat spelling with a Deprecation header and a link to the guide", () => {
    const { warn } = collect();
    const headers = flatOrderDeprecation("due.desc", "app-header", warn);
    expect(headers).not.toBeNull();
    expect(headers!["Deprecation"]).toBe(FLAT_ORDER_DEPRECATED_AT);
    expect(FLAT_ORDER_DEPRECATED_AT).toBe("@1794960000");
    expect(headers!["Link"]).toMatch(/authoring-an-app\.md>; rel="deprecation"$/);
  });

  it("answers the JSON spelling and an absent order with nothing", () => {
    const { warn, lines } = collect();
    expect(flatOrderDeprecation('[{"col":"due","dir":"desc"}]', "app-json", warn)).toBeNull();
    expect(flatOrderDeprecation('  [{"col":"due"}]', "app-json", warn)).toBeNull();
    expect(flatOrderDeprecation(undefined, "app-json", warn)).toBeNull();
    expect(flatOrderDeprecation("  ", "app-json", warn)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("logs once per app, and names the app and the spelling it sent", () => {
    const { warn, lines } = collect();
    flatOrderDeprecation("due.desc", "app-once", warn);
    flatOrderDeprecation("title.asc", "app-once", warn);
    flatOrderDeprecation("due.desc", "app-other", warn);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"app-once"');
    expect(lines[0]).toContain('order="due.desc"');
    expect(lines[0]).toContain("STA-101");
    expect(lines[1]).toContain('"app-other"');
  });

  it("still sends the header on every request after the first", () => {
    const { warn } = collect();
    flatOrderDeprecation("due.desc", "app-repeat", warn);
    expect(flatOrderDeprecation("due.desc", "app-repeat", warn)).not.toBeNull();
  });
});
