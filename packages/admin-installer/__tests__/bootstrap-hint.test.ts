/**
 * A cloud data server install that the foundational permissions boundary
 * refuses says to update the bootstrap. Every other failure reads unchanged.
 */
import { describe, expect, it } from "vitest";
import { withBootstrapHint } from "../src/builtin-installs";

describe("withBootstrapHint", () => {
  it("names update-bootstrap.sh when the boundary refused a call", () => {
    const err = new Error(
      "creating EventBridge Rule (starkeep-jobs-tick): AccessDeniedException: User: " +
        "arn:aws:sts::123:assumed-role/starkeep-app-cloud-data-server-role/x is not authorized " +
        "to perform: events:PutRule on resource: arn:aws:events:us-east-2:123:rule/starkeep-jobs-tick " +
        "because no permissions boundary allows the events:PutRule action",
    );
    const hinted = withBootstrapHint(err) as Error;
    expect(hinted.message).toMatch(/^This deployment's bootstrap predates/);
    expect(hinted.message).toContain("scripts/update-bootstrap.sh");
    expect(hinted.message).toContain(err.message);
  });

  it("leaves any other failure alone", () => {
    const err = new Error(
      "AccessDeniedException: no identity-based policy allows the s3:GetObject action",
    );
    expect(withBootstrapHint(err)).toBe(err);
    expect(withBootstrapHint("boom")).toBe("boom");
  });
});
