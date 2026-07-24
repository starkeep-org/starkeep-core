/**
 * Tier-3 gated PoC: session-policy downscoping for the capability broker's
 * S3-location I/O path (plan §3.4 / §7 step 1 — the de-risk-first gate).
 *
 * Inert unless STARKEEP_AWS_TESTS=1 (like the journey suite), and separate from
 * the journey so it can be run on its own — it needs no bootstrap stack, only
 * ambient AWS creds with IAM+S3+STS authority:
 *
 *   STARKEEP_AWS_TESTS=1 pnpm --filter @starkeep/e2e-aws poc:s3
 *
 * The single test asserts the whole finding (TC1 downscoping works, TC2 standing
 * role is broad, TC3 session policy cannot grant) and prints the plan-level
 * verdict, so a green run IS the "S3-location path viable" sign-off §7 asks for.
 */

import { describe, it, expect } from "vitest";
import { AWS_TESTS_ENABLED } from "./env.js";
import { runS3SessionPolicyPoc } from "./s3-session-policy-poc.js";

(AWS_TESTS_ENABLED ? describe : describe.skip)("capability broker — S3 session-policy PoC", () => {
  it("session-policy downscoping narrows s3:GetObject to a single key", async () => {
    const result = await runS3SessionPolicyPoc();

    // Human-readable record in the run log — the operator's actual sign-off.
    // eslint-disable-next-line no-console
    console.log(
      `\n[s3-session-policy-poc] account=${result.account} region=${result.region} bucket=${result.bucket}\n` +
        result.cases
          .map((c) => `  ${c.passed ? "PASS" : "FAIL"}  ${c.name}\n        ${c.what}\n        → ${c.detail}`)
          .join("\n") +
        `\n\n  VERDICT: ${result.verdict}\n`,
    );

    for (const c of result.cases) {
      expect(c.passed, `${c.name} — ${c.detail}`).toBe(true);
    }
    expect(result.allPassed).toBe(true);
  });
});
