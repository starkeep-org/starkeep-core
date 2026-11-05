/**
 * Every public share in the deployment, for the operator: listed across apps
 * and owners, each one revocable.
 *
 * An audit surface on the operator's own machine. A public share is a link
 * anyone may open, created by a person from an app approved to publish them
 * (`infraRequirements.publicSharing`); the owner manages their own from the
 * app, and this is where the operator sees all of them at once and turns one
 * off. Revoking deletes the row, so the next items page answers 404 and the
 * edge stops answering within a minute.
 *
 * Reads and deletes as `<stackPrefix>_installer`, which holds SELECT and
 * DELETE on `public_sharing.public_shares` through the PUBLIC grant. Never
 * returns a share's item-id salt.
 */

import { compiler, openInstallerPool } from "../lib/installer-dsql";

export async function list(req: Request) {
  const opened = await openInstallerPool(req);
  if (opened instanceof Response) return opened;
  const { pool } = opened;
  try {
    const q = compiler
      .selectFrom("public_sharing.public_shares")
      .select([
        "id",
        "link_token",
        "owner_user_id",
        "app_id",
        "label_key",
        "label_value",
        "title",
        "created_at_ms",
        "expires_at_ms",
      ])
      .orderBy("created_at_ms", "desc")
      .compile();
    const result = await pool.query<{
      id: string;
      link_token: string;
      owner_user_id: string;
      app_id: string;
      label_key: string;
      label_value: string;
      title: string;
      created_at_ms: string;
      expires_at_ms: string | null;
    }>(q.sql, [...q.parameters]);
    return Response.json({
      publicShares: result.rows.map((r) => ({
        id: r.id,
        linkToken: r.link_token,
        ownerUserId: r.owner_user_id,
        appId: r.app_id,
        labelKey: r.label_key,
        labelValue: r.label_value,
        title: r.title,
        createdAtMs: Number(r.created_at_ms),
        expiresAtMs: r.expires_at_ms === null ? null : Number(r.expires_at_ms),
      })),
    });
  } catch (err) {
    return Response.json(
      { error: `DSQL query failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function revoke(req: Request) {
  const opened = await openInstallerPool(req);
  if (opened instanceof Response) return opened;
  const { pool, body } = opened;
  try {
    const id = body["id"];
    if (typeof id !== "string" || id.length === 0) {
      return Response.json({ error: "id is required" }, { status: 400 });
    }
    const q = compiler.deleteFrom("public_sharing.public_shares").where("id", "=", id).compile();
    await pool.query(q.sql, [...q.parameters]);
    return Response.json({ revoked: id });
  } catch (err) {
    return Response.json(
      { error: `DSQL query failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  } finally {
    await pool.end().catch(() => {});
  }
}
