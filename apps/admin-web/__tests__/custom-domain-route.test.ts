/**
 * /api/custom-domain — setting the cloud's custom domain, and "Check now".
 *
 * The install acts on whatever the config names, so the route checks the name
 * before it writes: a mistyped domain must stop here, not after the install has
 * attached a temp policy and waited out its propagation. "Check now" reads the
 * certificate as the signed-in operator, whose admin-app role holds the read.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockClient } from "aws-sdk-client-mock";
import { ACMClient, DescribeCertificateCommand } from "@aws-sdk/client-acm";
import { jsonRequest, makeDataDir, writeAdminConfig } from "./helpers";

const dnsMock = {
  resolveCname: vi.fn<(name: string) => Promise<string[]>>(),
  resolve4: vi.fn<(name: string) => Promise<string[]>>(),
};
vi.mock("node:dns", () => ({ promises: dnsMock }));

const findHostedZone = vi.fn();
vi.mock("@starkeep/admin-installer/custom-domain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@starkeep/admin-installer/custom-domain")>()),
  findHostedZone,
}));

const acm = mockClient(ACMClient);
const CREDENTIALS = { accessKeyId: "a", secretAccessKey: "s", sessionToken: "t" };

let route: typeof import("../src/routes/custom-domain");
let dataDir: string;

beforeAll(async () => {
  dataDir = makeDataDir();
  process.env.STARKEEP_DIR = dataDir;
  route = await import("../src/routes/custom-domain");
});

beforeEach(() => {
  acm.reset();
  findHostedZone.mockReset();
  dnsMock.resolveCname.mockReset();
  dnsMock.resolve4.mockReset();
  writeAdminConfig(dataDir, { stackPrefix: "sk", userPoolId: "us-east-2_x" });
});

const onDisk = () =>
  JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8")) as Record<string, unknown>;

describe("PUT", () => {
  it("writes the domain in the form the install compares against", async () => {
    const res = await route.PUT(
      jsonRequest("/api/custom-domain", { domain: " Photos.Example.com. " }, "PUT"),
    );
    expect(res.status).toBe(200);
    expect(onDisk().customDomain).toBe("photos.example.com");
    expect(onDisk().stackPrefix).toBe("sk");
  });

  it("refuses a name the cloud could not answer on, and writes nothing", async () => {
    const res = await route.PUT(
      jsonRequest("/api/custom-domain", { domain: "*.example.com" }, "PUT"),
    );
    expect(res.status).toBe(400);
    expect(onDisk().customDomain).toBeUndefined();
  });

  it("refuses a domain whose grants would overflow the role's policy quota", async () => {
    // A change of domain names both, and two names this long cannot fit.
    const long = (c: string) =>
      `${c.repeat(63)}.${c.repeat(63)}.${c.repeat(63)}.${c.repeat(57)}.com`;
    writeAdminConfig(dataDir, {
      stackPrefix: "sk",
      userPoolId: "us-east-2_x",
      customDomainStatus: {
        name: long("a"),
        mode: "route53",
        status: "active",
        aliasTarget: "d1.cloudfront.net",
      },
    });
    const res = await route.PUT(jsonRequest("/api/custom-domain", { domain: long("b") }, "PUT"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/quota/);
    expect(onDisk().customDomain).toBeUndefined();
  });

  it("clears the domain", async () => {
    writeAdminConfig(dataDir, { stackPrefix: "sk", customDomain: "photos.example.com" });
    const res = await route.PUT(jsonRequest("/api/custom-domain", { domain: null }, "PUT"));
    expect(res.status).toBe(200);
    expect("customDomain" in onDisk()).toBe(false);
  });

  it("refuses another site's page", async () => {
    const res = await route.PUT(
      jsonRequest("/api/custom-domain", { domain: "x.example.com" }, "PUT", "https://evil.example"),
    );
    expect(res.status).toBe(403);
    expect(onDisk().customDomain).toBeUndefined();
  });
});

describe("POST /check", () => {
  const status = {
    name: "photos.example.com",
    mode: "external",
    status: "pending-validation",
    certificateArn: "arn:aws:acm:us-east-1:1:certificate/c",
    aliasTarget: "d1.cloudfront.net",
  };

  it("reads the certificate's status in us-east-1 with the operator's credentials", async () => {
    writeAdminConfig(dataDir, { stackPrefix: "sk", customDomainStatus: status });
    acm.on(DescribeCertificateCommand).resolves({ Certificate: { Status: "ISSUED" } });
    dnsMock.resolveCname.mockRejectedValue(new Error("ENODATA"));
    dnsMock.resolve4.mockRejectedValue(new Error("ENOTFOUND"));

    const res = await route.CHECK(
      jsonRequest("/api/custom-domain/check", { credentials: CREDENTIALS }),
    );

    expect(await res.json()).toEqual({ certificateStatus: "ISSUED", pointsAtDistribution: false });
    const call = acm.commandCalls(DescribeCertificateCommand)[0]!;
    expect(call.args[0].input).toEqual({ CertificateArn: status.certificateArn });
    expect(await call.thisValue.config.region()).toBe("us-east-1");
  });

  it("finds a CNAME to the distribution", async () => {
    writeAdminConfig(dataDir, {
      stackPrefix: "sk",
      customDomainStatus: { ...status, status: "active" },
    });
    acm.on(DescribeCertificateCommand).resolves({ Certificate: { Status: "ISSUED" } });
    dnsMock.resolveCname.mockResolvedValue(["D1.cloudfront.net."]);

    const res = await route.CHECK(
      jsonRequest("/api/custom-domain/check", { credentials: CREDENTIALS }),
    );
    expect(((await res.json()) as { pointsAtDistribution: boolean }).pointsAtDistribution).toBe(
      true,
    );
  });

  it("accepts a flattened record that resolves to the distribution's addresses", async () => {
    writeAdminConfig(dataDir, {
      stackPrefix: "sk",
      customDomainStatus: { ...status, status: "active" },
    });
    acm.on(DescribeCertificateCommand).resolves({ Certificate: { Status: "ISSUED" } });
    dnsMock.resolveCname.mockRejectedValue(new Error("ENODATA"));
    dnsMock.resolve4.mockImplementation(async (name) =>
      name === "photos.example.com" ? ["1.2.3.4"] : ["1.2.3.4", "5.6.7.8"],
    );

    const res = await route.CHECK(
      jsonRequest("/api/custom-domain/check", { credentials: CREDENTIALS }),
    );
    expect(((await res.json()) as { pointsAtDistribution: boolean }).pointsAtDistribution).toBe(
      true,
    );
  });

  it("says so when no install has acted on a domain", async () => {
    const res = await route.CHECK(
      jsonRequest("/api/custom-domain/check", { credentials: CREDENTIALS }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /zone", () => {
  const zone = (domain: unknown) =>
    route.ZONE(
      jsonRequest("/api/custom-domain/zone", {
        domain,
        credentials: { ...CREDENTIALS, expiration: "2026-11-07T00:00:00Z" },
      }),
    );

  it("names the account's zone for the domain, found with the operator's credentials", async () => {
    findHostedZone.mockResolvedValue({ id: "Z1", name: "example.com" });
    const res = await zone(" Photos.Example.com ");
    expect(await res.json()).toEqual({ domain: "photos.example.com", zone: "example.com" });
    expect(findHostedZone).toHaveBeenCalledWith(
      "photos.example.com",
      expect.objectContaining({ accessKeyId: "a", sessionToken: "t" }),
    );
  });

  it("reports no zone for a domain hosted elsewhere", async () => {
    findHostedZone.mockResolvedValue(null);
    expect(await (await zone("photos.example.com")).json()).toEqual({
      domain: "photos.example.com",
      zone: null,
    });
  });

  it("refuses an invalid name before it reads Route53", async () => {
    const res = await zone("*.example.com");
    expect(res.status).toBe(400);
    expect(findHostedZone).not.toHaveBeenCalled();
  });

  it("reports a failed Route53 read", async () => {
    findHostedZone.mockRejectedValue(new Error("AccessDenied"));
    const res = await zone("photos.example.com");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/AccessDenied/);
  });
});
