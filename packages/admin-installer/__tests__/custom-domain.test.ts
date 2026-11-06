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
  Route53Client,
} from "@aws-sdk/client-route-53";

const resolveNs = vi.fn<(name: string) => Promise<string[]>>();
vi.mock("node:dns", () => ({ promises: { resolveNs: (n: string) => resolveNs(n) } }));

const {
  deleteUnusedExternalCertificates,
  ensureExternalCertificate,
  findHostedZone,
  validateCustomDomain,
} = await import("../src/custom-domain");

const acm = mockClient(ACMClient);
const route53 = mockClient(Route53Client);
const CREDS = { accessKeyId: "a", secretAccessKey: "s", sessionToken: "t" };

const EXTERNAL_TAGS = [
  { Key: "starkeep:managed", Value: "true" },
  { Key: "starkeep:appId", Value: "cloud-data-server" },
  { Key: "starkeep:stackPrefix", Value: "sk" },
  { Key: "starkeep:customDomainMode", Value: "external" },
];

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

    const result = await ensureExternalCertificate({
      stackPrefix: "sk",
      domain: "photos.example.com",
      creds: CREDS,
    });

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

    const result = await ensureExternalCertificate({
      stackPrefix: "sk",
      domain: "photos.example.com",
      creds: CREDS,
    });

    expect(result.certificateArn).toBe("arn:mine");
    expect(result.issued).toBe(true);
    expect(acm.commandCalls(RequestCertificateCommand)).toHaveLength(0);
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

    const result = await ensureExternalCertificate({
      stackPrefix: "sk",
      domain: "photos.example.com",
      creds: CREDS,
    });

    expect(acm.commandCalls(DeleteCertificateCommand).map((c) => c.args[0].input)).toEqual([
      { CertificateArn: "arn:dead" },
    ]);
    expect(result.certificateArn).toBe("arn:fresh");
  });
});

describe("deleteUnusedExternalCertificates", () => {
  it("deletes this deployment's external certificates except the one in use", async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [
        { CertificateArn: "arn:keep", DomainName: "photos.example.com" },
        { CertificateArn: "arn:old", DomainName: "old.example.com" },
        { CertificateArn: "arn:stack", DomainName: "aaron.starkeep.app" },
      ],
    });
    acm
      .on(ListTagsForCertificateCommand, { CertificateArn: "arn:keep" })
      .resolves({ Tags: EXTERNAL_TAGS })
      .on(ListTagsForCertificateCommand, { CertificateArn: "arn:old" })
      .resolves({ Tags: EXTERNAL_TAGS })
      // The Pulumi stack's own certificate has no mode tag, and `pulumi
      // destroy` owns it.
      .on(ListTagsForCertificateCommand, { CertificateArn: "arn:stack" })
      .resolves({ Tags: EXTERNAL_TAGS.slice(0, 3) });

    await deleteUnusedExternalCertificates({
      stackPrefix: "sk",
      keepArn: "arn:keep",
      creds: CREDS,
    });

    expect(acm.commandCalls(DeleteCertificateCommand).map((c) => c.args[0].input)).toEqual([
      { CertificateArn: "arn:old" },
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

    await expect(
      deleteUnusedExternalCertificates({ stackPrefix: "sk", creds: CREDS }),
    ).resolves.toBeUndefined();
    expect(acm.commandCalls(DeleteCertificateCommand)).toHaveLength(2);
  });
});
