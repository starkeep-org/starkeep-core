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
  ListResourceRecordSetsCommand,
  Route53Client,
  paginateListHostedZones,
  type ResourceRecordSet,
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
  /** The Route53 zone that holds the domain's records (route53 mode). */
  hostedZoneId?: string;
  /** The distribution's own name, which the domain's CNAME points at. */
  aliasTarget: string;
}

/**
 * A certificate the distribution holds with no alias, after a removal or while
 * a new external domain waits on validation.
 *
 * ACM releases a certificate at once when CloudFront swaps it for another or
 * deletes the distribution, but holds it for up to an hour after CloudFront
 * falls back to its default certificate. A removal therefore drops only the
 * alias, and a later domain or the uninstall releases the certificate in a way
 * that lets the same run delete it. Findings: plan-pr133-review-fixes-2026-11-07.md,
 * "Toward deterministic certificate cleanup".
 */
export interface KeptCertificate {
  /** The domain the certificate names, which no longer resolves to the cloud. */
  name: string;
  mode: CustomDomainMode;
  /** The installer's certificate (external mode). */
  certificateArn?: string;
  /**
   * The zone that holds the certificate's validation record (route53 mode).
   * The record stays, so ACM keeps renewing the certificate.
   */
  hostedZoneId?: string;
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
 * it, or, with no CNAME, for a provider that flattens the record or a Route53
 * alias, addresses that all belong to CloudFront.
 *
 * A flattening provider resolves the distribution from its own location, so
 * its edge addresses differ from the ones this machine's resolver returns for
 * `aliasTarget`. Any CloudFront edge serves the name the same way: CloudFront
 * holds each alias on one distribution only, and the install attaches the alias
 * to this one. Every edge address's reverse name ends in `.cloudfront.net`, as
 * `server-13-32-164-46.ord58.r.cloudfront.net` does.
 */
export async function domainPointsAt(name: string, aliasTarget: string): Promise<boolean> {
  const target = aliasTarget.toLowerCase().replace(/\.$/, "");
  try {
    const cnames = await dns.resolveCname(name);
    // A CNAME elsewhere, such as to an earlier distribution, is a mistake to
    // report, not a flattened record.
    return cnames.some((c) => c.toLowerCase().replace(/\.$/, "") === target);
  } catch {
    // No CNAME: an alias or a flattened record may still answer.
  }
  try {
    const addresses = await dns.resolve4(name);
    if (addresses.length === 0) return false;
    const reverse = await Promise.all(addresses.map((a) => dns.reverse(a)));
    return reverse.every((names) =>
      names.some((n) => n.toLowerCase().replace(/\.$/, "").endsWith(".cloudfront.net")),
    );
  } catch {
    return false;
  }
}

/** What one install does with the custom domain, decided before `pulumi up`. */
export interface CustomDomainPlan {
  /**
   * The program's `customDomain` input, or undefined when the distribution
   * holds no custom certificate. A kept certificate attaches as `detached`.
   */
  program?: CloudDataServerCustomDomain;
  /** Whether the custom domain becomes the canonical host this run. */
  canonical: boolean;
  /** The status the install reports, short of the distribution's name. */
  status?: Omit<CustomDomainStatus, "aliasTarget">;
  /** The certificate the distribution keeps with no alias, if any. */
  kept?: KeptCertificate;
}

/**
 * The certificate the distribution held after the last successful install: the
 * attached domain's, or a kept one. An external certificate still pending
 * validation was never attached.
 */
export function certificateOnDistribution(
  status: CustomDomainStatus | undefined,
  kept: KeptCertificate | undefined,
): KeptCertificate | undefined {
  if (status?.mode === "route53") {
    return { name: status.name, mode: "route53", hostedZoneId: status.hostedZoneId };
  }
  if (status?.mode === "external" && status.status !== "pending-validation") {
    return { name: status.name, mode: "external", certificateArn: status.certificateArn };
  }
  return kept;
}

/**
 * Decide the run from what the installer found: the domain's zone in this
 * account, if any; otherwise the external certificate, and whether public DNS
 * already sends the domain to the distribution.
 *
 * An external domain becomes canonical only once its DNS points at the
 * distribution. Before that, the distribution still answers on the domain, but
 * links and signed URLs keep the cloudfront.net name, which resolves.
 *
 * A run that attaches no domain keeps `held`, the certificate already on the
 * distribution, with no alias: CloudFront then never falls back to its default
 * certificate, the one change after which ACM holds a certificate for up to an
 * hour. A run that attaches a domain swaps the held certificate out, and ACM
 * releases it at once.
 */
export function planCustomDomain(opts: {
  name?: string;
  zone: { id: string; name: string } | null;
  certificate?: { certificateArn: string; issued: boolean; validationRecord?: ValidationRecord };
  pointsAtDistribution: boolean;
  /** The certificate on the distribution before this run, from certificateOnDistribution. */
  held?: KeptCertificate;
}): CustomDomainPlan {
  const { name, zone, certificate, held } = opts;
  const keep = (status?: CustomDomainPlan["status"]): CustomDomainPlan => {
    if (!held) return { canonical: false, status };
    if (held.mode === "route53") {
      if (!held.hostedZoneId) {
        throw new Error(`No Route53 zone recorded for the kept certificate of ${held.name}.`);
      }
      return {
        program: {
          name: held.name,
          mode: "route53",
          hostedZoneId: held.hostedZoneId,
          detached: true,
        },
        canonical: false,
        status,
        kept: held,
      };
    }
    if (!held.certificateArn) {
      throw new Error(`No certificate recorded for the kept external domain ${held.name}.`);
    }
    return {
      program: {
        name: held.name,
        mode: "external",
        certificateArn: held.certificateArn,
        canonical: false,
        detached: true,
      },
      canonical: false,
      status,
      kept: held,
    };
  };

  if (!name) return keep();
  if (zone) {
    return {
      program: { name, mode: "route53", hostedZoneId: zone.id },
      canonical: true,
      status: { name, mode: "route53", status: "active", hostedZoneId: zone.id },
    };
  }
  if (!certificate) throw new Error(`No certificate for external-mode domain ${name}.`);
  const external = {
    name,
    mode: "external" as const,
    validationRecord: certificate.validationRecord,
    certificateArn: certificate.certificateArn,
  };
  if (!certificate.issued) return keep({ ...external, status: "pending-validation" });
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

/** The custom-domain fields of `~/.starkeep/config.json`. */
export interface CustomDomainConfigFields {
  /** The operator's choice, set in admin-web. */
  customDomain?: string;
  /** Where the domain stood after the last successful install. */
  customDomainStatus?: CustomDomainStatus;
  /**
   * The domain an install started on and has not finished. A failed first
   * attach can leave a certificate and records that only this name's grants
   * can delete, and `customDomainStatus` never names it.
   */
  customDomainAttempted?: string;
  /** The certificate the distribution kept with no alias after the last install. */
  customDomainKept?: KeptCertificate;
}

/**
 * The failed attempt that blocks setting `domain`, or null.
 *
 * A failed attach can leave records and a certificate that only the attempted
 * name's grants can delete. A new domain would replace the attempt in
 * `customDomainAttempted`, and the next install would lose those grants and
 * fail on the leftovers. So a new domain waits until an update with no domain
 * has cleaned the attempt up. Clearing the domain, or retrying the same one,
 * stays allowed, and an attempt the last install's status already names is
 * covered by that status.
 */
export function pendingAttemptBlocking(
  config: Pick<CustomDomainConfigFields, "customDomainAttempted" | "customDomainStatus">,
  domain: string | null | undefined,
): string | null {
  const attempted = config.customDomainAttempted;
  if (!domain || !attempted) return null;
  if (domain === attempted || attempted === config.customDomainStatus?.name) return null;
  return attempted;
}

/** The refusal text for a blocked domain; see pendingAttemptBlocking. */
export function pendingAttemptRefusal(attempted: string): string {
  return (
    `An install for ${attempted} failed and may have left records behind. ` +
    `Remove ${attempted} and update the cloud, then set another domain.`
  );
}

/**
 * The config's custom-domain fields after one step of an install:
 *
 * - `starting`, written before the install touches AWS: the domain the run
 *   attaches becomes `customDomainAttempted`. A run that names no domain
 *   keeps an earlier attempt, so the attempt's leftovers stay in play. A run
 *   that names another domain while an attempt waits throws; see
 *   pendingAttemptBlocking.
 * - `succeeded`: the run's status and kept certificate replace the attempt.
 * - `failed`: nothing changes, so the attempt carries into the next run.
 */
export function nextCustomDomainConfig<T extends CustomDomainConfigFields>(
  previous: T,
  outcome:
    | { stage: "starting" }
    | { stage: "succeeded"; status?: CustomDomainStatus; kept?: KeptCertificate }
    | { stage: "failed" },
): T {
  const next = { ...previous };
  switch (outcome.stage) {
    case "starting": {
      const blocking = pendingAttemptBlocking(previous, previous.customDomain);
      if (blocking) throw new Error(pendingAttemptRefusal(blocking));
      if (previous.customDomain) next.customDomainAttempted = previous.customDomain;
      return next;
    }
    case "succeeded":
      delete next.customDomainAttempted;
      if (outcome.status) next.customDomainStatus = outcome.status;
      else delete next.customDomainStatus;
      if (outcome.kept) next.customDomainKept = outcome.kept;
      else delete next.customDomainKept;
      return next;
    case "failed":
      return next;
  }
}

/**
 * The custom-domain part of an install or uninstall's input, from the config:
 * the domain to attach, and the earlier names whose records and certificates
 * the run's grants must still cover.
 */
export function customDomainInstallInput(config: {
  customDomain?: string;
  customDomainStatus?: CustomDomainStatus;
  customDomainAttempted?: string;
  customDomainKept?: KeptCertificate;
  cloudfrontDomain?: string;
}): {
  customDomain?: string;
  previousCustomDomain?: string;
  attemptedCustomDomain?: string;
  heldCertificate?: KeptCertificate;
  activeExternalDomain?: string;
  cloudfrontDomain?: string;
} {
  const status = config.customDomainStatus;
  return {
    customDomain: config.customDomain || undefined,
    previousCustomDomain: status?.name,
    attemptedCustomDomain: config.customDomainAttempted,
    heldCertificate: certificateOnDistribution(status, config.customDomainKept),
    activeExternalDomain:
      status?.mode === "external" &&
      status.status === "active" &&
      status.aliasTarget === config.cloudfrontDomain
        ? status.name
        : undefined,
    cloudfrontDomain: config.cloudfrontDomain,
  };
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
 * out the validation timeout. Such a domain takes external mode instead. For
 * the same reason, a name between the zone and the domain that public DNS
 * delegates to other name servers hides the zone's records, and the domain
 * takes external mode.
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
  // Each name strictly between the domain and the zone, deepest first.
  const labels = domain.split(".");
  const depth = labels.length - best.name.split(".").length;
  for (let i = 0; i < depth; i++) {
    const name = labels.slice(i).join(".");
    let servers: string[];
    try {
      servers = await dns.resolveNs(name);
    } catch {
      // ENODATA or ENOTFOUND: the name has no delegation of its own.
      continue;
    }
    if (
      servers.length > 0 &&
      !servers.some((n) => assigned.has(n.toLowerCase().replace(/\.$/, "")))
    ) {
      console.log(
        `${name} is delegated to ${servers.join(", ")}, not to Route53 zone ${best.name}; ` +
          "treating the domain as hosted elsewhere.",
      );
      return null;
    }
  }
  return best;
}

/** A Route53 name as the API returns it, in the form every check compares. */
function normalizeRecordName(name: string): string {
  return name.replace(/\\052/g, "*").toLowerCase().replace(/\.$/, "");
}

/** The record types that would take the name the stack's alias record needs. */
const CONFLICTING_TYPES = new Set(["A", "AAAA", "CNAME"]);

/**
 * The records at exactly `name` that would stop a route53-mode install, as
 * text naming each one. An A or AAAA alias to one of `ownedAliasTargets`, this
 * deployment's own distribution, belongs to the stack: a rerun after Pulumi
 * created it, or an AAAA record an earlier version wrote, which the run then
 * deletes. Any other A, AAAA or CNAME belongs to the operator, and the stack's
 * alias record never overwrites one.
 */
export async function findForeignRecords(opts: {
  name: string;
  hostedZoneId: string;
  ownedAliasTargets: readonly string[];
  creds: AwsCredentials;
}): Promise<string[]> {
  const route53 = new Route53Client({
    region: "us-east-1",
    credentials: credentialsOf(opts.creds),
  });
  const owned = new Set(opts.ownedAliasTargets.map(normalizeRecordName));
  const atName: ResourceRecordSet[] = [];
  let start: { name?: string; type?: string; identifier?: string } = { name: `${opts.name}.` };
  for (;;) {
    const page = await route53.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: opts.hostedZoneId,
        StartRecordName: start.name,
        StartRecordType: start.type as never,
        StartRecordIdentifier: start.identifier,
      }),
    );
    const sets = page.ResourceRecordSets ?? [];
    // Route53 lists from the start name onward in its own order, so the
    // records after this name (a sibling, a deeper name) follow; stop there.
    const here = sets.filter((r) => normalizeRecordName(r.Name ?? "") === opts.name);
    atName.push(...here);
    const next = page.NextRecordName && normalizeRecordName(page.NextRecordName);
    if (!page.IsTruncated || next !== opts.name || here.length < sets.length) break;
    start = {
      name: page.NextRecordName,
      type: page.NextRecordType,
      identifier: page.NextRecordIdentifier,
    };
  }
  return atName
    .filter((r) => CONFLICTING_TYPES.has(r.Type ?? ""))
    .filter((r) => {
      const target = r.AliasTarget?.DNSName;
      return !(r.Type !== "CNAME" && target && owned.has(normalizeRecordName(target)));
    })
    .map((r) => {
      const value = r.AliasTarget?.DNSName
        ? `alias to ${normalizeRecordName(r.AliasTarget.DNSName)}`
        : (r.ResourceRecords ?? []).map((v) => v.Value).join(", ");
      return `${r.Type} ${opts.name} (${value})`;
    });
}

