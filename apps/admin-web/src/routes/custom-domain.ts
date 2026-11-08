/**
 * The cloud's custom domain: setting it, and checking on it between installs.
 *
 * The domain is the operator's choice in `~/.starkeep/config.json`, and the
 * cloud data server install acts on it: the install attaches the domain, or,
 * when the domain's DNS lives outside the AWS account, requests a certificate
 * and reports the record to add (`customDomainStatus`). See
 * `packages/admin-installer/src/custom-domain.ts`.
 *
 * - PUT  — `{ domain: string | null }` sets or clears the domain. The next
 *          install acts on it.
 * - POST /check — `{ credentials }`, the operator's session. Reads whether ACM
 *          has issued an external-DNS domain's certificate, as admin-app, and
 *          whether the domain resolves to the distribution yet.
 * - POST /zone — `{ domain, credentials }`. Checks the domain as PUT does, then
 *          finds the Route53 zone in this account the install would write to,
 *          as admin-app, so "Set up" can show the records before it saves.
 */

import { ACMClient, DescribeCertificateCommand } from "@aws-sdk/client-acm";
import {
  customDomainPolicyFits,
  domainPointsAt,
  findHostedZone,
  pendingAttemptBlocking,
  pendingAttemptRefusal,
  validateCustomDomain,
  type CustomDomainConfigFields,
} from "@starkeep/admin-installer/custom-domain";
import { regionFromUserPoolId } from "../lib/cloud-config";
import { readStarkeepConfig } from "../lib/manager-credentials";
import { crossSiteRefusal, fromOwnPage } from "../lib/same-origin";
import type { STSCredentials } from "../lib/cognito-auth";
import * as config from "./config";

export async function PUT(req: Request): Promise<Response> {
  if (!fromOwnPage(req)) return crossSiteRefusal();
  let body: { domain?: unknown };
  try {
    body = (await req.json()) as { domain?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  let domain: string | null = null;
  if (typeof body.domain === "string" && body.domain.trim() !== "") {
    try {
      domain = validateCustomDomain(body.domain);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
    const refusal = setRefusal(domain);
    if (refusal) return Response.json({ error: refusal }, { status: 400 });
  }
  // The config route's PATCH deletes a field given null. It checks the origin
  // again, so the request carries this one's Origin and Host.
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  return config.PATCH(
    new Request(req.url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ customDomain: domain }),
    }),
  );
}

type DomainConfig = CustomDomainConfigFields & { stackPrefix?: string; userPoolId?: string };

/**
 * Why `domain` cannot be set now, or null: a failed attempt at another domain
 * still waits for its cleanup, or the next install's grants would not fit.
 */
function setRefusal(domain: string): string | null {
  const config = readStarkeepConfig() as DomainConfig;
  const attempted = pendingAttemptBlocking(config, domain);
  if (attempted) return pendingAttemptRefusal(attempted);
  return quotaRefusal(config, domain);
}

/**
 * The next install's grants name this domain, the one the last install acted
 * on, one an unfinished install attempted, and the one whose certificate the
 * distribution keeps. IAM caps the role's inline policies together, so a
 * domain that would overflow the cap fails here rather than at the install's
 * PutRolePolicy. The refusal names the other domains when they, not this one
 * alone, push the grants over: the install must still delete their records.
 */
function quotaRefusal(config: DomainConfig, domain: string): string | null {
  if (!config.stackPrefix || !config.userPoolId) return null;
  const region = regionFromUserPoolId(config.userPoolId);
  const fits = (domains: string[]) => customDomainPolicyFits(config.stackPrefix!, region, domains);
  const others = [
    ...new Set(
      [
        config.customDomainStatus?.name,
        config.customDomainAttempted,
        config.customDomainKept?.name,
      ].filter((d): d is string => !!d && d !== domain),
    ),
  ];
  if (fits([domain, ...others])) return null;
  if (others.length > 0 && fits([domain])) {
    return (
      `${domain} does not fit beside ${others.join(" and ")}: the next install must still ` +
      `delete ${others.length > 1 ? "their" : "its"} records and certificate, and the ` +
      "permissions for all of them would not fit IAM's inline-policy quota. Choose a shorter domain."
    );
  }
  return (
    `${domain} is too long: the install's permissions for it would not fit IAM's ` +
    "inline-policy quota. Choose a shorter domain."
  );
}

/** The request's JSON body, or null when it is missing or malformed. */
async function jsonBody<T>(req: Request): Promise<T | null> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === "object" ? (body as T) : null;
  } catch {
    return null;
  }
}

const INVALID_BODY = () => Response.json({ error: "Invalid JSON body" }, { status: 400 });

export interface CustomDomainZone {
  /** The domain in the form PUT saves. */
  domain: string;
  /** The account's Route53 zone the install writes the domain's records to, or null. */
  zone: string | null;
}

export async function ZONE(req: Request): Promise<Response> {
  if (!fromOwnPage(req)) return crossSiteRefusal();
  const body = await jsonBody<{ domain?: unknown; credentials?: STSCredentials }>(req);
  if (!body) return INVALID_BODY();
  const { domain: raw, credentials } = body;
  if (!credentials) return Response.json({ error: "credentials required" }, { status: 400 });
  let domain: string;
  try {
    domain = validateCustomDomain(typeof raw === "string" ? raw : "");
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
  const refusal = setRefusal(domain);
  if (refusal) return Response.json({ error: refusal }, { status: 400 });
  try {
    const zone = await findHostedZone(domain, {
      ...credentials,
      expiration: new Date(credentials.expiration),
    });
    return Response.json({ domain, zone: zone?.name ?? null } satisfies CustomDomainZone);
  } catch (err) {
    return Response.json(
      {
        error: `Could not read the account's DNS zones: ${err instanceof Error ? err.message : err}`,
      },
      { status: 502 },
    );
  }
}

export interface CustomDomainCheck {
  /** ACM's status for an external-DNS domain's certificate, e.g. ISSUED. */
  certificateStatus?: string;
  /** Whether public DNS sends the domain to the distribution. */
  pointsAtDistribution: boolean;
}

export async function CHECK(req: Request): Promise<Response> {
  if (!fromOwnPage(req)) return crossSiteRefusal();
  const body = await jsonBody<{ credentials?: STSCredentials }>(req);
  if (!body) return INVALID_BODY();
  const { credentials } = body;
  if (!credentials) return Response.json({ error: "credentials required" }, { status: 400 });
  const status = (readStarkeepConfig() as CustomDomainConfigFields).customDomainStatus;
  if (!status) {
    return Response.json(
      { error: "No install has acted on a custom domain yet." },
      { status: 400 },
    );
  }

  const result: CustomDomainCheck = {
    pointsAtDistribution: await domainPointsAt(status.name, status.aliasTarget),
  };
  if (status.certificateArn) {
    // CloudFront takes certificates only from us-east-1.
    const acm = new ACMClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });
    try {
      const described = await acm.send(
        new DescribeCertificateCommand({ CertificateArn: status.certificateArn }),
      );
      result.certificateStatus = described.Certificate?.Status;
    } catch (err) {
      return Response.json(
        { error: `Could not read the certificate: ${err instanceof Error ? err.message : err}` },
        { status: 502 },
      );
    }
  }
  return Response.json(result);
}
