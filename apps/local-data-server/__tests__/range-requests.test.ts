/**
 * Byte-range serving.
 *
 * A `<video>` element does not download a file and play it; it seeks, by
 * issuing `Range` requests. So a server that answers 200-with-everything makes
 * a clip technically playable and practically unusable — the scrub bar is
 * disabled, and every seek re-downloads from zero. Safari goes further and
 * often refuses to start at all without a 206.
 *
 * The parsing cases below are the ones that fail *quietly*: a suffix range read
 * as a prefix returns real bytes from the wrong end of the file, under a status
 * code asserting they are the right ones.
 */
import { describe, it, expect } from "vitest";
import { parseRangeHeader } from "../range";

const SIZE = 1000;

describe("parsing a Range header", () => {
  it("reads a normal closed range inclusively at both ends", () => {
    // 0-99 is a hundred bytes, not ninety-nine. Every wire format involved
    // agrees on this and the internal type matches it, so nothing translates.
    expect(parseRangeHeader("bytes=0-99", SIZE)).toEqual({ start: 0, end: 99 });
  });

  // What a <video> element actually opens with. If this were treated as
  // malformed, every video would fall back to a full download.
  it("reads the open-ended form a video element opens with", () => {
    expect(parseRangeHeader("bytes=0-", SIZE)).toEqual({ start: 0 });
    expect(parseRangeHeader("bytes=500-", SIZE)).toEqual({ start: 500 });
  });

  // The classic mistake, and it does not fail loudly: read as a prefix this
  // returns plausible bytes from the wrong end, so a player asked for the
  // closing frames gets the opening ones.
  it("reads a suffix range as the LAST n bytes, not the first", () => {
    expect(parseRangeHeader("bytes=-500", SIZE)).toEqual({ start: 500, end: 999 });
  });

  // RFC 7233: a suffix longer than the file is satisfiable and means the whole
  // file. Rejecting it would break a client asking for "the last 10 MB" of a
  // 2 MB file, which is a perfectly ordinary thing to ask.
  it("treats an oversized suffix as the whole file rather than an error", () => {
    expect(parseRangeHeader("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  // Browsers routinely ask for a fixed-size chunk that overruns the end. A
  // literal read would contradict the Content-Length computed from the range.
  it("clamps an end that overruns the file", () => {
    expect(parseRangeHeader("bytes=900-9999", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("reports a start past the end as unsatisfiable, not as a clamp", () => {
    // Clamping here would serve the last byte to a client that asked for
    // something that does not exist — a 416 is the only honest answer.
    expect(parseRangeHeader("bytes=1000-", SIZE)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=5000-6000", SIZE)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=-0", SIZE)).toBe("unsatisfiable");
  });

  // Falling back to the whole object is always a *correct* response — it is
  // what a server without range support does. Guessing at a malformed range
  // would serve wrong bytes under a status code claiming they are right.
  it("falls back to the whole object rather than guessing at nonsense", () => {
    for (const header of [
      undefined,
      "",
      "bytes=abc-def",
      "bytes=-",
      "items=0-99",
      "bytes=99-0", // inverted
    ]) {
      expect(parseRangeHeader(header, SIZE), String(header)).toBeNull();
    }
  });

  // Legal, and requires a multipart/byteranges body. No video element sends
  // them, and 200-with-everything is the spec-sanctioned answer for a server
  // that does not support them — far better than serving only the first range
  // while implying it is the whole answer.
  it("declines multi-range requests instead of honouring only the first", () => {
    expect(parseRangeHeader("bytes=0-99,200-299", SIZE)).toBeNull();
  });

  it("ignores a repeated header, which cannot be a single coherent range", () => {
    expect(parseRangeHeader(["bytes=0-99", "bytes=200-299"], SIZE)).toBeNull();
  });
});
