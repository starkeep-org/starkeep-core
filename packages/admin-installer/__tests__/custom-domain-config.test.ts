/**
 * The custom domain across installs: which names an install's grants cover,
 * and what `~/.starkeep/config.json` records between runs.
 *
 * A failed first attach can leave a certificate and records that only the
 * attempted name's grants can delete. `customDomainStatus` names only what a
 * successful install reported, so the config also records the attempt, from
 * before the install touches AWS until an install succeeds.
 */
import { describe, expect, it } from "vitest";
import { customDomainsInPlay, ownDistributionDomains } from "../src/builtin-installs";
import {
  customDomainInstallInput,
  nextCustomDomainConfig,
  type CustomDomainStatus,
} from "../src/custom-domain";
import { buildTempInstallCloudDataServerPolicy } from "../src/temp-policies";

const STATUS: CustomDomainStatus = {
  name: "old.example.com",
  mode: "route53",
  status: "active",
  aliasTarget: "d1.cloudfront.net",
};

describe("customDomainsInPlay", () => {
  it("normalizes each name and removes repeats", () => {
    expect(
      customDomainsInPlay({
        customDomain: "Photos.Example.com.",
        previousCustomDomain: "photos.example.com",
      }),
    ).toEqual(["photos.example.com"]);
  });

  it("drops a name that is not a valid host", () => {
    expect(
      customDomainsInPlay({ customDomain: "*.example.com", previousCustomDomain: "a.example.com" }),
    ).toEqual(["a.example.com"]);
  });

  it("includes an attempted domain beside the current and previous ones", () => {
    expect(
      customDomainsInPlay({
        customDomain: "new.example.com",
        previousCustomDomain: "old.example.com",
        attemptedCustomDomain: "failed.example.com",
      }),
    ).toEqual(["new.example.com", "old.example.com", "failed.example.com"]);
  });

  it("is empty when no install names a domain", () => {
    expect(customDomainsInPlay({})).toEqual([]);
  });
});

describe("the uninstall's certificate sweep", () => {
  const sids = (sweepCertificates: boolean) =>
    (
      JSON.parse(
        buildTempInstallCloudDataServerPolicy("sk", "111122223333", "us-east-2", [], {
          sweepCertificates,
        }),
      ) as { Statement: Array<{ Sid: string }> }
    ).Statement.map((s) => s.Sid);

  it("grants the certificate reads and tagged deletes with no domain in play", () => {
    expect(sids(true)).toEqual(
      expect.arrayContaining([
        "TempInstallCustomDomain",
        "TempInstallCustomDomainDeleteCertificate",
      ]),
    );
    expect(sids(true)).not.toContain("TempInstallCustomDomainRecords");
  });

  it("grants nothing of the custom domain to an install with no domain in play", () => {
    expect(sids(false).filter((sid) => sid.startsWith("TempInstallCustomDomain"))).toEqual([]);
  });
});

