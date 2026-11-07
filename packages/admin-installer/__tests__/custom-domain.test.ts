/**
 * The custom domain's work outside the Pulumi program: checking the name,
 * finding a zone that serves it, and the external-mode certificate's life.
 *
 * The mode decision rests on findHostedZone, so a zone that public DNS does not
 * delegate to must not count: route53 mode would write the validation record
 * where ACM never looks, and the install would wait out the validation timeout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
} from "@aws-sdk/client-acm";
import {
  GetHostedZoneCommand,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from "@aws-sdk/client-route-53";

const resolveNs = vi.fn<(name: string) => Promise<string[]>>();
vi.mock("node:dns", () => ({ promises: { resolveNs: (n: string) => resolveNs(n) } }));

const {
  assertNoForeignRecords,
  deleteUnusedCertificates,
  ensureExternalCertificate,
  findHostedZone,
  listDeploymentCertificates,
  validateCustomDomain,
} = await import("../src/custom-domain");

const acm = mockClient(ACMClient);
const route53 = mockClient(Route53Client);
const CREDS = { accessKeyId: "a", secretAccessKey: "s", sessionToken: "t" };

const STACK_TAGS = [
  { Key: "starkeep:managed", Value: "true" },
  { Key: "starkeep:appId", Value: "cloud-data-server" },
  { Key: "starkeep:stackPrefix", Value: "sk" },
];
const EXTERNAL_TAGS = [...STACK_TAGS, { Key: "starkeep:customDomainMode", Value: "external" }];

beforeEach(() => {
  acm.reset();
  route53.reset();
  resolveNs.mockReset();
});

describe("validateCustomDomain", () => {
  it("lowercases and drops a trailing dot", () => {
    expect(validateCustomDomain(" Photos.Example.COM. ")).toBe("photos.example.com");
  });

  it.each([
    ["a wildcard", "*.example.com"],
    ["a single label", "localhost"],
    ["a CloudFront name", "d1.cloudfront.net"],
    ["a label ending in a hyphen", "photos-.example.com"],
    ["a space", "photos example.com"],
  ])("refuses %s", (_label, name) => {
    expect(() => validateCustomDomain(name)).toThrow();
  });
});

describe("findHostedZone", () => {
  function zones() {
    route53.on(ListHostedZonesCommand).resolves({
      HostedZones: [
        { Id: "/hostedzone/ZAPP", Name: "starkeep.app.", CallerReference: "1", Config: {} },
        { Id: "/hostedzone/ZAARON", Name: "aaron.starkeep.app.", CallerReference: "2", Config: {} },
        {
          Id: "/hostedzone/ZPRIVATE",
          Name: "photos.aaron.starkeep.app.",
          CallerReference: "3",
          Config: { PrivateZone: true },
        },
        { Id: "/hostedzone/ZOTHER", Name: "example.com.", CallerReference: "4", Config: {} },
      ],
    });
    route53.on(GetHostedZoneCommand, { Id: "ZAARON" }).resolves({
      HostedZone: { Id: "/hostedzone/ZAARON", Name: "aaron.starkeep.app.", CallerReference: "2" },
      DelegationSet: { NameServers: ["ns-1.awsdns-01.org", "ns-2.awsdns-02.com"] },
    });
  }

  it("picks the longest public zone that ends the domain", async () => {
    zones();
    resolveNs.mockResolvedValue(["NS-1.awsdns-01.org."]);
    expect(await findHostedZone("photos.aaron.starkeep.app", CREDS)).toEqual({
      id: "ZAARON",
      name: "aaron.starkeep.app",
    });
    expect(resolveNs).toHaveBeenCalledWith("aaron.starkeep.app");
  });

  it("matches a zone named exactly the domain", async () => {
    zones();
    resolveNs.mockResolvedValue(["ns-2.awsdns-02.com"]);
    expect((await findHostedZone("aaron.starkeep.app", CREDS))?.id).toBe("ZAARON");
  });

  it("does not match on a suffix that is not a whole label", async () => {
    zones();
    expect(await findHostedZone("notexample.com", CREDS)).toBeNull();
  });

  it("refuses a zone that public DNS does not delegate to", async () => {
    zones();
    resolveNs.mockResolvedValue(["dns1.registrar.example"]);
    expect(await findHostedZone("aaron.starkeep.app", CREDS)).toBeNull();
  });

  it("refuses a zone whose name does not resolve at all", async () => {
    zones();
    resolveNs.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    expect(await findHostedZone("aaron.starkeep.app", CREDS)).toBeNull();
  });
});

/** One install's path: list once, then ensure the domain's certificate. */
async function ensure(domain: string) {
  const certificates = await listDeploymentCertificates({
    stackPrefix: "sk",
    domains: [domain],
    creds: CREDS,
  });
  return ensureExternalCertificate({ stackPrefix: "sk", domain, certificates, creds: CREDS });
}

