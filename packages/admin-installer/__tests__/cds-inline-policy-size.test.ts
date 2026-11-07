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
import {
  ROLE_INLINE_POLICY_QUOTA,
  cloudDataServerInlinePolicySize as inlineTotal,
  customDomainPolicyFits,
} from "../src/iam";
import { buildTempInstallCloudDataServerPolicy } from "../src/temp-policies";
import { validateCustomDomain } from "../src/custom-domain";

/** The longest region name, which the Pulumi state bucket's name embeds. */
const LONGEST_REGION = "ap-southeast-2";
const LONGEST_PREFIX = "x".repeat(MAX_STACK_PREFIX_LENGTH);

/** A valid host name of exactly `length` characters (at least 6). */
function domainOf(length: number, tag = "a"): string {
  const labels: string[] = [];
  let left = length - ".com".length;
  while (left > 0) {
    // Never leave a single character, which a dot alone would have to fill.
    const label = left > 63 ? (left - 63 === 1 ? 61 : 63) : left;
    labels.push(tag.repeat(label));
    left -= label + 1;
  }
  return validateCustomDomain(`${labels.join(".")}.com`);
}

describe("cloud-data-server role inline policies", () => {
  it("fit with no custom domain at the longest allowed prefix", () => {
    expect(inlineTotal(LONGEST_PREFIX, LONGEST_REGION, [])).toBeLessThanOrEqual(
      ROLE_INLINE_POLICY_QUOTA,
    );
  });

  it("fit with one 253-character domain, the longest DNS allows", () => {
    const domain = domainOf(253);
    expect(domain).toHaveLength(253);
    expect(customDomainPolicyFits(LONGEST_PREFIX, LONGEST_REGION, [domain])).toBe(true);
  });

  it("fit during a change between two domains totalling 250 characters", () => {
    const first = domainOf(125, "a");
    const second = domainOf(125, "b");
    expect(first.length + second.length).toBe(250);
    expect(customDomainPolicyFits(LONGEST_PREFIX, LONGEST_REGION, [first, second])).toBe(true);
  });

  it("refuse two 253-character domains, so the installer must check", () => {
    expect(
      customDomainPolicyFits(LONGEST_PREFIX, LONGEST_REGION, [
        domainOf(253, "a"),
        domainOf(253, "b"),
      ]),
    ).toBe(false);
  });
});

describe("temp-install S3 statements", () => {
  type Statement = { Sid: string; Action: string[]; Resource: string | string[] };
  const statements = (
    JSON.parse(buildTempInstallCloudDataServerPolicy("starkeep", "111122223333", "us-east-2")) as {
      Statement: Statement[];
    }
  ).Statement;
  const bySid = (sid: string) => statements.find((s) => s.Sid === sid)!;

  it("give the billing bucket its own statement with the pre-PR verb set", () => {
    const billing = bySid("TempInstallBillingBucket");
    expect(billing.Resource).toBe("arn:aws:s3:::starkeep-billing-*");
    expect([...billing.Action].sort()).toEqual(
      [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:ListBucket",
        "s3:GetBucket*",
        "s3:Get*Configuration",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutBucketTagging",
        "s3:PutBucketVersioning",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketOwnershipControls",
        "s3:PutEncryptionConfiguration",
      ].sort(),
    );
  });

  it("hold the files-bucket statement to the files bucket", () => {
    expect(bySid("TempInstallS3Bucket").Resource).toBe("arn:aws:s3:::starkeep-files-*");
  });

  it("read bucket settings through patterns that admit no object action", () => {
    for (const s of statements) {
      for (const action of [s.Action].flat()) {
        expect(action, s.Sid).not.toBe("s3:Get*");
      }
    }
  });
});
