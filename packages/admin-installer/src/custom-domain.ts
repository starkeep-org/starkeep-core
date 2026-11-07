/**
 * The cloud-data-server distribution's custom domain: the checks and the
 * certificate work that run outside the Pulumi program.
 *
 * The install picks one of two DNS modes per run. When a public Route53 zone in
 * the deployment account serves the domain ("route53" mode), the Pulumi program
 * owns the certificate, its validation record and the alias records, and one
 * run finishes everything. Otherwise ("external" mode) the operator edits DNS at
 * another provider, so issuance waits on a person. The installer then requests
 * the certificate here, outside the stack, and a later run attaches it once ACM
 * has issued it. Plan: plan-custom-domain-byo-2026-11-06.md, "Two DNS modes".
 */

import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import {
  ACMClient,
  CertificateStatus,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
  paginateListCertificates,
  type ResourceRecord,
} from "@aws-sdk/client-acm";
import {
  GetHostedZoneCommand,
  Route53Client,
  paginateListHostedZones,
} from "@aws-sdk/client-route-53";
import type { AwsCredentials } from "./session";
import type { CloudDataServerCustomDomain } from "./builtin-programs/cloud-data-server-program";

export { customDomainPolicyFits } from "./iam";

export type CustomDomainMode = "route53" | "external";

/** The record ACM asks for before it issues a certificate. */
export interface ValidationRecord {
  name: string;
  type: string;
  value: string;
}

/**
 * What an install reports about the custom domain. `pending-validation` and
 * `awaiting-dns` exist only in external mode: a route53-mode run waits for
 * issuance itself and writes its own alias records. `awaiting-dns` means the
 * distribution answers on the domain, but public DNS does not send the domain
 * there yet, so the cloudfront.net name stays canonical.
 */
export interface CustomDomainStatus {
  name: string;
  mode: CustomDomainMode;
  status: "pending-validation" | "awaiting-dns" | "active";
  /** The record the operator adds at their DNS provider (external mode). */
  validationRecord?: ValidationRecord;
  /** The external-mode certificate, which admin-web's "Check now" reads. */
  certificateArn?: string;
  /** The distribution's own name, which the domain's CNAME points at. */
  aliasTarget: string;
}

/** CloudFront takes certificates only from us-east-1. */
const CERTIFICATE_REGION = "us-east-1";

const TAG_MANAGED = "starkeep:managed";
const TAG_APP_ID = "starkeep:appId";
const TAG_STACK_PREFIX = "starkeep:stackPrefix";
const TAG_MODE = "starkeep:customDomainMode";

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * The domain in the form every later step compares against: lowercase, with no
 * trailing dot. Throws on a name CloudFront could not serve as an alias.
 */
export function validateCustomDomain(domain: string): string {
  const name = domain.trim().toLowerCase().replace(/\.$/, "");
  if (name.includes("*")) {
    throw new Error(
      `Custom domain ${domain} has a wildcard; name one host, such as photos.example.com.`,
    );
  }
  const labels = name.split(".");
  if (name.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    throw new Error(`Custom domain ${domain} is not a valid host name.`);
  }
  if (name === "cloudfront.net" || name.endsWith(".cloudfront.net")) {
    throw new Error(`Custom domain ${domain} is a CloudFront name; name a domain you own.`);
  }
  return name;
}

/**
 * Whether public DNS sends `name` to the distribution `aliasTarget`: a CNAME to
 * it, or, for a provider that flattens the record or a Route53 alias, the same
 * addresses.
 */
export async function domainPointsAt(name: string, aliasTarget: string): Promise<boolean> {
  const target = aliasTarget.toLowerCase().replace(/\.$/, "");
  try {
    const cnames = await dns.resolveCname(name);
    if (cnames.some((c) => c.toLowerCase().replace(/\.$/, "") === target)) return true;
  } catch {
    // No CNAME: an alias or a flattened record may still answer.
  }
  try {
    const [mine, theirs] = await Promise.all([dns.resolve4(name), dns.resolve4(target)]);
    const theirSet = new Set(theirs);
    return mine.length > 0 && mine.every((a) => theirSet.has(a));
  } catch {
    return false;
  }
}

/** What one install does with the custom domain, decided before `pulumi up`. */
export interface CustomDomainPlan {
  /** The program's `customDomain` input, or undefined when nothing attaches. */
  program?: CloudDataServerCustomDomain;
  /** Whether the custom domain becomes the canonical host this run. */
  canonical: boolean;
  /** The status the install reports, short of the distribution's name. */
  status?: Omit<CustomDomainStatus, "aliasTarget">;
}

