/**
 * The cursor codec, pinned against Node's own implementation.
 *
 * This exists because the previous implementation *was* Node's own, and that is
 * exactly what broke: `Buffer` is a Node global, this package also runs under
 * Hermes on the phone, and the first library page with a second page to offer
 * threw `ReferenceError: Property 'Buffer' doesn't exist` — so the grid rendered
 * an error where the photographs go.
 *
 * The replacement assumes no globals at all, which means it has to be checked
 * against something. `Buffer` is the right oracle precisely because it is what
 * the servers used to produce: a token cut by a phone can be handed back to a
 * cloud data server, so the two have to agree byte for byte, and a cursor
 * already in flight has to keep decoding.
 */

import { describe, it, expect } from "vitest";
import { encodeBase64Url, decodeBase64Url } from "../src/database/base64url.js";
import { encodeQueryCursor, decodeQueryCursor } from "../src/database/query-cursor.js";
import type { StarkeepId } from "@starkeep/protocol-primitives";

/** What the old implementation produced, and what the servers still hold. */
function nodeEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("base64url", () => {
  const cases = [
    "",
    "a",
    "ab",
    "abc",
    "abcd",
    // The shape every cursor actually is.
    JSON.stringify(["capturedAt:desc,id:desc", [[0, "2026-07-06T14:53:56"]], "Z5MNNSWAHB0DDFX8"]),
    // A null key, which is what a record with no capture time encodes as.
    JSON.stringify(["capturedAt:desc,id:desc", [[1, null]], "Z2QEB2BRV0J0823P"]),
    // Non-ASCII, because a sort key can be a filename.
    "café",
    "日本語のファイル名.jpg",
    "emoji 📷 in a filename",
    // Every byte-length remainder, since base64 groups by three.
    "1",
    "12",
    "123",
    "1234",
    "12345",
  ];

  it("agrees with Node's encoder, byte for byte", () => {
    for (const text of cases) {
      expect(encodeBase64Url(text), `encoding ${JSON.stringify(text)}`).toBe(nodeEncode(text));
    }
  });

  it("round-trips everything it encodes", () => {
    for (const text of cases) {
      expect(decodeBase64Url(encodeBase64Url(text)), text).toBe(text);
    }
  });

  it("decodes what Node encoded, so cursors in flight keep working", () => {
    for (const text of cases) {
      expect(decodeBase64Url(nodeEncode(text))).toBe(text);
    }
  });

  it("emits no padding and nothing a query string would mangle", () => {
    // The tokens travel in query strings, where `+`, `/` and `=` do not survive
    // unescaped.
    for (let length = 0; length < 40; length += 1) {
      const token = encodeBase64Url("x".repeat(length));
      expect(token).not.toMatch(/[+/=]/);
    }
  });

  it("answers null for a token it did not produce", () => {
    // Null rather than a throw, matching every caller's contract: a hand-edited
    // cursor gets the first page, not a 500.
    expect(decodeBase64Url("not base64url!")).toBeNull();
    expect(decodeBase64Url("a b c")).toBeNull();
  });

  it("round-trips a whole query cursor, null keys included", () => {
    const cursor = {
      order: "capturedAt:desc,createdAt:desc,id:desc",
      keys: [
        { isNull: false, value: "2026-07-06T14:53:56" },
        { isNull: false, value: "0197e3a1b2c3-0001-phone" },
      ],
      id: "Z5MNNSWAHB0DDFX8XGYEJAXV0H" as StarkeepId,
    };
    const decoded = decodeQueryCursor(encodeQueryCursor(cursor), cursor.order);
    expect(decoded).toEqual(cursor);

    const withNulls = { ...cursor, keys: [{ isNull: true, value: null }] };
    expect(
      decodeQueryCursor(encodeQueryCursor(withNulls), cursor.order),
    ).toEqual(withNulls);
  });

  it("uses no global beyond the language itself", () => {
    // The actual regression guard. The module is read as text and checked for
    // the host objects that differ between Node and Hermes — which is the only
    // way to catch this from a test running in Node, where every one of them
    // exists and works.
    const source = readSource();
    for (const global of ["Buffer", "TextEncoder", "TextDecoder", "atob", "btoa"]) {
      expect(source, `base64url.ts must not reference ${global}`).not.toMatch(
        new RegExp(`(^|[^\\w.'\`])${global}\\s*[.(]`, "m"),
      );
    }
  });
});

function readSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  const path = fileURLToPath(new URL("../src/database/base64url.ts", import.meta.url));
  // Comments explain the ban and therefore name the things being banned; the
  // check is about code, so they come out first.
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}
