/**
 * What a responder accepts off the wire.
 *
 * The exchange body used to be `JSON.parse` straight into `transport.exchange`,
 * where its numbers reach a `LIMIT ?`, a byte budget and a
 * `substr(updated_at, 1, N)`. These cases pin the two different answers: a
 * caller asking for *more than it may have* is clamped, a caller sending
 * something that cannot be read at all is refused by name.
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeExchangeRequest,
  InvalidExchangeRequest,
  DEFAULT_RESPONDER_MAX_ITEMS,
  DEFAULT_RESPONDER_MAX_BYTES,
} from "../src/exchange-request.js";

const hlc = { wallTime: 5, counter: 1, nodeId: "L" };

describe("budgets are clamped, not rejected", () => {
  it("caps a limit larger than the responder's own maximum", () => {
    const request = sanitizeExchangeRequest({ watermarks: {}, limit: 1e9 });
    expect(request.limit).toBe(DEFAULT_RESPONDER_MAX_ITEMS);
  });

  it("caps maxBytes the same way", () => {
    const request = sanitizeExchangeRequest({ watermarks: {}, maxBytes: 1e12 });
    expect(request.maxBytes).toBe(DEFAULT_RESPONDER_MAX_BYTES);
  });

  it("honours a responder that advertises different maxima", () => {
    const request = sanitizeExchangeRequest(
      { watermarks: {}, limit: 500, maxBytes: 1e9 },
      { maxItems: 50, maxBytes: 1024 },
    );
    expect(request.limit).toBe(50);
    expect(request.maxBytes).toBe(1024);
  });

  it("floors a negative limit to zero rather than passing it through", () => {
    // Zero is already the fail-safe reading — `collectSince` pins every
    // author's ceiling to null and the round ships nothing — so this keeps the
    // existing behaviour while making it something the code says out loud.
    expect(sanitizeExchangeRequest({ watermarks: {}, limit: -1 }).limit).toBe(0);
  });

  it("keeps a budget the caller is entitled to", () => {
    const request = sanitizeExchangeRequest({ watermarks: {}, limit: 10, maxBytes: 2048 });
    expect(request.limit).toBe(10);
    expect(request.maxBytes).toBe(2048);
  });

  it("leaves an absent budget absent, which means the responder's default", () => {
    const request = sanitizeExchangeRequest({ watermarks: {} });
    expect(request.limit).toBeUndefined();
    expect(request.maxBytes).toBeUndefined();
  });

  it("refuses a budget that is not a finite number", () => {
    for (const limit of ["5", Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
      expect(() => sanitizeExchangeRequest({ watermarks: {}, limit })).toThrow(
        InvalidExchangeRequest,
      );
    }
  });
});

describe("shapes that cannot be read are refused", () => {
  it("rejects a body that is not an object", () => {
    for (const body of ["{}", 5, null, [], true]) {
      expect(() => sanitizeExchangeRequest(body)).toThrow(InvalidExchangeRequest);
    }
  });

  it("rejects watermarks that are not an object", () => {
    expect(() => sanitizeExchangeRequest({ watermarks: [] })).toThrow(
      /"watermarks" must be an object/,
    );
  });

  it("rejects a watermark value that is not an HLC, naming the author", () => {
    expect(() =>
      sanitizeExchangeRequest({ watermarks: { L: "5:0:L" } }),
    ).toThrow(/watermarks\[L\]/);
    expect(() =>
      sanitizeExchangeRequest({ watermarks: { L: { wallTime: 5, counter: 1 } } }),
    ).toThrow(/watermarks\[L\]/);
  });

  it("keeps only the three HLC fields, so nothing extra rides along", () => {
    const request = sanitizeExchangeRequest({
      watermarks: { L: { ...hlc, injected: "surprise" } },
    });
    expect(request.watermarks["L"]).toEqual(hlc);
  });

  it("treats missing watermarks as an empty map", () => {
    expect(sanitizeExchangeRequest({}).watermarks).toEqual({});
  });

  it("rejects a payload field that is not an array", () => {
    for (const field of ["records", "labels", "appSyncableRows"]) {
      expect(() =>
        sanitizeExchangeRequest({ watermarks: {}, [field]: { id: "x" } }),
      ).toThrow(new RegExp(`"${field}" must be an array`));
    }
  });

  it("passes array payloads through untouched — their elements are the applier's business", () => {
    const records = [{ id: "r1" }];
    const request = sanitizeExchangeRequest({ watermarks: {}, records });
    expect(request.records).toBe(records);
  });

  it("rejects a non-boolean requestDigest", () => {
    expect(() =>
      sanitizeExchangeRequest({ watermarks: {}, requestDigest: "yes" }),
    ).toThrow(/"requestDigest" must be a boolean/);
  });
});

describe("digestPrefixLength is dropped rather than refused", () => {
  it("keeps a width in range", () => {
    expect(
      sanitizeExchangeRequest({ watermarks: {}, digestPrefixLength: 5 })
        .digestPrefixLength,
    ).toBe(5);
  });

  it("drops anything unusable, so the responder falls back to its own width", () => {
    // The requester compares the echoed width against what it asked for and
    // refuses to compare on a mismatch, so a dropped value already resolves
    // itself one layer up — there is nothing an error would add.
    for (const value of ["x", 0, -3, 99, 5.5, {}, null]) {
      expect(
        sanitizeExchangeRequest({ watermarks: {}, digestPrefixLength: value })
          .digestPrefixLength,
      ).toBeUndefined();
    }
  });
});
