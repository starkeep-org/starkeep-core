/**
 * The suite's view of DNS and certificates, on the operator's ambient
 * credentials.
 *
 * Those credentials are not confined by IAM the way the installer's role is, so
 * every record the suite writes itself goes through {@link TestZoneWriter},
 * which refuses any zone but the test zone and any name outside this run's.
 * Everything else here only reads.
 */
import { promises as dns } from "node:dns";
import {
  ChangeResourceRecordSetsCommand,
  GetHostedZoneCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
  paginateListHostedZones,
  type ResourceRecordSet,
} from "@aws-sdk/client-route-53";
import {
  ACMClient,
  CertificateStatus,
  DescribeCertificateCommand,
  ListTagsForCertificateCommand,
  paginateListCertificates,
} from "@aws-sdk/client-acm";
import { CloudFrontClient, paginateListDistributions } from "@aws-sdk/client-cloudfront";
import { STSClient } from "@aws-sdk/client-sts";
import type { AwsCredentials } from "@starkeep/admin-installer/session";

/** Route53 is global; its API lives in us-east-1, as do CloudFront's certificates. */
const route53 = new Route53Client({ region: "us-east-1" });
const acm = new ACMClient({ region: "us-east-1" });
const cloudfront = new CloudFrontClient({ region: "us-east-1" });

export interface ZoneRef {
  id: string;
  name: string;
}

/** A Route53 name as the API returns it, in the form every check compares. */
export function normalizeName(name: string): string {
  return name.replace(/\\052/g, "*").toLowerCase().replace(/\.$/, "");
}

/** The ambient credentials, in the shape the installer's helpers take. */
export async function ambientCredentials(region: string): Promise<AwsCredentials> {
  const c = await new STSClient({ region }).config.credentials();
  return {
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken ?? "",
    expiration: c.expiration ?? new Date(Date.now() + 3600_000),
  };
}

async function publicZones(): Promise<ZoneRef[]> {
  const zones: ZoneRef[] = [];
  for await (const page of paginateListHostedZones({ client: route53 }, {})) {
    for (const z of page.HostedZones ?? []) {
      if (z.Config?.PrivateZone || !z.Id || !z.Name) continue;
      zones.push({ id: z.Id.replace(/^\/hostedzone\//, ""), name: normalizeName(z.Name) });
    }
  }
  return zones;
}

/** The public zone named exactly `name`, or null. Two of them is an error. */
export async function zoneNamed(name: string): Promise<ZoneRef | null> {
  const matches = (await publicZones()).filter((z) => z.name === name);
  if (matches.length > 1) {
    throw new Error(`the account holds ${matches.length} public zones named ${name}`);
  }
  return matches[0] ?? null;
}

/** The longest public zone in the account that ends `name`, other than `name` itself. */
export async function parentZoneOf(name: string): Promise<ZoneRef | null> {
  let best: ZoneRef | null = null;
  for (const z of await publicZones()) {
    if (name.endsWith(`.${z.name}`) && (!best || z.name.length > best.name.length)) best = z;
  }
  return best;
}

/** Whether public DNS sends `zone` to the name servers Route53 assigned it. */
export async function publiclyDelegated(zone: ZoneRef): Promise<boolean> {
  const got = await route53.send(new GetHostedZoneCommand({ Id: zone.id }));
  const assigned = new Set((got.DelegationSet?.NameServers ?? []).map(normalizeName));
  try {
    return (await dns.resolveNs(zone.name)).some((n) => assigned.has(normalizeName(n)));
  } catch {
    return false;
  }
}

/** Every record set in the zone, across Route53's pages. */
export async function recordSets(zoneId: string): Promise<ResourceRecordSet[]> {
  const sets: ResourceRecordSet[] = [];
  let next: { name?: string; type?: string; identifier?: string } = {};
  for (;;) {
    const page = await route53.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        StartRecordName: next.name,
        StartRecordType: next.type as never,
        StartRecordIdentifier: next.identifier,
      }),
    );
    sets.push(...(page.ResourceRecordSets ?? []));
    if (!page.IsTruncated) return sets;
    next = {
      name: page.NextRecordName,
      type: page.NextRecordType,
      identifier: page.NextRecordIdentifier,
    };
  }
}

/** The record sets at `name` or under it, such as ACM's `_<hash>.<name>`. */
export function recordsAtOrUnder(sets: ResourceRecordSet[], name: string): ResourceRecordSet[] {
  return sets.filter((rs) => {
    const n = normalizeName(rs.Name ?? "");
    return n === name || n.endsWith(`.${name}`);
  });
}

/**
 * The record sets that make a zone unfit for the suite: anything besides the
 * apex NS and SOA records, and besides names some run of this stack prefix
 * wrote (`<prefix>-<id>.<zone>` and the validation records under it). A zone
 * that serves anything else is somebody's live zone.
 */
