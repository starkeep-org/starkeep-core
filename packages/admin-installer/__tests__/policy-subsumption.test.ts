/**
 * The one matcher behind check-temp-vs-boundary and the symmetry test. Both
 * sides may hold a wildcard: the temp policy reads S3 bucket settings through
 * `s3:GetBucket*` and `s3:Get*Configuration`, and the foundational boundary
 * caps them with the same patterns.
 */
import { describe, it, expect } from "vitest";
import { actionCovers, uncoveredActions } from "../src/policy-subsumption";

describe("actionCovers", () => {
  it("covers an equal action, and anything under a bare *", () => {
    expect(actionCovers("s3:GetObject", "s3:GetObject")).toBe(true);
    expect(actionCovers("*", "s3:GetBucket*")).toBe(true);
  });

  it("compares without regard to case, as IAM does", () => {
    expect(actionCovers("s3:getobject", "s3:GetObject")).toBe(true);
  });

  it("covers a temp wildcard with an equal boundary wildcard", () => {
    expect(actionCovers("s3:GetBucket*", "s3:GetBucket*")).toBe(true);
  });

  it("covers a temp wildcard with a wider boundary wildcard", () => {
    expect(actionCovers("s3:Get*", "s3:GetBucket*")).toBe(true);
    expect(actionCovers("s3:Get*", "s3:Get*Configuration")).toBe(true);
  });

  it("refuses a temp wildcard wider than the boundary's", () => {
    expect(actionCovers("s3:GetBucket*", "s3:Get*")).toBe(false);
    expect(actionCovers("s3:Get*Configuration", "s3:Get*")).toBe(false);
  });

  it("covers an enumerated action with an infix boundary wildcard", () => {
    expect(actionCovers("s3:Get*Configuration", "s3:GetLifecycleConfiguration")).toBe(true);
  });

  it("refuses an enumerated action outside the boundary's patterns", () => {
    const boundary = [
      { Effect: "Allow" as const, Action: ["s3:GetBucket*", "s3:Get*Configuration"] },
    ];
    const policy = (action: string) => ({
      Statement: [{ Sid: "T", Effect: "Allow" as const, Action: [action] }],
    });
    expect(uncoveredActions(policy("s3:GetObject"), boundary)).toEqual([
      { sid: "T", action: "s3:GetObject" },
    ]);
    expect(uncoveredActions(policy("s3:GetBucketPolicy"), boundary)).toEqual([]);
    expect(uncoveredActions(policy("s3:GetLifecycleConfiguration"), boundary)).toEqual([]);
  });

  it("ignores Deny statements on either side", () => {
    const boundary = [
      { Effect: "Deny" as const, Action: "s3:*" },
      { Effect: "Allow" as const, Action: "s3:GetBucket*" },
    ];
    const policy = {
      Statement: [
        { Effect: "Deny" as const, Action: "iam:*" },
        { Effect: "Allow" as const, Action: "s3:GetBucketTagging" },
      ],
    };
    expect(uncoveredActions(policy, boundary)).toEqual([]);
  });
});