describe("ensureExternalCertificate", () => {
  const RECORD = { Name: "_abc.photos.example.com.", Type: "CNAME" as const, Value: "_x.acm." };

  it("requests a tagged certificate in us-east-1 and returns its validation record", async () => {
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [] });
    acm.on(RequestCertificateCommand).resolves({ CertificateArn: "arn:new" });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        Status: "PENDING_VALIDATION",
        DomainValidationOptions: [{ DomainName: "photos.example.com", ResourceRecord: RECORD }],
      },
    });

    const result = await ensure("photos.example.com");

    expect(result).toEqual({
      certificateArn: "arn:new",
      issued: false,
      validationRecord: { name: RECORD.Name, type: "CNAME", value: RECORD.Value },
    });
    const input = acm.commandCalls(RequestCertificateCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ DomainName: "photos.example.com", ValidationMethod: "DNS" });
    expect(input.Tags).toEqual(EXTERNAL_TAGS);
    expect(await acm.commandCalls(RequestCertificateCommand)[0]!.thisValue.config.region()).toBe(
      "us-east-1",
    );
  });

  it("reuses this deployment's certificate for the domain and reports it issued", async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [
        { CertificateArn: "arn:other-prefix", DomainName: "photos.example.com", Status: "ISSUED" },
        { CertificateArn: "arn:mine", DomainName: "photos.example.com", Status: "ISSUED" },
      ],
    });
    acm
      .on(ListTagsForCertificateCommand, { CertificateArn: "arn:other-prefix" })
      .resolves({
        Tags: [...EXTERNAL_TAGS.slice(0, 2), { Key: "starkeep:stackPrefix", Value: "other" }],
      })
      .on(ListTagsForCertificateCommand, { CertificateArn: "arn:mine" })
      .resolves({ Tags: EXTERNAL_TAGS });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        Status: "ISSUED",
        DomainValidationOptions: [{ DomainName: "x", ResourceRecord: RECORD }],
      },
    });

    const result = await ensure("photos.example.com");

    expect(result.certificateArn).toBe("arn:mine");
    expect(result.issued).toBe(true);
    expect(acm.commandCalls(RequestCertificateCommand)).toHaveLength(0);
  });

  it("never adopts the Pulumi program's certificate for the domain", async () => {
    // The domain's zone left the account; the stack's certificate remains.
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [
        { CertificateArn: "arn:stack", DomainName: "photos.example.com", Status: "ISSUED" },
      ],
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: STACK_TAGS });
    acm.on(RequestCertificateCommand).resolves({ CertificateArn: "arn:new" });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        Status: "PENDING_VALIDATION",
        DomainValidationOptions: [{ DomainName: "x", ResourceRecord: RECORD }],
      },
    });

    const result = await ensure("photos.example.com");

    expect(result.certificateArn).toBe("arn:new");
    expect(acm.commandCalls(DeleteCertificateCommand)).toHaveLength(0);
  });

  it("replaces a certificate whose validation timed out", async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [
        {
          CertificateArn: "arn:dead",
          DomainName: "photos.example.com",
          Status: "VALIDATION_TIMED_OUT",
        },
      ],
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: EXTERNAL_TAGS });
    acm.on(RequestCertificateCommand).resolves({ CertificateArn: "arn:fresh" });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        Status: "PENDING_VALIDATION",
        DomainValidationOptions: [{ DomainName: "x", ResourceRecord: RECORD }],
      },
    });

    const result = await ensure("photos.example.com");

    expect(acm.commandCalls(DeleteCertificateCommand).map((c) => c.args[0].input)).toEqual([
      { CertificateArn: "arn:dead" },
    ]);
    expect(result.certificateArn).toBe("arn:fresh");
    // A fixed token would hand back the certificate just deleted.
    expect(acm.commandCalls(RequestCertificateCommand)[0]!.args[0].input.IdempotencyToken).toBe(
      undefined,
    );
  });

  it("makes no new request on a rerun while this deployment's certificate is pending", async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [
        {
          CertificateArn: "arn:pending",
          DomainName: "photos.example.com",
          Status: "PENDING_VALIDATION",
        },
      ],
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: EXTERNAL_TAGS });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        Status: "PENDING_VALIDATION",
        DomainValidationOptions: [{ DomainName: "x", ResourceRecord: RECORD }],
      },
    });

    const result = await ensure("photos.example.com");

    expect(result).toMatchObject({ certificateArn: "arn:pending", issued: false });
    expect(acm.commandCalls(RequestCertificateCommand)).toHaveLength(0);
    expect(acm.commandCalls(DeleteCertificateCommand)).toHaveLength(0);
  });
});

