/**
 * The protocol version an app's `protocolMinVersion` is checked against.
 */
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  parseProtocolVersion,
  protocolSatisfies,
} from "../src/protocol-version/index.js";

describe("PROTOCOL_VERSION", () => {
  it("is a well-formed version", () => {
    expect(parseProtocolVersion(PROTOCOL_VERSION)).not.toBeNull();
  });
});

describe("protocolSatisfies", () => {
  it("accepts a platform at or past the required version within one major", () => {
    expect(protocolSatisfies("1.0.0", "1.0.0")).toBe(true);
    expect(protocolSatisfies("1.0.0", "1.3.0")).toBe(true);
    expect(protocolSatisfies("1.2.1", "1.2.4")).toBe(true);
  });

  it("refuses an older platform", () => {
    expect(protocolSatisfies("1.1.0", "1.0.0")).toBe(false);
    expect(protocolSatisfies("1.2.4", "1.2.1")).toBe(false);
  });

  it("refuses a different major in either direction", () => {
    expect(protocolSatisfies("1.0.0", "2.0.0")).toBe(false);
    expect(protocolSatisfies("2.0.0", "1.9.0")).toBe(false);
  });

  it("refuses a malformed version", () => {
    expect(protocolSatisfies("1.0", "1.0.0")).toBe(false);
    expect(protocolSatisfies("1.0.0", "")).toBe(false);
  });
});