export function foreignToSuite(
  sets: ResourceRecordSet[],
  zoneName: string,
  stackPrefix: string,
): string[] {
  return sets
    .filter((rs) => {
      const name = normalizeName(rs.Name ?? "");
      if (name === zoneName) return rs.Type !== "NS" && rs.Type !== "SOA";
      if (!name.endsWith(`.${zoneName}`)) return true;
      const labels = name.slice(0, -zoneName.length - 1).split(".");
      return !labels.some((l) => l.startsWith(`${stackPrefix}-`));
    })
    .map((rs) => `${rs.Type} ${normalizeName(rs.Name ?? "")}`);
}

/**
 * The one path for records the suite writes itself.
 *
 * The writer refuses any zone but the test zone, and any name that lacks both
 * this run's prefix and the zone's suffix. It writes with CREATE, which fails
 * on an existing record, and never with UPSERT. Route53 deletes a record only
 * when the request matches the whole record set, so a DELETE cannot remove a
 * different record.
 */
export class TestZoneWriter {
  constructor(
    private readonly zone: ZoneRef,
    private readonly runPrefix: string,
  ) {}

  private check(zoneId: string, rs: ResourceRecordSet): void {
    const name = normalizeName(rs.Name ?? "");
    if (zoneId !== this.zone.id) {
      throw new Error(`refusing to write in zone ${zoneId}; the test zone is ${this.zone.id}`);
    }
    if (!name.endsWith(`.${this.zone.name}`) || !name.split(".")[0]!.startsWith(this.runPrefix)) {
      throw new Error(
        `refusing to write ${name}: the suite writes only ${this.runPrefix}*.${this.zone.name}`,
      );
    }
  }

  async create(rs: ResourceRecordSet): Promise<void> {
    this.check(this.zone.id, rs);
    await route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: this.zone.id,
        ChangeBatch: { Changes: [{ Action: "CREATE", ResourceRecordSet: rs }] },
      }),
    );
  }

  async delete(rs: ResourceRecordSet): Promise<void> {
    this.check(this.zone.id, rs);
    await route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: this.zone.id,
        ChangeBatch: { Changes: [{ Action: "DELETE", ResourceRecordSet: rs }] },
      }),
    );
  }
}

export interface CertificateState {
  arn: string;
  domain: string;
  status: string;
  inUseBy: string[];
  tags: Record<string, string>;
}

/** Every us-east-1 certificate for one of `domains`, with its tags and users. */
export async function certificatesFor(domains: readonly string[]): Promise<CertificateState[]> {
  const wanted = new Set(domains);
  const found: CertificateState[] = [];
  for await (const page of paginateListCertificates(
    { client: acm },
    { CertificateStatuses: Object.values(CertificateStatus) },
  )) {
    for (const summary of page.CertificateSummaryList ?? []) {
      const domain = summary.DomainName?.toLowerCase();
      if (!summary.CertificateArn || !domain || !wanted.has(domain)) continue;
      const [tags, described] = await Promise.all([
        acm.send(new ListTagsForCertificateCommand({ CertificateArn: summary.CertificateArn })),
        acm.send(new DescribeCertificateCommand({ CertificateArn: summary.CertificateArn })),
      ]);
      found.push({
        arn: summary.CertificateArn,
        domain,
        status: described.Certificate?.Status ?? "",
        inUseBy: [...(described.Certificate?.InUseBy ?? [])].sort(),
        tags: Object.fromEntries((tags.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""])),
      });
    }
  }
  return found.sort((a, b) => a.arn.localeCompare(b.arn));
}

/** The aliases and certificate the distribution named `domainName` serves with. */
export async function distributionServing(
  domainName: string,
): Promise<{ aliases: string[]; certificateArn?: string }> {
  for await (const page of paginateListDistributions({ client: cloudfront }, {})) {
    for (const d of page.DistributionList?.Items ?? []) {
      if (d.DomainName !== domainName) continue;
      return {
        aliases: d.Aliases?.Items ?? [],
        certificateArn: d.ViewerCertificate?.ACMCertificateArn,
      };
    }
  }
  throw new Error(`no distribution named ${domainName}`);
}

/** A stable text form of record sets, for before-and-after comparison. */
export function recordSetsText(sets: ResourceRecordSet[]): string {
  return sets
    .map((rs) =>
      JSON.stringify({
        name: normalizeName(rs.Name ?? ""),
        type: rs.Type,
        ttl: rs.TTL,
        values: (rs.ResourceRecords ?? []).map((r) => r.Value).sort(),
        alias: rs.AliasTarget?.DNSName ? normalizeName(rs.AliasTarget.DNSName) : undefined,
        id: rs.SetIdentifier,
      }),
    )
    .sort()
    .join("\n");
}