/**
 * Refuse a route53-mode install when the domain already holds a record the
 * stack does not own. Runs before `pulumi up` creates the certificate, so a
 * refusal leaves nothing behind.
 */
export async function assertNoForeignRecords(opts: {
  name: string;
  hostedZoneId: string;
  ownedAliasTargets: readonly string[];
  creds: AwsCredentials;
}): Promise<void> {
  const foreign = await findForeignRecords(opts);
  if (foreign.length === 0) return;
  throw new Error(
    `Route53 already has ${foreign.join(" and ")} in zone ${opts.hostedZoneId}. ` +
      `The install will not replace a record it did not create. Remove the record, ` +
      `then install again.`,
  );
}

/** A certificate the installer found by tag. */
export interface TaggedCertificate {
  arn: string;
  domain: string;
  status: string;
  /** Requested by the installer for an external-DNS domain, not by Pulumi. */
  external: boolean;
}

/**
 * The certificates in us-east-1 that carry every one of `tags`, for one of
 * `domains` when given. A summary for any other domain is skipped before its
 * tags are read, so the cost tracks the domains in play rather than the
 * account's certificates.
 */
async function findTaggedCertificates(
  acm: ACMClient,
  tags: Record<string, string>,
  domains?: ReadonlySet<string>,
): Promise<TaggedCertificate[]> {
  const found: TaggedCertificate[] = [];
  const paginator = paginateListCertificates(
    { client: acm },
    // Without a status filter ACM lists only some statuses.
    { CertificateStatuses: Object.values(CertificateStatus) },
  );
  for await (const page of paginator) {
    for (const summary of page.CertificateSummaryList ?? []) {
      if (!summary.CertificateArn || !summary.DomainName) continue;
      if (domains && !domains.has(summary.DomainName.toLowerCase())) continue;
      const listed = await acm.send(
        new ListTagsForCertificateCommand({ CertificateArn: summary.CertificateArn }),
      );
      const held = new Map((listed.Tags ?? []).map((t) => [t.Key, t.Value]));
      if (Object.entries(tags).every(([k, v]) => held.get(k) === v)) {
        found.push({
          arn: summary.CertificateArn,
          domain: summary.DomainName.toLowerCase(),
          status: summary.Status ?? "",
          external: held.get(TAG_MODE) === "external",
        });
      }
    }
  }
  return found;
}

