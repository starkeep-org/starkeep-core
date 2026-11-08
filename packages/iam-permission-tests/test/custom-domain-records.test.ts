/**
 * An install that names a custom domain may write that domain's own records,
 * and no other record in any zone the account holds.
 *
 * The temp policy grants `route53:ChangeResourceRecordSets` on every zone,
 * because the installer learns the zone only after the policy is attached. The
 * record-name condition is what keeps the grant to the domain itself, for the
 * alias records, and `_*.<domain>`, for ACM's validation record. A change batch
 * touching any other name — the apex of a parent zone, a sibling, a deeper
 * record that is not a validation record — must be refused, or a bug in the
 * program could rewrite a record the operator owns.
 */
import { describe, expect, test } from "vitest";
import { CUSTOM_DOMAIN, buildContext } from "../src/contexts";
import { simulateOne } from "../src/simulate";

const INPUT = { stackPrefix: "starkeep", accountId: "000000000000", region: "us-east-2" };
const ZONE = "arn:aws:route53:::hostedzone/ZONE1";
const NAMES = "route53:ChangeResourceRecordSetsNormalizedRecordNames";

async function verdict(contextName: string, names: string[]) {
  const ctx = buildContext(contextName, INPUT);
  const r = await simulateOne(ctx, INPUT.accountId, "route53:ChangeResourceRecordSets", ZONE, {
    [NAMES]: names,
  });
  return r.verdict;
}

describe("install-cloud-data-server-custom-domain", () => {
  test.each([
    ["the parent zone's apex", ["starkeep.app"]],
    ["a sibling", ["memo.starkeep.app"]],
    ["a deeper name that is not a validation record", [`www.${CUSTOM_DOMAIN}`]],
    ["a batch mixing the domain with another name", [CUSTOM_DOMAIN, "starkeep.app"]],
  ])("refuses %s", async (_label, names) => {
    expect(await verdict("install-cloud-data-server-custom-domain", names)).toBe(
      "ImplicitlyDenied",
    );
  });
});

describe("install-cloud-data-server, naming no domain", () => {
  test("holds no record grant at all", async () => {
    expect(await verdict("install-cloud-data-server", [CUSTOM_DOMAIN])).toBe("ImplicitlyDenied");
  });
});
