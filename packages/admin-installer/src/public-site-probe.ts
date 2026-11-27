/**
 * The cloud install's check that an app's public site answers at its address.
 *
 * The site needs two deployment updates that an app install cannot make: the
 * bootstrap stack's bucket policy lets CloudFront read `_site/`, and the cloud
 * data server's distribution routes `/sites/*` to the bucket. Each missing
 * update answers in its own way, so the probe can name the fix.
 */

import { publicSitePath } from "@starkeep/admin-manifest";

export interface PublicSiteProbe {
  url: string;
  /** The last status the address answered, or null when it never answered. */
  status: number | null;
  ok: boolean;
  /** What the cloud operator should do, when the site does not answer. */
  advice: string | null;
}

const UPDATE_ADVICE =
  "Update the bootstrap stack with a fresh template from admin-web, then reinstall the " +
  "cloud data server, then install this app again.";

/** Ask for the site's home page a few times, since a fresh upload can lag. */
export async function probePublicSite(
  baseUrl: string,
  appId: string,
  fetchImpl: typeof fetch = fetch,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<PublicSiteProbe> {
  const url = `${baseUrl.replace(/\/+$/, "")}${publicSitePath(appId)}`;
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 2000;
  let status: number | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, { redirect: "manual" });
      status = res.status;
      if (res.ok) return { url, status, ok: true, advice: null };
    } catch {
      status = null;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return {
    url,
    status,
    ok: false,
    advice:
      status === 404 || status === 403
        ? // 404 from the gateway: the distribution has no /sites/* behavior.
          // 403 from S3: the bucket policy does not let CloudFront read _site/.
          `The deployment predates public sites. ${UPDATE_ADVICE}`
        : `Check the deployment's CloudFront distribution. ${UPDATE_ADVICE}`,
  };
}
