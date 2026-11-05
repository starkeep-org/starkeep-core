/**
 * Drive's public links: one file per link, served by the platform's direct
 * link, `<cloud>/public-shares/<token>/file`.
 *
 *   GET    /api/public-links                     Drive's links, and whether it may make more
 *   POST   /api/public-links  { recordId, serves, title, lifetime }
 *   PATCH  /api/public-links/:id  { title?, lifetime?, rotateLink? }
 *   DELETE /api/public-links/:id                 stop sharing
 *
 * Thin mediations of the platform's owner routes, which the local data server
 * forwards to the cloud with this computer's sign-in. The platform owns every
 * rule that matters: whether Drive may publish at all (the admin-web switch),
 * which record a link may name, whether it may serve an original, and the
 * lifetimes. The browser names a record, never a source or a label.
 *
 * Drive has no viewer of its own, so a link is the platform's direct link, and
 * its address is built here from the cloud's address in
 * `~/.starkeep/config.json`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import {
  createPublicShare,
  deletePublicShare,
  DriveNotInstalledError,
  LdsResponseError,
  listPublicShares,
  updatePublicShare,
  type PublicShare,
} from "../lib/drive-client";

/**
 * The cloud's address, read from the machine's own `~/.starkeep/config.json`:
 * the CloudFront address when known, else the gateway's. Null on a machine
 * with no cloud. Photos reads the same file for its viewer's address.
 */
export function cloudBaseUrl(
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | null {
  try {
    const config = JSON.parse(read(join(starkeepDir(), "config.json"))) as {
      publicBaseUrl?: unknown;
      apiGatewayUrl?: unknown;
    };
    const base = [config.publicBaseUrl, config.apiGatewayUrl].find(
      (v): v is string => typeof v === "string" && /^https:\/\//.test(v),
    );
    return base ? base.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/** A platform share as Drive's page sees it: the record and the link's address. */
function linkView(share: PublicShare, base: string | null) {
  return {
    id: share.id,
    recordId: share.source.kind === "record" ? share.source.recordId : null,
    serves: share.serves,
    title: share.title,
    url: base ? `${base}/public-shares/${share.linkToken}/file` : null,
    createdAtMs: share.createdAtMs,
    expiresAtMs: share.expiresAtMs,
  };
}

export type PublicLinkView = ReturnType<typeof linkView>;

function errorResponse(err: unknown): Response {
  const status =
    err instanceof LdsResponseError
      ? err.status
      : err instanceof DriveNotInstalledError
        ? 503
        : 502;
  return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
}

export async function GET(): Promise<Response> {
  try {
    const { publicShares, mayPublish } = await listPublicShares();
    const base = cloudBaseUrl();
    return Response.json({
      available: true,
      mayPublish,
      links: publicShares.filter((s) => s.source.kind === "record").map((s) => linkView(s, base)),
    });
  } catch (err) {
    // Signed out, offline, or a cloud that refused: the page says why, and
    // the library works on without links.
    return Response.json({
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Whether a write came from Drive's own page. A page on another site can send
 * a `text/plain` POST to this machine without asking first, and a JSON body
 * under that type would parse here. `application/json` makes the browser ask
 * first with a CORS preflight, which Drive never answers, so only a
 * same-origin page can send one. A `DELETE` is preflighted whatever its type.
 */
function isJson(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").split(";")[0]!.trim() === "application/json";
}

const NOT_JSON = () =>
  Response.json({ error: "Content-Type must be application/json" }, { status: 415 });

export async function POST(req: Request): Promise<Response> {
  if (!isJson(req)) return NOT_JSON();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.recordId !== "string" || body.recordId.length === 0) {
    return Response.json({ error: "recordId is required" }, { status: 400 });
  }
  if (typeof body.title !== "string") {
    return Response.json({ error: "title is required" }, { status: 400 });
  }
  const serves = body.serves === "original" ? "original" : "stand-in";
  try {
    const share = await createPublicShare({
      recordId: body.recordId,
      serves,
      title: body.title,
      lifetime: typeof body.lifetime === "string" ? body.lifetime : "30d",
    });
    return Response.json({ link: linkView(share, cloudBaseUrl()) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const SHARE_ID = /^[0-9a-f-]{36}$/;

export async function PATCH(req: Request, id: string): Promise<Response> {
  if (!SHARE_ID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
  if (!isJson(req)) return NOT_JSON();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Body is not JSON" }, { status: 400 });
  const change: { title?: string; lifetime?: string; rotateLink?: true } = {};
  if (typeof body.title === "string") change.title = body.title;
  if (typeof body.lifetime === "string") change.lifetime = body.lifetime;
  if (body.rotateLink === true) change.rotateLink = true;
  try {
    const share = await updatePublicShare(id, change);
    return Response.json({ link: linkView(share, cloudBaseUrl()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(id: string): Promise<Response> {
  if (!SHARE_ID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    await deletePublicShare(id);
    return Response.json({ deleted: id });
  } catch (err) {
    return errorResponse(err);
  }
}
