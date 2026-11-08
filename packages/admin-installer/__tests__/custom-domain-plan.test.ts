/**
 * The install's custom-domain decisions, as plain functions. Mocking every
 * client inside installCloudDataServer would test the mocks; these functions
 * hold the choices the install makes from what it found.
 *
 * The rule that matters most: an external domain becomes canonical only once
 * public DNS sends it to the distribution. Until then, links and signed URLs
 * must keep the cloudfront.net name, because the custom name resolves nowhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveCname = vi.fn<(name: string) => Promise<string[]>>();
const resolve4 = vi.fn<(name: string) => Promise<string[]>>();
vi.mock("node:dns", () => ({
  promises: {
    resolveCname: (n: string) => resolveCname(n),
    resolve4: (n: string) => resolve4(n),
  },
}));

const { certificateOnDistribution, domainPointsAt, planCustomDomain, signingHosts } =
  await import("../src/custom-domain");
type CustomDomainStatus = import("../src/custom-domain").CustomDomainStatus;

const RECORD = { name: "_abc.photos.example.com.", type: "CNAME", value: "_x.acm." };
const PENDING = { certificateArn: "arn:cert", issued: false, validationRecord: RECORD };
const ISSUED = { ...PENDING, issued: true };

describe("planCustomDomain", () => {
  it("attaches nothing and reports nothing when the install names no domain", () => {
    expect(planCustomDomain({ zone: null, pointsAtDistribution: false })).toEqual({
      canonical: false,
    });
  });

  it("takes Route53 mode for a zone in the account, canonical in the same run", () => {
    expect(
      planCustomDomain({
        name: "aaron.starkeep.app",
        zone: { id: "ZONE1", name: "starkeep.app" },
        pointsAtDistribution: false,
      }),
    ).toEqual({
      program: { name: "aaron.starkeep.app", mode: "route53", hostedZoneId: "ZONE1" },
      canonical: true,
      status: {
        name: "aaron.starkeep.app",
        mode: "route53",
        status: "active",
        hostedZoneId: "ZONE1",
      },
    });
  });

  it("attaches nothing while the external certificate awaits validation", () => {
    expect(
      planCustomDomain({
        name: "photos.example.com",
        zone: null,
        certificate: PENDING,
        pointsAtDistribution: false,
      }),
    ).toEqual({
      canonical: false,
      status: {
        name: "photos.example.com",
        mode: "external",
        status: "pending-validation",
        validationRecord: RECORD,
        certificateArn: "arn:cert",
      },
    });
  });

  it("attaches an issued certificate but stays off the domain until DNS points at it", () => {
    const plan = planCustomDomain({
      name: "photos.example.com",
      zone: null,
      certificate: ISSUED,
      pointsAtDistribution: false,
    });
    expect(plan.program).toEqual({
      name: "photos.example.com",
      mode: "external",
      certificateArn: "arn:cert",
      canonical: false,
    });
    expect(plan.canonical).toBe(false);
    expect(plan.status?.status).toBe("awaiting-dns");
  });

  it("makes an issued external domain canonical once DNS points at the distribution", () => {
    const plan = planCustomDomain({
      name: "photos.example.com",
      zone: null,
      certificate: ISSUED,
      pointsAtDistribution: true,
    });
    expect(plan.program).toMatchObject({ mode: "external", canonical: true });
    expect(plan.canonical).toBe(true);
    expect(plan.status?.status).toBe("active");
  });
});

describe("planCustomDomain with a certificate already on the distribution", () => {
  const HELD_ROUTE53 = { name: "old.example.com", mode: "route53" as const, hostedZoneId: "ZONE1" };
  const HELD_EXTERNAL = {
    name: "old.example.com",
    mode: "external" as const,
    certificateArn: "arn:old",
  };

  it("keeps a Route53-mode certificate with no alias after a removal", () => {
    expect(
      planCustomDomain({ zone: null, pointsAtDistribution: false, held: HELD_ROUTE53 }),
    ).toEqual({
      program: {
        name: "old.example.com",
        mode: "route53",
        hostedZoneId: "ZONE1",
        detached: true,
      },
      canonical: false,
      kept: HELD_ROUTE53,
    });
  });

  it("keeps an external certificate with no alias after a removal", () => {
    expect(
      planCustomDomain({ zone: null, pointsAtDistribution: false, held: HELD_EXTERNAL }),
    ).toEqual({
      program: {
        name: "old.example.com",
        mode: "external",
        certificateArn: "arn:old",
        canonical: false,
        detached: true,
      },
      canonical: false,
      kept: HELD_EXTERNAL,
    });
  });

  it("keeps the old certificate while a new external one awaits validation", () => {
    const plan = planCustomDomain({
      name: "photos.example.com",
      zone: null,
      certificate: PENDING,
      pointsAtDistribution: false,
      held: HELD_ROUTE53,
    });
    expect(plan.program).toMatchObject({ name: "old.example.com", detached: true });
    expect(plan.kept).toEqual(HELD_ROUTE53);
    expect(plan.status).toMatchObject({ name: "photos.example.com", status: "pending-validation" });
  });

  it("swaps the held certificate out when a new domain attaches", () => {
    for (const held of [HELD_ROUTE53, HELD_EXTERNAL]) {
      const route53 = planCustomDomain({
        name: "photos.example.com",
        zone: { id: "ZONE2", name: "example.com" },
        pointsAtDistribution: false,
        held,
      });
      expect(route53.program).toEqual({
        name: "photos.example.com",
        mode: "route53",
        hostedZoneId: "ZONE2",
      });
      expect(route53.kept).toBeUndefined();
      const external = planCustomDomain({
        name: "photos.example.com",
        zone: null,
        certificate: ISSUED,
        pointsAtDistribution: true,
        held,
      });
      expect(external.program).toMatchObject({ name: "photos.example.com", canonical: true });
      expect(external.program?.detached).toBeUndefined();
      expect(external.kept).toBeUndefined();
    }
  });

  it("refuses to keep a Route53-mode certificate whose zone is unknown", () => {
    expect(() =>
      planCustomDomain({
        zone: null,
        pointsAtDistribution: false,
        held: { name: "old.example.com", mode: "route53" },
      }),
    ).toThrow(/No Route53 zone/);
  });
});

describe("certificateOnDistribution", () => {
  const status = (s: Partial<CustomDomainStatus>): CustomDomainStatus => ({
    name: "old.example.com",
    mode: "external",
    status: "active",
    certificateArn: "arn:old",
    aliasTarget: "d1.cloudfront.net",
    ...s,
  });

  it("names the attached domain's certificate", () => {
    expect(certificateOnDistribution(status({}), undefined)).toEqual({
      name: "old.example.com",
      mode: "external",
      certificateArn: "arn:old",
    });
    expect(
      certificateOnDistribution(
        status({
          mode: "route53",
          status: "active",
          hostedZoneId: "ZONE1",
          certificateArn: undefined,
        }),
        undefined,
      ),
    ).toEqual({ name: "old.example.com", mode: "route53", hostedZoneId: "ZONE1" });
  });

  it("falls back to the kept certificate while a new external one is pending", () => {
    const kept = { name: "older.example.com", mode: "route53" as const, hostedZoneId: "ZONE1" };
    expect(certificateOnDistribution(status({ status: "pending-validation" }), kept)).toEqual(kept);
    expect(certificateOnDistribution(undefined, kept)).toEqual(kept);
    expect(certificateOnDistribution(status({ status: "pending-validation" }), undefined)).toBe(
      undefined,
    );
  });
});

describe("signingHosts", () => {
  it("lists the canonical custom domain first, then the cloudfront.net name", () => {
    expect(signingHosts("photos.example.com", "d1.cloudfront.net", "photos.example.com")).toEqual([
      "photos.example.com",
      "d1.cloudfront.net",
    ]);
  });

  it("keeps an attached domain that is not canonical yet, so sign-in works on it", () => {
    expect(signingHosts("d1.cloudfront.net", "d1.cloudfront.net", "photos.example.com")).toEqual([
      "d1.cloudfront.net",
      "photos.example.com",
    ]);
  });

  it("lists the cloudfront.net name once when no domain is attached", () => {
    expect(signingHosts("d1.cloudfront.net", "d1.cloudfront.net")).toEqual(["d1.cloudfront.net"]);
  });
});

describe("domainPointsAt", () => {
  beforeEach(() => {
    resolveCname.mockReset();
    resolve4.mockReset();
  });

  it("accepts a CNAME to the distribution, whatever its case and trailing dot", async () => {
    resolveCname.mockResolvedValue(["D1.CloudFront.net."]);
    expect(await domainPointsAt("photos.example.com", "d1.cloudfront.net")).toBe(true);
  });

  it("accepts a flattened record that resolves to the distribution's addresses", async () => {
    resolveCname.mockRejectedValue(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
    resolve4.mockImplementation(async (n) =>
      n === "photos.example.com" ? ["1.1.1.1"] : ["1.1.1.1", "2.2.2.2"],
    );
    expect(await domainPointsAt("photos.example.com", "d1.cloudfront.net")).toBe(true);
  });

  it("refuses a CNAME to a different distribution", async () => {
    resolveCname.mockResolvedValue(["d2.cloudfront.net"]);
    resolve4.mockImplementation(async (n) =>
      n === "photos.example.com" ? ["3.3.3.3"] : ["1.1.1.1"],
    );
    expect(await domainPointsAt("photos.example.com", "d1.cloudfront.net")).toBe(false);
  });

  it("refuses a name that does not resolve", async () => {
    resolveCname.mockRejectedValue(new Error("ENOTFOUND"));
    resolve4.mockRejectedValue(new Error("ENOTFOUND"));
    expect(await domainPointsAt("photos.example.com", "d1.cloudfront.net")).toBe(false);
  });
});