/**
 * This deployment's certificates, of either mode: for the domains an install
 * has in play, or every one when `domains` is omitted, as the uninstall needs.
 * One install lists once and hands the result to both
 * ensureExternalCertificate and deleteUnusedCertificates.
 */
export async function listDeploymentCertificates(opts: {
  stackPrefix: string;
  domains?: readonly string[];
  creds: AwsCredentials;
}): Promise<TaggedCertificate[]> {
  return findTaggedCertificates(
    acmClient(opts.creds),
    deploymentTags(opts.stackPrefix),
    opts.domains ? new Set(opts.domains) : undefined,
  );
}

/** The tags on every certificate of the deployment, in either mode. */
function deploymentTags(stackPrefix: string): Record<string, string> {
  return {
    [TAG_MANAGED]: "true",
    [TAG_APP_ID]: "cloud-data-server",
    [TAG_STACK_PREFIX]: stackPrefix,
  };
}

function externalTags(stackPrefix: string): Record<string, string> {
  return { ...deploymentTags(stackPrefix), [TAG_MODE]: "external" };
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
  /** This install's listing, from listDeploymentCertificates. */
  certificates: readonly TaggedCertificate[];
  creds: AwsCredentials;
}): Promise<{ certificateArn: string; issued: boolean; validationRecord?: ValidationRecord }> {
  const acm = acmClient(opts.creds);
  const tags = externalTags(opts.stackPrefix);
  const mine = opts.certificates.filter((c) => c.external && c.domain === opts.domain);

  // An issued certificate first: it is the one most likely attached, and the
  // one this run keeps among duplicates.
  const rank = (status: string) =>
    status === CertificateStatus.ISSUED
      ? 0
      : status === CertificateStatus.PENDING_VALIDATION
        ? 1
        : 2;
  const ordered = [...mine].sort((a, b) => rank(a.status) - rank(b.status));

  let arn: string | undefined;
  for (const cert of ordered) {
    if (DEAD_STATUSES.has(cert.status) || arn) {
      console.log(`Deleting certificate ${cert.arn} (${cert.status}) for ${opts.domain}.`);
      try {
        await acm.send(new DeleteCertificateCommand({ CertificateArn: cert.arn }));
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== "ResourceInUseException" && name !== "ResourceNotFoundException") throw err;
        // The distribution still holds it. The run attaches a live certificate
        // once ACM issues one, and that swap releases this one at once; the
        // run's cleanup then deletes it.
        console.log(`Leaving certificate ${cert.arn} until a live one replaces it: ${name}.`);
      }
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
        // No IdempotencyToken: a fixed token hands back, for an hour, the
        // certificate the loop above may just have deleted. ACM applies the
        // tags in this same request, so a rerun finds a pending certificate
        // by tag instead.
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
 * Delete every certificate in the listing except those in `keepArns`.
 *
 * Runs after `pulumi up` or `pulumi destroy`. The certificates it deletes left
 * the distribution by a swap or with the distribution itself, and ACM releases
 * a certificate at once after either. A removal never detaches a certificate:
 * the distribution keeps it with no alias. A delete that fails therefore means
 * an assumption broke, and the run stops with an error that names the
 * certificate and what ACM says still uses it. A rerun deletes it.
 */
export async function deleteUnusedCertificates(opts: {
  keepArns: readonly (string | undefined)[];
  /** This run's listing, from listDeploymentCertificates. */
  certificates: readonly TaggedCertificate[];
  creds: AwsCredentials;
}): Promise<void> {
  const acm = acmClient(opts.creds);
  for (const cert of opts.certificates) {
    if (opts.keepArns.includes(cert.arn)) continue;
    console.log(`Deleting unused certificate ${cert.arn} for ${cert.domain}.`);
    try {
      await acm.send(new DeleteCertificateCommand({ CertificateArn: cert.arn }));
    } catch (err) {
      // ensureExternalCertificate already deleted a dead certificate from the
      // same listing.
      if ((err as { name?: string }).name === "ResourceNotFoundException") continue;
      let inUseBy: string[] = [];
      try {
        const described = await acm.send(
          new DescribeCertificateCommand({ CertificateArn: cert.arn }),
        );
        inUseBy = described.Certificate?.InUseBy ?? [];
      } catch {
        // The error below names the certificate either way.
      }
      throw new Error(
        `Could not delete certificate ${cert.arn} for ${cert.domain}` +
          (inUseBy.length > 0 ? `, which ACM reports in use by ${inUseBy.join(", ")}` : "") +
          `: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
