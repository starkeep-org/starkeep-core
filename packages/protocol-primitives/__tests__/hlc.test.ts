import { describe, it, expect } from "vitest";
import { createHLCClock } from "../src/hlc/clock.js";
import { compareHLC, maxHLC } from "../src/hlc/compare.js";
import { serializeHLC, deserializeHLC } from "../src/hlc/serialize.js";
import type { HLCTimestamp } from "../src/hlc/types.js";

describe("HLC Clock", () => {
  it("should generate timestamps with the correct nodeId", () => {
    const clock = createHLCClock({ nodeId: "node-1" });
    const timestamp = clock.now();
    expect(timestamp.nodeId).toBe("node-1");
  });

  it("should advance wall time when physical clock advances", () => {
    let time = 1000;
    const clock = createHLCClock({ nodeId: "node-1", wallClockFunction: () => time });

    const timestamp1 = clock.now();
    expect(timestamp1.wallTime).toBe(1000);
    expect(timestamp1.counter).toBe(0);

    time = 2000;
    const timestamp2 = clock.now();
    expect(timestamp2.wallTime).toBe(2000);
    expect(timestamp2.counter).toBe(0);
  });

  it("should increment counter when wall time is unchanged", () => {
    const clock = createHLCClock({ nodeId: "node-1", wallClockFunction: () => 1000 });

    const timestamp1 = clock.now();
    expect(timestamp1.counter).toBe(0);

    const timestamp2 = clock.now();
    expect(timestamp2.counter).toBe(1);

    const timestamp3 = clock.now();
    expect(timestamp3.counter).toBe(2);
  });

  it("send() should behave like now()", () => {
    let time = 1000;
    const clock = createHLCClock({ nodeId: "node-1", wallClockFunction: () => time });
    const timestamp = clock.send();
    expect(timestamp.wallTime).toBe(1000);
    expect(timestamp.nodeId).toBe("node-1");
  });

  describe("receive()", () => {
    it("should adopt remote wall time when it is greater", () => {
      const clock = createHLCClock({ nodeId: "node-1", wallClockFunction: () => 1000 });
      clock.now(); // initialize local state

      const remote: HLCTimestamp = { wallTime: 2000, counter: 5, nodeId: "node-2" };
      const timestamp = clock.receive(remote);

      expect(timestamp.wallTime).toBe(2000);
      expect(timestamp.counter).toBe(6);
      expect(timestamp.nodeId).toBe("node-1");
    });

    it("should use max counter + 1 when wall times match", () => {
      const clock = createHLCClock({ nodeId: "node-1", wallClockFunction: () => 1000 });
      clock.now(); // counter = 0

      const remote: HLCTimestamp = { wallTime: 1000, counter: 5, nodeId: "node-2" };
      const timestamp = clock.receive(remote);

      expect(timestamp.wallTime).toBe(1000);
      expect(timestamp.counter).toBe(6);
    });

    it("should use physical time when it exceeds both local and remote", () => {
      let time = 1000;
      const clock = createHLCClock({ nodeId: "node-1", wallClockFunction: () => time });
      clock.now(); // wallTime=1000, counter=0

      time = 3000;
      const remote: HLCTimestamp = { wallTime: 2000, counter: 10, nodeId: "node-2" };
      const timestamp = clock.receive(remote);

      expect(timestamp.wallTime).toBe(3000);
      expect(timestamp.counter).toBe(0);
    });
  });
});

describe("compareHLC", () => {
  it("should order by wall time first", () => {
    const a: HLCTimestamp = { wallTime: 1000, counter: 0, nodeId: "a" };
    const b: HLCTimestamp = { wallTime: 2000, counter: 0, nodeId: "a" };
    expect(compareHLC(a, b)).toBe(-1);
    expect(compareHLC(b, a)).toBe(1);
  });

  it("should order by counter when wall times match", () => {
    const a: HLCTimestamp = { wallTime: 1000, counter: 0, nodeId: "a" };
    const b: HLCTimestamp = { wallTime: 1000, counter: 1, nodeId: "a" };
    expect(compareHLC(a, b)).toBe(-1);
    expect(compareHLC(b, a)).toBe(1);
  });

  it("should order by nodeId when wall time and counter match", () => {
    const a: HLCTimestamp = { wallTime: 1000, counter: 0, nodeId: "a" };
    const b: HLCTimestamp = { wallTime: 1000, counter: 0, nodeId: "b" };
    expect(compareHLC(a, b)).toBe(-1);
    expect(compareHLC(b, a)).toBe(1);
  });

  it("should return 0 for equal timestamps", () => {
    const a: HLCTimestamp = { wallTime: 1000, counter: 0, nodeId: "a" };
    const b: HLCTimestamp = { wallTime: 1000, counter: 0, nodeId: "a" };
    expect(compareHLC(a, b)).toBe(0);
  });
});

describe("maxHLC", () => {
  it("should return the greater timestamp", () => {
    const a: HLCTimestamp = { wallTime: 1000, counter: 0, nodeId: "a" };
    const b: HLCTimestamp = { wallTime: 2000, counter: 0, nodeId: "a" };
    expect(maxHLC(a, b)).toBe(b);
    expect(maxHLC(b, a)).toBe(b);
  });
});

describe("HLC serialization", () => {
  it("should round-trip serialize/deserialize", () => {
    const timestamp: HLCTimestamp = { wallTime: 1700000000000, counter: 42, nodeId: "node-abc123" };
    const serialized = serializeHLC(timestamp);
    const deserialized = deserializeHLC(serialized);

    expect(deserialized.wallTime).toBe(timestamp.wallTime);
    expect(deserialized.counter).toBe(timestamp.counter);
    expect(deserialized.nodeId).toBe(timestamp.nodeId);
  });

  it("should produce sortable serialized strings", () => {
    const a: HLCTimestamp = { wallTime: 1000, counter: 0, nodeId: "a" };
    const b: HLCTimestamp = { wallTime: 2000, counter: 0, nodeId: "a" };
    expect(serializeHLC(a) < serializeHLC(b)).toBe(true);
  });

  it("should throw on invalid serialized strings", () => {
    expect(() => deserializeHLC("invalid")).toThrow("Invalid HLC timestamp string");
  });

  it("should pad wall time and counter to fixed widths", () => {
    const timestamp: HLCTimestamp = { wallTime: 1, counter: 1, nodeId: "n" };
    const serialized = serializeHLC(timestamp);
    const parts = serialized.split(":");
    expect(parts[0]).toHaveLength(12);
    expect(parts[1]).toHaveLength(4);
  });
});
