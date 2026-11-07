/**
 * Admin-app reads ACM certificates for admin-web's "Check now", and only in
 * us-east-1, the one region CloudFront takes certificates from. The modeled
 * calls in expected-calls cover the allowed side; this covers the refusal.
 */
import { describe, expect, test } from "vitest";
import { buildContext } from "../src/contexts";
import { simulateOne } from "../src/simulate";

const INPUT = { stackPrefix: "starkeep", accountId: "000000000000", region: "us-east-2" };

describe("admin-app: ACM reads", () => {
  test.each(["acm:DescribeCertificate", "acm:ListCertificates"])(
    "refuses %s outside us-east-1",
    async (action) => {
      const ctx = buildContext("admin-app", INPUT);
      const r = await simulateOne(ctx, INPUT.accountId, action, "*", {
        "aws:RequestedRegion": "us-east-2",
      });
      expect(r.verdict).toBe("ImplicitlyDenied");
    },
  );

  test.each(["acm:DescribeCertificate", "acm:ListCertificates"])(
    "allows %s in us-east-1",
    async (action) => {
      const ctx = buildContext("admin-app", INPUT);
      const r = await simulateOne(ctx, INPUT.accountId, action, "*", {
        "aws:RequestedRegion": "us-east-1",
      });
      expect(r.verdict).toBe("Allowed");
    },
  );
});