describe("deleteUnusedCertificates", () => {
  function listing() {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [
        { CertificateArn: "arn:keep", DomainName: "photos.example.com" },
        { CertificateArn: "arn:old", DomainName: "old.example.com" },
        { CertificateArn: "arn:stack", DomainName: "aaron.starkeep.app" },
        { CertificateArn: "arn:stack-old", DomainName: "removed.starkeep.app" },
        { CertificateArn: "arn:other", DomainName: "other.starkeep.app" },
      ],
    });
    acm
      .on(ListTagsForCertificateCommand)
      .resolves({ Tags: EXTERNAL_TAGS })
      // The Pulumi program's certificates carry no mode tag.
      .on(ListTagsForCertificateCommand, { CertificateArn: "arn:stack" })
      .resolves({ Tags: STACK_TAGS })
      .on(ListTagsForCertificateCommand, { CertificateArn: "arn:stack-old" })
      .resolves({ Tags: STACK_TAGS })
      // Another deployment's certificate for a domain in play.
      .on(ListTagsForCertificateCommand, { CertificateArn: "arn:other" })
      .resolves({ Tags: [...STACK_TAGS.slice(0, 2), { Key: "starkeep:stackPrefix", Value: "x" }] });
    return listDeploymentCertificates({
      stackPrefix: "sk",
      domains: [
        "photos.example.com",
        "old.example.com",
        "aaron.starkeep.app",
        "removed.starkeep.app",
        "other.starkeep.app",
      ],
      creds: CREDS,
    });
  }

  it("deletes this deployment's certificates of both modes except those kept", async () => {
    await deleteUnusedCertificates({
      keepArns: ["arn:keep", "arn:stack"],
      certificates: await listing(),
      creds: CREDS,
    });

    expect(acm.commandCalls(DeleteCertificateCommand).map((c) => c.args[0].input)).toEqual([
      { CertificateArn: "arn:old" },
      { CertificateArn: "arn:stack-old" },
    ]);
  });

  it("deletes every certificate after an uninstall, and none of another deployment's", async () => {
    await deleteUnusedCertificates({ keepArns: [], certificates: await listing(), creds: CREDS });

    expect(acm.commandCalls(DeleteCertificateCommand).map((c) => c.args[0].input)).toEqual([
      { CertificateArn: "arn:keep" },
      { CertificateArn: "arn:old" },
      { CertificateArn: "arn:stack" },
      { CertificateArn: "arn:stack-old" },
    ]);
  });

  it("leaves a certificate ACM still reports in use for the next run", async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [
        { CertificateArn: "arn:busy", DomainName: "old.example.com" },
        { CertificateArn: "arn:old", DomainName: "older.example.com" },
      ],
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: EXTERNAL_TAGS });
    acm
      .on(DeleteCertificateCommand, { CertificateArn: "arn:busy" })
      .rejects(Object.assign(new Error("in use"), { name: "ResourceInUseException" }));

    const certificates = await listDeploymentCertificates({
      stackPrefix: "sk",
      domains: ["old.example.com", "older.example.com"],
      creds: CREDS,
    });
    await expect(
      deleteUnusedCertificates({ keepArns: [], certificates, creds: CREDS }),
    ).resolves.toBeUndefined();
    expect(acm.commandCalls(DeleteCertificateCommand)).toHaveLength(2);
  });
});

