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

import { promises as dns } from "node:dns";
import { ACMClient, DescribeCertificateCommand } from "@aws-sdk/client-acm";
import {
  validateCustomDomain,
  type CustomDomainStatus,
} from "@starkeep/admin-installer/custom-domain";
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

  const result: CustomDomainCheck = { pointsAtDistribution: await pointsAt(status) };
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

/**
 * Whether the domain reaches the distribution: a CNAME to its name, or, for a
 * provider that flattens the record or a Route53 alias, the same addresses.
 */
async function pointsAt(status: CustomDomainStatus): Promise<boolean> {
  const target = status.aliasTarget.toLowerCase();
  try {
    const cnames = await dns.resolveCname(status.name);
    if (cnames.some((c) => c.toLowerCase().replace(/\.$/, "") === target)) return true;
  } catch {
    // No CNAME: an alias or a flattened record may still answer.
  }
  try {
    const [mine, theirs] = await Promise.all([dns.resolve4(status.name), dns.resolve4(target)]);
    const theirSet = new Set(theirs);
    return mine.length > 0 && mine.every((a) => theirSet.has(a));
  } catch {
    return false;
  }
}
