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
 *
 * Also the switch for Starkeep Drive's capability. Drive has no cloud target,
 * so its manifest cannot declare `publicSharing`, and the install DDL leaves
 * its `public_sharing.app_capabilities` row alone. The operator writes or
 * deletes the row here instead, as the installer, which holds INSERT and
 * DELETE on the table. The switch starts off.
 */

import { compiler, openInstallerPool } from "../lib/installer-dsql";

const DRIVE_APP_ID = "starkeep-drive";

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
        "source_kind",
        "label_key",
        "label_value",
        "record_id",
        "serves",
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
      source_kind: "label" | "record";
      label_key: string | null;
      label_value: string | null;
      record_id: string | null;
      serves: "stand-in" | "original";
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
        source:
          r.source_kind === "record"
            ? { kind: "record", recordId: r.record_id }
            : { kind: "label", key: r.label_key, value: r.label_value },
        serves: r.serves,
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

/**
 * Whether Starkeep Drive may create public links. Body: the operator's
 * credentials, plus `enabled` (boolean) to change it. Answers `{ enabled }`.
 */
export async function driveCapability(req: Request) {
  const opened = await openInstallerPool(req);
  if (opened instanceof Response) return opened;
  const { pool, body } = opened;
  try {
    const enabled = body["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    if (enabled === true) {
      const q = compiler
        .insertInto("public_sharing.app_capabilities")
        .values({ app_id: DRIVE_APP_ID })
        .onConflict((oc) => oc.column("app_id").doNothing())
        .compile();
      await pool.query(q.sql, [...q.parameters]);
    } else if (enabled === false) {
      const q = compiler
        .deleteFrom("public_sharing.app_capabilities")
        .where("app_id", "=", DRIVE_APP_ID)
        .compile();
      await pool.query(q.sql, [...q.parameters]);
    }
    const q = compiler
      .selectFrom("public_sharing.app_capabilities")
      .select("app_id")
      .where("app_id", "=", DRIVE_APP_ID)
      .compile();
    const result = await pool.query(q.sql, [...q.parameters]);
    return Response.json({ enabled: result.rows.length > 0 });
  } catch (err) {
    return Response.json(
      { error: `DSQL query failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  } finally {
    await pool.end().catch(() => {});
  }
}