describe("one certificate listing per install", () => {
  it("reads tags only for the domains in play", async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [
        { CertificateArn: "arn:mine", DomainName: "Photos.Example.com" },
        { CertificateArn: "arn:website", DomainName: "www.starkeep.app" },
        { CertificateArn: "arn:other", DomainName: "unrelated.example.org" },
      ],
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: EXTERNAL_TAGS });

    const found = await listDeploymentCertificates({
      stackPrefix: "sk",
      domains: ["photos.example.com"],
      creds: CREDS,
    });

    expect(found).toEqual([
      { arn: "arn:mine", domain: "photos.example.com", status: "", external: true },
    ]);
    expect(
      acm.commandCalls(ListTagsForCertificateCommand).map((c) => c.args[0].input.CertificateArn),
    ).toEqual(["arn:mine"]);
  });

  it("serves both the ensure and the cleanup from a single ListCertificates call", async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [
        { CertificateArn: "arn:dead", DomainName: "photos.example.com", Status: "FAILED" },
        { CertificateArn: "arn:old", DomainName: "old.example.com", Status: "ISSUED" },
      ],
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: EXTERNAL_TAGS });
    acm.on(RequestCertificateCommand).resolves({ CertificateArn: "arn:fresh" });
    acm
      .on(DeleteCertificateCommand, { CertificateArn: "arn:dead" })
      .resolvesOnce({})
      .rejects(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }));
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        Status: "PENDING_VALIDATION",
        DomainValidationOptions: [
          { DomainName: "x", ResourceRecord: { Name: "_a.", Type: "CNAME", Value: "_b." } },
        ],
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const certificates = await listDeploymentCertificates({
      stackPrefix: "sk",
      domains: ["photos.example.com", "old.example.com"],
      creds: CREDS,
    });
    const ensured = await ensureExternalCertificate({
      stackPrefix: "sk",
      domain: "photos.example.com",
      certificates,
      creds: CREDS,
    });
    await deleteUnusedCertificates({
      keepArns: [ensured.certificateArn],
      certificates,
      creds: CREDS,
    });

    expect(acm.commandCalls(ListCertificatesCommand)).toHaveLength(1);
    expect(acm.commandCalls(DeleteCertificateCommand).map((c) => c.args[0].input)).toEqual([
      { CertificateArn: "arn:dead" },
      { CertificateArn: "arn:dead" },
      { CertificateArn: "arn:old" },
    ]);
    // The second delete of the dead certificate finds it gone, which is no news.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("assertNoForeignRecords", () => {
  const NAME = "aaron.starkeep.app";
  const OWN = "d1.cloudfront.net";
  const check = () =>
    assertNoForeignRecords({
      name: NAME,
      hostedZoneId: "ZONE1",
      ownedAliasTargets: [OWN],
      creds: CREDS,
    });
  const alias = (type: "A" | "AAAA", target: string) => ({
    Name: `${NAME}.`,
    Type: type,
    AliasTarget: {
      DNSName: `${target}.`,
      HostedZoneId: "Z2FDTNDATAQYW2",
      EvaluateTargetHealth: false,
    },
  });

  it("passes when nothing is at the name", async () => {
    route53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [],
      IsTruncated: false,
    });
    await expect(check()).resolves.toBeUndefined();
    expect(route53.commandCalls(ListResourceRecordSetsCommand)[0]!.args[0].input).toMatchObject({
      HostedZoneId: "ZONE1",
      StartRecordName: `${NAME}.`,
    });
  });

  it.each([
    [
      "an A record",
      { Name: `${NAME}.`, Type: "A", TTL: 300, ResourceRecords: [{ Value: "203.0.113.7" }] },
      /A aaron\.starkeep\.app \(203\.0\.113\.7\)/,
    ],
    [
      "an AAAA record",
      { Name: `${NAME}.`, Type: "AAAA", TTL: 300, ResourceRecords: [{ Value: "2001:db8::1" }] },
      /AAAA aaron\.starkeep\.app \(2001:db8::1\)/,
    ],
    [
      "a CNAME",
      {
        Name: `${NAME}.`,
        Type: "CNAME",
        TTL: 300,
        ResourceRecords: [{ Value: "old.host.example." }],
      },
      /CNAME aaron\.starkeep\.app \(old\.host\.example\.\)/,
    ],
    [
      "an alias to another distribution",
      alias("A", "d9.cloudfront.net"),
      /A aaron\.starkeep\.app \(alias to d9\.cloudfront\.net\)/,
    ],
  ])("refuses %s at the name, and names it", async (_label, record, message) => {
    route53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [record as never],
      IsTruncated: false,
    });
    await expect(check()).rejects.toThrow(message);
    await expect(check()).rejects.toThrow(/Remove the record/);
  });

  it("passes an alias to this deployment's own distribution, A or AAAA", async () => {
    route53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [alias("A", "D1.CloudFront.net"), alias("AAAA", OWN)],
      IsTruncated: false,
    });
    await expect(check()).resolves.toBeUndefined();
  });

  it("ignores records at the name that cannot clash, and names listed after it", async () => {
    route53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        { Name: `${NAME}.`, Type: "TXT", TTL: 300, ResourceRecords: [{ Value: '"v=spf1"' }] },
        { Name: `_abc.${NAME}.`, Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: "_x.acm." }] },
        { Name: `www.${NAME}.`, Type: "A", TTL: 300, ResourceRecords: [{ Value: "203.0.113.7" }] },
        {
          Name: "zzz.starkeep.app.",
          Type: "A",
          TTL: 300,
          ResourceRecords: [{ Value: "203.0.113.8" }],
        },
      ],
      IsTruncated: true,
      NextRecordName: "zzzz.starkeep.app.",
      NextRecordType: "A",
    });
    await expect(check()).resolves.toBeUndefined();
    expect(route53.commandCalls(ListResourceRecordSetsCommand)).toHaveLength(1);
  });

  it("follows a page break inside the name's own record sets", async () => {
    route53
      .on(ListResourceRecordSetsCommand, {
        StartRecordName: `${NAME}.`,
        StartRecordType: undefined,
      })
      .resolves({
        ResourceRecordSets: [alias("A", OWN)],
        IsTruncated: true,
        NextRecordName: `${NAME}.`,
        NextRecordType: "CNAME",
      })
      .on(ListResourceRecordSetsCommand, { StartRecordType: "CNAME" })
      .resolves({
        ResourceRecordSets: [
          { Name: `${NAME}.`, Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: "x.example." }] },
        ],
        IsTruncated: false,
      });
    await expect(check()).rejects.toThrow(/CNAME aaron\.starkeep\.app/);
  });

  it("makes no ACM call, so a refusal requests no certificate", async () => {
    route53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [alias("A", "d9.cloudfront.net")],
      IsTruncated: false,
    });
    await expect(check()).rejects.toThrow();
    expect(acm.calls()).toHaveLength(0);
  });
});
