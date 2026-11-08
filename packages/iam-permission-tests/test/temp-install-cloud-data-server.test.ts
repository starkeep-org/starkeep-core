/**
 * What the cloud-data-server role's install-time grants must still refuse.
 *
 * The temp policy reads bucket settings through `s3:GetBucket*` and
 * `s3:Get*Configuration`. IAM's `*` in a resource ARN spans `/`, so the bucket
 * glob `<prefix>-billing-*` also matches every object in the bucket; only the
 * action patterns keep object reads out. A plain `s3:Get*` would have reached
 * the cost reports and every noncurrent version in the files bucket.
 *
 * The install may delete only this deployment's certificates. The installer
 * filters on the `starkeep:stackPrefix` tag too, but the grant's condition is
 * what holds when that filter has a bug.
 */
import { describe, expect, test } from "vitest";
import { buildContext } from "../src/contexts";
import { simulateOne } from "../src/simulate";

const INPUT = { stackPrefix: "starkeep", accountId: "000000000000", region: "us-east-2" };
const BILLING_OBJECT = "arn:aws:s3:::starkeep-billing-000000000000-us-east-2/cur/report.csv.gz";
const CERTIFICATE = "arn:aws:acm:us-east-1:000000000000:certificate/0000-cert";
const TAG = "aws:ResourceTag/starkeep:stackPrefix";

async function verdict(
  contextName: string,
  action: string,
  resource: string,
  contextVariables?: Record<string, string>,
) {
  const ctx = buildContext(contextName, INPUT);
  return (await simulateOne(ctx, INPUT.accountId, action, resource, contextVariables)).verdict;
}

describe("install-cloud-data-server", () => {
  test.each(["s3:GetObject", "s3:GetObjectVersion"])(
    "refuses %s on a billing object",
    async (a) => {
      expect(await verdict("install-cloud-data-server", a, BILLING_OBJECT)).toBe(
        "ImplicitlyDenied",
      );
    },
  );
});

describe("install-cloud-data-server-custom-domain: acm:DeleteCertificate", () => {
  const context = "install-cloud-data-server-custom-domain";

  test("allows a certificate tagged with this deployment's prefix", async () => {
    expect(
      await verdict(context, "acm:DeleteCertificate", CERTIFICATE, { [TAG]: "starkeep" }),
    ).toBe("Allowed");
  });

  test("refuses a certificate tagged with another prefix", async () => {
    expect(await verdict(context, "acm:DeleteCertificate", CERTIFICATE, { [TAG]: "other" })).toBe(
      "ImplicitlyDenied",
    );
  });

  test("refuses a certificate with no prefix tag", async () => {
    expect(await verdict(context, "acm:DeleteCertificate", CERTIFICATE)).toBe("ImplicitlyDenied");
  });
});
