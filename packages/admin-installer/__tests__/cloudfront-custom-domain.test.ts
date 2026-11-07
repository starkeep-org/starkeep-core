/**
 * The distribution's custom domain under Pulumi's runtime mocks, in each of
 * the program's three shapes.
 *
 * - No domain: the default certificate and no alias, exactly as before.
 * - Route53 mode: the zone sits in the account, so the stack owns the whole
 *   chain — certificate, validation record, CertificateValidation, and the
 *   alias records — and the distribution takes the *validated* ARN, which is
 *   what makes it wait for issuance.
 * - External mode: the installer holds an issued certificate outside the
 *   stack, so the stack creates no certificate and no record.
 *
 * Every shape keeps exporting the cloudfront.net name, which keeps answering
 * and which an external domain's CNAME targets.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { buildCloudDataServerProgram } from "../src/builtin-programs/cloud-data-server-program";
import type {
  CloudDataServerCustomDomain,
  CloudDataServerProgramContext,
} from "../src/builtin-programs/cloud-data-server-program";

interface CreatedResource {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

let created: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      created.push({ type: args.type, name: args.name, inputs: args.inputs });
      const extra: Record<string, unknown> = {};
      if (args.type.endsWith("apigatewayv2/api:Api")) {
        extra.apiEndpoint = "https://mockapi.execute-api.us-east-2.amazonaws.com";
      }
      if (args.type.endsWith("cloudfront/distribution:Distribution")) {
        extra.domainName = "d1.cloudfront.net";
        extra.hostedZoneId = "Z2FDTNDATAQYW2";
      }
      if (args.type.endsWith("acm/certificate:Certificate")) {
        extra.domainValidationOptions = [
          {
            domainName: args.inputs.domainName,
            resourceRecordName: `_abc.${args.inputs.domainName}.`,
            resourceRecordType: "CNAME",
            resourceRecordValue: "_xyz.acm-validations.aws.",
          },
        ];
      }
      if (args.type.endsWith("acm/certificateValidation:CertificateValidation")) {
        extra.certificateArn = `${args.inputs.certificateArn}#validated`;
      }
      if (args.type.endsWith("route53/record:Record")) {
        extra.fqdn = args.inputs.name;
      }
      return {
        id: `${args.name}-id`,
        state: { ...args.inputs, arn: `arn:fake:${args.name}`, ...extra },
      };
    },
    call(args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "starkeep-test-project",
  "starkeep-test-stack",
  false,
);

const distZipPath = mkdtempSync(join(tmpdir(), "cds-custom-domain-"));

function ctx(customDomain?: CloudDataServerCustomDomain): CloudDataServerProgramContext {
  return {
    stackPrefix: "starkeep",
    region: "us-east-2",
    accountId: "111122223333",
    appRoleArn: "arn:aws:iam::111122223333:role/starkeep-app-cloud-data-server-role",
    distZipPath,
    bundleHash: "abc123hash",
    userPoolId: "us-east-2_pool",
    cloudAppsUserPoolClientId: "client123",
    mobileAppsUserPoolClientId: "mobileclient789",
    cognitoDomain: "teststack-123.auth.us-east-1.amazoncognito.com",
    deviceUserPoolClientId: "deviceclient456",
    ephemeral: false,
    customDomain,
  };
}

interface Run {
  created: CreatedResource[];
  outputs: Record<string, unknown>;
  distribution: CreatedResource;
}

async function run(customDomain?: CloudDataServerCustomDomain): Promise<Run> {
  created = [];
  const raw = await buildCloudDataServerProgram(ctx(customDomain))();
  const outputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    outputs[key] = pulumi.Output.isInstance(value)
      ? await new Promise((resolve) => (value as pulumi.Output<unknown>).apply(resolve))
      : value;
  }
  // Let every registration settle before reading what was created.
  await new Promise((r) => setTimeout(r, 50));
  const distribution = created.find((r) =>
    r.type.endsWith("cloudfront/distribution:Distribution"),
  )!;
  return { created: [...created], outputs, distribution };
}

const ofType = (r: Run, suffix: string) => r.created.filter((c) => c.type.endsWith(suffix));

describe("no custom domain", () => {
  let r: Run;
  beforeAll(async () => {
    r = await run();
  });

  it("keeps the default certificate and no alias", () => {
    expect(r.distribution.inputs.viewerCertificate).toEqual({ cloudfrontDefaultCertificate: true });
    expect(r.distribution.inputs.aliases ?? []).toEqual([]);
  });

  it("creates no certificate and no record", () => {
    expect(ofType(r, "acm/certificate:Certificate")).toHaveLength(0);
    expect(ofType(r, "route53/record:Record")).toHaveLength(0);
  });

  it("uses the cloudfront.net name as the canonical base and signing host", () => {
    expect(r.outputs.publicBaseUrl).toBe("https://d1.cloudfront.net");
    expect(r.outputs.cloudfrontSigningDomain).toBe("d1.cloudfront.net");
    expect(r.outputs.cloudfrontDomain).toBe("d1.cloudfront.net");
  });
});

describe("Route53 mode", () => {
  let r: Run;
  beforeAll(async () => {
    r = await run({ name: "aaron.starkeep.app", mode: "route53", hostedZoneId: "ZONE1" });
  });

  it("requests the certificate in us-east-1, the only region CloudFront takes", () => {
    const [cert] = ofType(r, "acm/certificate:Certificate");
    expect(cert!.inputs).toMatchObject({
      domainName: "aaron.starkeep.app",
      validationMethod: "DNS",
    });
    expect(cert!.inputs.tags).toMatchObject({ "starkeep:stackPrefix": "starkeep" });
  });

  it("writes the validation record ACM asks for, in the domain's zone", () => {
    const validation = ofType(r, "route53/record:Record").find((x) =>
      String(x.inputs.name).startsWith("_abc."),
    );
    expect(validation!.inputs).toMatchObject({
      zoneId: "ZONE1",
      type: "CNAME",
      records: ["_xyz.acm-validations.aws."],
      allowOverwrite: true,
    });
  });

  it("attaches the validated certificate, so the distribution waits for issuance", () => {
    expect(ofType(r, "acm/certificateValidation:CertificateValidation")).toHaveLength(1);
    expect(r.distribution.inputs.aliases).toEqual(["aaron.starkeep.app"]);
    expect(r.distribution.inputs.viewerCertificate).toMatchObject({
      sslSupportMethod: "sni-only",
      minimumProtocolVersion: "TLSv1.2_2021",
    });
    expect(
      String(
        (r.distribution.inputs.viewerCertificate as { acmCertificateArn: string })
          .acmCertificateArn,
      ),
    ).toMatch(/#validated$/);
  });

  it("points A and AAAA alias records at the distribution", () => {
    const aliases = ofType(r, "route53/record:Record").filter((x) => x.inputs.aliases);
    expect(aliases.map((a) => a.inputs.type).sort()).toEqual(["A", "AAAA"]);
    for (const a of aliases) {
      expect(a.inputs).toMatchObject({ zoneId: "ZONE1", name: "aaron.starkeep.app" });
      expect(a.inputs.aliases).toEqual([
        { name: "d1.cloudfront.net", zoneId: "Z2FDTNDATAQYW2", evaluateTargetHealth: false },
      ]);
    }
  });

  it("makes the custom domain canonical and keeps exporting the cloudfront.net name", () => {
    expect(r.outputs.publicBaseUrl).toBe("https://aaron.starkeep.app");
    expect(r.outputs.cloudfrontSigningDomain).toBe("aaron.starkeep.app");
    expect(r.outputs.cloudfrontDomain).toBe("d1.cloudfront.net");
  });
});

describe("external mode", () => {
  let r: Run;
  const arn = "arn:aws:acm:us-east-1:111122223333:certificate/ext";
  beforeAll(async () => {
    r = await run({
      name: "photos.example.com",
      mode: "external",
      certificateArn: arn,
      canonical: true,
    });
  });

  it("attaches the installer's certificate and owns no certificate or record", () => {
    expect(ofType(r, "acm/certificate:Certificate")).toHaveLength(0);
    expect(ofType(r, "acm/certificateValidation:CertificateValidation")).toHaveLength(0);
    expect(ofType(r, "route53/record:Record")).toHaveLength(0);
    expect(r.distribution.inputs.aliases).toEqual(["photos.example.com"]);
    expect(r.distribution.inputs.viewerCertificate).toMatchObject({ acmCertificateArn: arn });
  });

  it("makes the custom domain canonical", () => {
    expect(r.outputs.publicBaseUrl).toBe("https://photos.example.com");
    expect(r.outputs.cloudfrontSigningDomain).toBe("photos.example.com");
    expect(r.outputs.cloudfrontDomain).toBe("d1.cloudfront.net");
  });
});

describe("external mode before DNS points at the distribution", () => {
  let r: Run;
  const arn = "arn:aws:acm:us-east-1:111122223333:certificate/ext";
  beforeAll(async () => {
    r = await run({
      name: "photos.example.com",
      mode: "external",
      certificateArn: arn,
      canonical: false,
    });
  });

  it("still attaches the alias and the certificate", () => {
    expect(r.distribution.inputs.aliases).toEqual(["photos.example.com"]);
    expect(r.distribution.inputs.viewerCertificate).toMatchObject({ acmCertificateArn: arn });
  });

  it("keeps the cloudfront.net name canonical, so links resolve", () => {
    expect(r.outputs.publicBaseUrl).toBe("https://d1.cloudfront.net");
    expect(r.outputs.cloudfrontSigningDomain).toBe("d1.cloudfront.net");
    expect(r.outputs.cloudfrontDomain).toBe("d1.cloudfront.net");
  });
});
