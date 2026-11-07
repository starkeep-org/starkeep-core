/**
 * The suite's own safety checks, without AWS: the dedicated-zone test that
 * refuses a live zone, and the writer that refuses any record outside the run.
 */
import { describe, expect, it } from "vitest";
import { TestZoneWriter, foreignToSuite, normalizeName, recordsAtOrUnder } from "./zone.js";

const ZONE = "e2e.example.com";
const rs = (name: string, type: string) => ({ Name: `${name}.`, Type: type as never });

describe("foreignToSuite", () => {
  it("accepts the apex NS and SOA records and any run's records", () => {
    expect(
      foreignToSuite(
        [
          rs(ZONE, "NS"),
          rs(ZONE, "SOA"),
          rs(`sktest-a1b2c3.${ZONE}`, "A"),
          rs(`_0123abcd.sktest-a1b2c3-b.${ZONE}`, "CNAME"),
        ],
        ZONE,
        "sktest",
      ),
    ).toEqual([]);
  });

  it("names everything else, so a live zone is refused", () => {
    expect(
      foreignToSuite(
        [
          rs(ZONE, "A"),
          rs(`www.${ZONE}`, "A"),
          rs(`starkeep-a1b2c3.${ZONE}`, "A"),
          rs(`sktestx.${ZONE}`, "A"),
          rs("elsewhere.example.org", "A"),
        ],
        ZONE,
        "sktest",
      ),
    ).toEqual([
      `A ${ZONE}`,
      `A www.${ZONE}`,
      `A starkeep-a1b2c3.${ZONE}`,
      `A sktestx.${ZONE}`,
      "A elsewhere.example.org",
    ]);
  });
});

describe("recordsAtOrUnder", () => {
  it("finds the name and its validation records, not its siblings", () => {
    const sets = [
      rs(`sktest-a1.${ZONE}`, "A"),
      rs(`_x.sktest-a1.${ZONE}`, "CNAME"),
      rs(`sktest-a1-b.${ZONE}`, "A"),
      rs(`xsktest-a1.${ZONE}`, "A"),
    ];
    expect(recordsAtOrUnder(sets, `sktest-a1.${ZONE}`).map((r) => r.Name)).toEqual([
      `sktest-a1.${ZONE}.`,
      `_x.sktest-a1.${ZONE}.`,
    ]);
  });
});

describe("normalizeName", () => {
  it("reads Route53's escaped wildcard, case and trailing dot", () => {
    expect(normalizeName("\\052.Example.COM.")).toBe("*.example.com");
  });
});

describe("TestZoneWriter", () => {
  const writer = new TestZoneWriter({ id: "Z1", name: ZONE }, "sktest-a1b2c3");
  const record = (name: string) => ({
    Name: `${name}.`,
    Type: "A" as const,
    TTL: 60,
    ResourceRecords: [{ Value: "192.0.2.1" }],
  });

  it.each([
    ["the test zone's apex", ZONE],
    ["another name in the test zone", `www.${ZONE}`],
    ["another run's name", `sktest-ffffff.${ZONE}`],
    ["a name outside the test zone", "sktest-a1b2c3.example.com"],
    ["a parent zone's name that merely contains the prefix", `sktest-a1b2c3.${ZONE}.evil.com`],
  ])("refuses %s before any request", async (_label, name) => {
    await expect(writer.create(record(name))).rejects.toThrow(/refusing to write/);
    await expect(writer.delete(record(name))).rejects.toThrow(/refusing to write/);
  });
});
