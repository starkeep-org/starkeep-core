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
 */

import { ACMClient, DescribeCertificateCommand } from "@aws-sdk/client-acm";
import {
  customDomainPolicyFits,
  domainPointsAt,
  validateCustomDomain,
  type CustomDomainStatus,
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
    const refusal = quotaRefusal(domain);
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

/**
 * The next install's grants name this domain, the one the last install acted
 * on, and one an unfinished install attempted. IAM caps the role's inline
 * policies together, so a domain that would overflow the cap fails here rather
 * than at the install's PutRolePolicy.
 */
function quotaRefusal(domain: string): string | null {
  const config = readStarkeepConfig() as {
    stackPrefix?: string;
    userPoolId?: string;
    customDomainStatus?: CustomDomainStatus;
    customDomainAttempted?: string;
  };
  if (!config.stackPrefix || !config.userPoolId) return null;
  const inPlay = [
    ...new Set(
      [domain, config.customDomainStatus?.name, config.customDomainAttempted].filter(
        (d): d is string => !!d,
      ),
    ),
  ];
  if (customDomainPolicyFits(config.stackPrefix, regionFromUserPoolId(config.userPoolId), inPlay)) {
    return null;
  }
  return (
    `${domain} is too long: the install's permissions for it would not fit IAM's ` +
    "inline-policy quota. Choose a shorter domain."
  );
}

export interface CustomDomainCheck {
  /** ACM's status for an external-DNS domain's certificate, e.g. ISSUED. */
  certificateStatus?: string;
  /** Whether public DNS sends the domain to the distribution. */
  pointsAtDistribution: boolean;
}

export async function CHECK(req: Request): Promise<Response> {
  const { credentials } = (await req.json()) as { credentials?: STSCredentials };
  if (!credentials) return Response.json({ error: "credentials required" }, { status: 400 });
  const status = (readStarkeepConfig() as { customDomainStatus?: CustomDomainStatus })
    .customDomainStatus;
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