/**
 * Decide the run from what the installer found: the domain's zone in this
 * account, if any; otherwise the external certificate, and whether public DNS
 * already sends the domain to the distribution.
 *
 * An external domain becomes canonical only once its DNS points at the
 * distribution. Before that, the distribution still answers on the domain, but
 * links and signed URLs keep the cloudfront.net name, which resolves.
 */
export function planCustomDomain(opts: {
  name?: string;
  zone: { id: string; name: string } | null;
  certificate?: { certificateArn: string; issued: boolean; validationRecord?: ValidationRecord };
  pointsAtDistribution: boolean;
}): CustomDomainPlan {
  const { name, zone, certificate } = opts;
  if (!name) return { canonical: false };
  if (zone) {
    return {
      program: { name, mode: "route53", hostedZoneId: zone.id },
      canonical: true,
      status: { name, mode: "route53", status: "active" },
    };
  }
  if (!certificate) throw new Error(`No certificate for external-mode domain ${name}.`);
  const external = {
    name,
    mode: "external" as const,
    validationRecord: certificate.validationRecord,
    certificateArn: certificate.certificateArn,
  };
  if (!certificate.issued) {
    return { canonical: false, status: { ...external, status: "pending-validation" } };
  }
  const canonical = opts.pointsAtDistribution;
  return {
    program: { name, mode: "external", certificateArn: certificate.certificateArn, canonical },
    canonical,
    status: { ...external, status: canonical ? "active" : "awaiting-dns" },
  };
}

/**
 * The hosts the signing config lists and sign-in accepts, canonical first:
 * the signing domain, the attached custom domain when it is not canonical yet,
 * and the distribution's own name.
 */
export function signingHosts(
  signingDomain: string,
  cloudfrontDomain: string,
  attachedDomain?: string,
): string[] {
  return [
    ...new Set([signingDomain, attachedDomain, cloudfrontDomain].filter((h): h is string => !!h)),
  ];
}

function credentialsOf(creds: AwsCredentials) {
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  };
}

function acmClient(creds: AwsCredentials): ACMClient {
  return new ACMClient({ region: CERTIFICATE_REGION, credentials: credentialsOf(creds) });
}

/**
 * The public Route53 zone in this account that serves `domain`, or null.
 *
 * The longest zone name that equals the domain or ends it wins. A zone counts
 * only when public DNS delegates to it: a zone nobody delegated to would take
 * the validation record and ACM would never see it, so the install would wait
 * out the validation timeout. Such a domain takes external mode instead.
 */
