/**
 * The job enrollment paths on the connections page.
 */
import { describe, expect, it } from "vitest";
import {
  jobRevokePath,
  jobSchedulePath,
  parseConnectionRevokePath,
  parseJobActionPath,
} from "../src/index.js";

describe("job action paths", () => {
  it("round-trips both actions", () => {
    expect(parseJobActionPath(jobRevokePath("abc_DEF-1"))).toEqual({
      enrollmentId: "abc_DEF-1",
      action: "revoke",
    });
    expect(parseJobActionPath(jobSchedulePath("abc"))).toEqual({
      enrollmentId: "abc",
      action: "schedule",
    });
  });

  it("refuses other paths", () => {
    expect(parseJobActionPath("/connections/abc/revoke")).toBeNull();
    expect(parseJobActionPath("/connections/jobs/a.b/revoke")).toBeNull();
    expect(parseJobActionPath("/connections/jobs/abc/delete")).toBeNull();
    expect(parseJobActionPath("/connections/jobs//revoke")).toBeNull();
  });

  it("never reads as a delegation's revoke path", () => {
    expect(parseConnectionRevokePath(jobRevokePath("abc"))).toBeNull();
  });
});
