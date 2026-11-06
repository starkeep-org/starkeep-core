/**
 * The cloud-data-server role's inline policies must fit AWS's quota together.
 *
 * IAM caps the inline policies of one role at 10,240 characters in total,
 * whitespace excluded. During an install the role holds three: the standing
 * runtime and broker-power policies, and the temp-install policy, which is the
 * largest by far. Before the custom domain the three came to within 14
 * characters of the quota at the default prefix, so any new install-time grant
 * has to make room. Over the quota, PutRolePolicy refuses the temp policy and
 * the install stops before it changes anything.
 *
 * A custom domain's record-name condition grows with the domain's length, and
 * a change of domain names two domains, so the quota caps how long a domain
 * can be. These cases are the ones that must keep fitting.
 */
import { describe, expect, it } from "vitest";
import { MAX_STACK_PREFIX_LENGTH } from "@starkeep/aws-bootstrap";
import { buildTempInstallCloudDataServerPolicy, buildRuntimePolicy } from "../src/temp-policies";
import { buildBrokerPowerPolicy } from "../src/iam";

const ROLE_INLINE_POLICY_QUOTA = 10_240;
const ACCOUNT_ID = "111122223333";

function inlineTotal(stackPrefix: string, region: string, customDomains: string[]): number {
  const size = (doc: string) => doc.replace(/\s/g, "").length;
  return (
    size(buildRuntimePolicy(stackPrefix, "cloud-data-server", [], false, false)) +
    size(buildBrokerPowerPolicy(stackPrefix, ACCOUNT_ID)) +
    size(buildTempInstallCloudDataServerPolicy(stackPrefix, ACCOUNT_ID, region, customDomains))
  );
}

describe("cloud-data-server role inline policies", () => {
  it("fit with no custom domain at the longest allowed prefix", () => {
    const prefix = "x".repeat(MAX_STACK_PREFIX_LENGTH);
    expect(inlineTotal(prefix, "ap-southeast-2", [])).toBeLessThanOrEqual(ROLE_INLINE_POLICY_QUOTA);
  });

  it("fit with one custom domain at the longest allowed prefix", () => {
    const prefix = "x".repeat(MAX_STACK_PREFIX_LENGTH);
    expect(inlineTotal(prefix, "ap-southeast-2", ["photos.koller-family.com"])).toBeLessThanOrEqual(
      ROLE_INLINE_POLICY_QUOTA,
    );
  });

  it("fit during a change of domain at the default prefix", () => {
    expect(
      inlineTotal("starkeep", "us-east-2", ["photos.koller-family.com", "aaron.starkeep.app"]),
    ).toBeLessThanOrEqual(ROLE_INLINE_POLICY_QUOTA);
  });
});