export async function findHostedZone(
  domain: string,
  creds: AwsCredentials,
): Promise<{ id: string; name: string } | null> {
  // Route53 is global; its API lives in us-east-1.
  const route53 = new Route53Client({ region: "us-east-1", credentials: credentialsOf(creds) });
  let best: { id: string; name: string } | null = null;
  for await (const page of paginateListHostedZones({ client: route53 }, {})) {
    for (const zone of page.HostedZones ?? []) {
      if (zone.Config?.PrivateZone || !zone.Id || !zone.Name) continue;
      const name = zone.Name.toLowerCase().replace(/\.$/, "");
      if (domain !== name && !domain.endsWith(`.${name}`)) continue;
      if (!best || name.length > best.name.length) {
        best = { id: zone.Id.replace(/^\/hostedzone\//, ""), name };
      }
    }
  }
  if (!best) return null;

  const zone = await route53.send(new GetHostedZoneCommand({ Id: best.id }));
  const assigned = new Set(
    (zone.DelegationSet?.NameServers ?? []).map((n) => n.toLowerCase().replace(/\.$/, "")),
  );
  let published: string[];
  try {
    published = await dns.resolveNs(best.name);
  } catch {
    published = [];
  }
  if (!published.some((n) => assigned.has(n.toLowerCase().replace(/\.$/, "")))) {
    console.log(
      `Route53 zone ${best.name} (${best.id}) is not the zone public DNS uses for it; ` +
        "treating the domain as hosted elsewhere.",
    );
    return null;
  }
  return best;
}

/** The certificates in us-east-1 that carry every one of `tags`. */
async function findTaggedCertificates(
  acm: ACMClient,
  tags: Record<string, string>,
): Promise<Array<{ arn: string; domain: string; status: string }>> {
  const found: Array<{ arn: string; domain: string; status: string }> = [];
  const paginator = paginateListCertificates(
    { client: acm },
    // Without a status filter ACM lists only some statuses.
    { CertificateStatuses: Object.values(CertificateStatus) },
  );
  for await (const page of paginator) {
    for (const summary of page.CertificateSummaryList ?? []) {
      if (!summary.CertificateArn || !summary.DomainName) continue;
      const listed = await acm.send(
        new ListTagsForCertificateCommand({ CertificateArn: summary.CertificateArn }),
      );
      const held = new Map((listed.Tags ?? []).map((t) => [t.Key, t.Value]));
      if (Object.entries(tags).every(([k, v]) => held.get(k) === v)) {
        found.push({
          arn: summary.CertificateArn,
          domain: summary.DomainName,
          status: summary.Status ?? "",
        });
      }
    }
  }
  return found;
}

function externalTags(stackPrefix: string): Record<string, string> {
  return {
    [TAG_MANAGED]: "true",
    [TAG_APP_ID]: "cloud-data-server",
    [TAG_STACK_PREFIX]: stackPrefix,
    [TAG_MODE]: "external",
  };
}

/** Statuses after which a certificate can never issue. */
const DEAD_STATUSES = new Set<string>([
  CertificateStatus.FAILED,
  CertificateStatus.VALIDATION_TIMED_OUT,
  CertificateStatus.EXPIRED,
  CertificateStatus.REVOKED,
  CertificateStatus.INACTIVE,
]);

/**
 * Find or request the external-mode certificate for `domain`, and report
 * whether ACM has issued it.
 *
 * A certificate that can no longer issue (validation timed out after 72 hours,
 * say) is deleted and requested again, so a rerun recovers by itself. ACM fills
 * in the validation record a few seconds after a request, so the function waits
 * for the record before it returns.
 */
export async function ensureExternalCertificate(opts: {
  stackPrefix: string;
  domain: string;
  creds: AwsCredentials;
}): Promise<{ certificateArn: string; issued: boolean; validationRecord?: ValidationRecord }> {
  const acm = acmClient(opts.creds);
  const tags = externalTags(opts.stackPrefix);
  const mine = (await findTaggedCertificates(acm, tags)).filter((c) => c.domain === opts.domain);

  let arn: string | undefined;
  for (const cert of mine) {
    if (DEAD_STATUSES.has(cert.status) || arn) {
      console.log(`Deleting certificate ${cert.arn} (${cert.status}) for ${opts.domain}.`);
      await acm.send(new DeleteCertificateCommand({ CertificateArn: cert.arn }));
    } else {
      arn = cert.arn;
    }
  }

  if (!arn) {
    console.log(`Requesting a certificate for ${opts.domain} in ${CERTIFICATE_REGION}…`);
    const requested = await acm.send(
      new RequestCertificateCommand({
        DomainName: opts.domain,
        ValidationMethod: "DNS",
        // Collapses a retried request within the hour into one certificate.
        IdempotencyToken: createHash("sha256")
          .update(`${opts.stackPrefix}/${opts.domain}`)
          .digest("hex")
          .slice(0, 32),
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      }),
    );
    arn = requested.CertificateArn!;
  }

  for (let attempt = 0; ; attempt++) {
    const described = await acm.send(new DescribeCertificateCommand({ CertificateArn: arn }));
    const cert = described.Certificate;
    const record: ResourceRecord | undefined = cert?.DomainValidationOptions?.[0]?.ResourceRecord;
    if (cert?.Status === CertificateStatus.ISSUED) {
      return { certificateArn: arn, issued: true, validationRecord: toValidationRecord(record) };
    }
    if (record?.Name && record.Value) {
      return { certificateArn: arn, issued: false, validationRecord: toValidationRecord(record) };
    }
    if (attempt >= 15) {
      throw new Error(`ACM gave certificate ${arn} no validation record after 30 seconds.`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

function toValidationRecord(record: ResourceRecord | undefined): ValidationRecord | undefined {
  if (!record?.Name || !record.Type || !record.Value) return undefined;
  return { name: record.Name, type: record.Type, value: record.Value };
}

/**
 * Delete every external-mode certificate of this deployment except `keepArn`.
 *
 * Runs after `pulumi up`, which has already detached any certificate the run no
 * longer uses: after the operator removes the domain, changes it, or moves its
 * zone into this account.
 */
export async function deleteUnusedExternalCertificates(opts: {
  stackPrefix: string;
  keepArn?: string;
  creds: AwsCredentials;
}): Promise<void> {
  const acm = acmClient(opts.creds);
  for (const cert of await findTaggedCertificates(acm, externalTags(opts.stackPrefix))) {
    if (cert.arn === opts.keepArn) continue;
    console.log(`Deleting unused certificate ${cert.arn} for ${cert.domain}.`);
    try {
      await acm.send(new DeleteCertificateCommand({ CertificateArn: cert.arn }));
    } catch (err) {
      // ACM can report a certificate in use for a while after CloudFront
      // detached it. The install has finished its real work by now, and the
      // next run deletes what this one could not.
      console.warn(
        `Could not delete certificate ${cert.arn}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