describe("a config holding only an attempted domain", () => {
  it("still yields that domain's grants in the temp policy", () => {
    const input = customDomainInstallInput({ customDomainAttempted: "failed.example.com" });
    const policy = JSON.parse(
      buildTempInstallCloudDataServerPolicy(
        "sk",
        "111122223333",
        "us-east-2",
        customDomainsInPlay(input),
      ),
    ) as { Statement: Array<{ Sid: string; Condition?: Record<string, Record<string, unknown>> }> };
    const records = policy.Statement.find((s) => s.Sid === "TempInstallCustomDomainRecords");
    expect(
      records?.Condition?.["ForAllValues:StringLike"]?.[
        "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      ],
    ).toEqual(["failed.example.com", "_*.failed.example.com"]);
  });
});

describe("nextCustomDomainConfig", () => {
  it("records the domain as attempted before the install starts", () => {
    expect(
      nextCustomDomainConfig(
        { stackPrefix: "sk", customDomain: "new.example.com", customDomainStatus: STATUS },
        { stage: "starting" },
      ),
    ).toEqual({
      stackPrefix: "sk",
      customDomain: "new.example.com",
      customDomainStatus: STATUS,
      customDomainAttempted: "new.example.com",
    });
  });

  it("replaces the attempt with the install's status on success", () => {
    const next = nextCustomDomainConfig(
      {
        customDomain: "new.example.com",
        customDomainAttempted: "new.example.com",
        customDomainStatus: STATUS,
      },
      { stage: "succeeded", status: { ...STATUS, name: "new.example.com" } },
    );
    expect(next).toEqual({
      customDomain: "new.example.com",
      customDomainStatus: { ...STATUS, name: "new.example.com" },
    });
    expect("customDomainAttempted" in next).toBe(false);
  });

  it("drops the status and records the kept certificate after a successful removal", () => {
    const kept = { name: "old.example.com", mode: "route53" as const, hostedZoneId: "ZONE1" };
    const next = nextCustomDomainConfig(
      { customDomainStatus: STATUS },
      { stage: "succeeded", kept },
    );
    expect("customDomainStatus" in next).toBe(false);
    expect(next.customDomainKept).toEqual(kept);
  });

  it("drops the kept certificate once a new domain swaps it out", () => {
    const next = nextCustomDomainConfig(
      { customDomainKept: { name: "old.example.com", mode: "external" as const } },
      { stage: "succeeded", status: { ...STATUS, name: "new.example.com" } },
    );
    expect("customDomainKept" in next).toBe(false);
  });

  it("keeps the attempt and the old status after a failure", () => {
    const before = {
      customDomain: "new.example.com",
      customDomainAttempted: "new.example.com",
      customDomainStatus: STATUS,
    };
    expect(nextCustomDomainConfig(before, { stage: "failed" })).toEqual(before);
  });

  it("passes a failed attempt on to the next run after the operator clears the domain", () => {
    // The first run failed part-way through attaching new.example.com.
    const afterFailure = nextCustomDomainConfig(
      { customDomain: "new.example.com" },
      { stage: "starting" },
    );
    // The operator clears the domain in admin-web, and the next run starts.
    const { customDomain: _cleared, ...cleared } = afterFailure;
    const starting = nextCustomDomainConfig(cleared, { stage: "starting" });
    expect(starting.customDomainAttempted).toBe("new.example.com");
    expect(customDomainsInPlay(customDomainInstallInput(starting))).toEqual(["new.example.com"]);
  });
});

describe("customDomainInstallInput", () => {
  it("maps the config onto the install and uninstall input", () => {
    expect(
      customDomainInstallInput({
        customDomain: "new.example.com",
        customDomainStatus: STATUS,
        customDomainAttempted: "failed.example.com",
        cloudfrontDomain: "d1.cloudfront.net",
      }),
    ).toEqual({
      customDomain: "new.example.com",
      previousCustomDomain: "old.example.com",
      attemptedCustomDomain: "failed.example.com",
      heldCertificate: { name: "old.example.com", mode: "route53", hostedZoneId: undefined },
      cloudfrontDomain: "d1.cloudfront.net",
    });
  });

  it("holds the kept certificate after a removal, and keeps its domain in play", () => {
    const kept = { name: "old.example.com", mode: "route53" as const, hostedZoneId: "ZONE1" };
    const input = customDomainInstallInput({ customDomainKept: kept });
    expect(input.heldCertificate).toEqual(kept);
    expect(customDomainsInPlay(input)).toEqual(["old.example.com"]);
  });

  it("treats an empty domain as none", () => {
    expect(customDomainInstallInput({ customDomain: "" }).customDomain).toBeUndefined();
  });
});

describe("ownDistributionDomains", () => {
  it("takes the distribution's name from state and from the last install, once each", () => {
    expect(
      ownDistributionDomains(
        [
          {
            urn: "urn:pulumi:sk-cloud-data-server::sk-builtins::aws:cloudfront/distribution:Distribution::sk-cdn",
            type: "aws:cloudfront/distribution:Distribution",
            outputs: { domainName: "d1.cloudfront.net" },
          },
          { urn: "urn:x", type: "aws:s3/bucketV2:BucketV2", outputs: { bucket: "b" } },
        ],
        "d1.cloudfront.net",
      ),
    ).toEqual(["d1.cloudfront.net"]);
  });

  it("covers a first install that failed before the config learned the name", () => {
    expect(
      ownDistributionDomains([
        {
          urn: "urn:d",
          type: "aws:cloudfront/distribution:Distribution",
          outputs: { domainName: "d2.cloudfront.net" },
        },
      ]),
    ).toEqual(["d2.cloudfront.net"]);
  });
});
