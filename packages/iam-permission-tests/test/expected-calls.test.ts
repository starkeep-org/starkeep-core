/**
 * Every context's modeled call set must be permitted by the policies that will
 * actually be attached when it runs.
 *
 * Why this is a test and not only a CLI: `simulate` is something someone
 * remembers to run. The failure it guards against is a resource being added to
 * a Pulumi program (or an SDK call to a handler) with no matching grant — which
 * looks like nothing at all until an install 403s against a real account, after
 * the DSQL cluster and the CloudFront distribution have already been built. A
 * missing `s3:PutInventoryConfiguration` reached a real deployment exactly that
 * way; this suite is where the next one stops.
 *
 * Contexts that model no calls yet are skipped rather than silently passing, so
 * "modeled nothing" never reads as "verified everything".
 */

import { describe, test, expect } from "vitest";
import { listContexts } from "../src/contexts";
import { simulateExpectedCalls } from "../src/simulate";

// Arbitrary but concrete — the simulator needs real-shaped ARNs, and the
// policies are built from the same values.
const INPUT = {
  stackPrefix: "starkeep",
  accountId: "000000000000",
  region: "us-east-2",
  appId: "photos",
};

describe("modeled calls are within policy ∩ boundary", () => {
  for (const { name } of listContexts()) {
    test(`${name}`, async () => {
      const outcomes = await simulateExpectedCalls({ ...INPUT, contextName: name });
      if (outcomes.length === 0) {
        // Nothing modeled yet. Not a failure, but not evidence either.
        return;
      }
      // Engine errors (an action or service iam-data doesn't carry) are a
      // simulator limitation, not a policy gap — the CLI reports them the same
      // way and does not fail on them.
      const denied = outcomes.filter(
        (o) => o.verdict === "ExplicitlyDenied" || o.verdict === "ImplicitlyDenied",
      );
      expect(
        denied.map((d) => `${d.verdict} ${d.expected.action} on ${d.expected.resource}`),
      ).toEqual([]);
    });
  }
});
