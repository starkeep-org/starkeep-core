import {
  createDataRecord,
  generateId,
  serializeHLC,
  type DataRecord,
  type HLCTimestamp,
  type StarkeepId,
} from "@starkeep/core";
import type { AppSyncableRowEntry } from "../../src/types.js";
import { FILE_RECORDS_TABLE } from "./mock-app-source.js";
import type { Operation, ResolvedSpec, Side } from "./types.js";

const NEW_BLOB_BYTES = new Uint8Array([7, 8, 9]);

/**
 * Apply a single operation on the named side. Insert generates a fresh id and
 * pushes it to `ctx.subjectIds`; update and soft-delete target the first
 * tracked subject (or `op.target`).
 */
export async function driveOperation(
  op: Operation,
  spec: ResolvedSpec,
  local: Side,
  cloud: Side,
  ctx: {
    objectKeyById: Map<StarkeepId, string>;
    subjectIds: StarkeepId[];
  },
): Promise<{ insertedId?: StarkeepId }> {
  if (spec.dt === "SR") return driveSrOperation(op, local, cloud, ctx);
  if (spec.dt === "AR") return driveArOperation(op, spec, local, cloud, ctx);
  return driveAwOperation(op, spec, local, cloud, ctx);
}

async function driveSrOperation(
  op: Operation,
  local: Side,
  cloud: Side,
  ctx: {
    objectKeyById: Map<StarkeepId, string>;
    subjectIds: StarkeepId[];
  },
): Promise<{ insertedId?: StarkeepId }> {
  const side = op.side === "local" ? local : cloud;
  switch (op.verb) {
    case "insert": {
      const objectKey = `shared/test/photo/insert-${side.role}-${Date.now()}-${Math.random()}`;
      const record = createDataRecord(
        {
          type: "@test/photo",
          ownerId: "u1",
          originAppId: "test",
          contentHash: `sha256:${op.side}-insert`,
          objectStorageKey: objectKey,
          mimeType: "image/jpeg",
          sizeBytes: 100,
        },
        side.clock,
      );
      await side.db.put(record);
      ctx.objectKeyById.set(record.id, objectKey);
      ctx.subjectIds.push(record.id);
      if (op.withBlob !== false) {
        await side.storage.put(objectKey, op.newContent ?? NEW_BLOB_BYTES, {
          contentType: "image/jpeg",
        });
      }
      return { insertedId: record.id };
    }
    case "update": {
      const id = op.target ?? ctx.subjectIds[0];
      if (!id) throw new Error("[harness] update op missing target id");
      const existing = await side.db.get(id);
      if (!existing)
        throw new Error(
          `[harness] SR update target ${id} not present on ${side.role}`,
        );
      const updated: DataRecord = {
        ...existing,
        updatedAt: side.clock.now(),
        contentHash: `sha256:${op.side}-updated`,
      };
      await side.db.put(updated);
      if (op.withBlob) {
        await side.storage.put(
          existing.objectStorageKey,
          op.newContent ?? NEW_BLOB_BYTES,
          { contentType: existing.mimeType },
        );
      }
      return {};
    }
    case "soft-delete": {
      const id = op.target ?? ctx.subjectIds[0];
      if (!id) throw new Error("[harness] soft-delete op missing target id");
      await side.db.delete(id, side.clock.now());
      return {};
    }
  }
}

async function driveArOperation(
  op: Operation,
  spec: ResolvedSpec,
  local: Side,
  cloud: Side,
  ctx: {
    objectKeyById: Map<StarkeepId, string>;
    subjectIds: StarkeepId[];
  },
): Promise<{ insertedId?: StarkeepId }> {
  const side = op.side === "local" ? local : cloud;
  switch (op.verb) {
    case "insert": {
      const id = generateId() as StarkeepId;
      // No-blob AR rows use an empty object_storage_key so manifestForAppRow
      // returns null and the engine ships metadata without a blob attempt.
      const wantsBlob = op.withBlob !== false;
      const objectKey = wantsBlob ? `app/${spec.appId}/${id}` : "";
      const hlc = side.clock.now();
      const entry = arEntry(id, objectKey, hlc, "insert", spec.appId, {
        contentHash: `sha256:${op.side}-insert`,
        deletedAt: null,
      });
      await side.applier.apply(entry);
      ctx.objectKeyById.set(id, objectKey);
      ctx.subjectIds.push(id);
      if (wantsBlob) {
        await side.storage.put(objectKey, op.newContent ?? NEW_BLOB_BYTES, {
          contentType: "image/jpeg",
        });
      }
      return { insertedId: id };
    }
    case "update": {
      const id = op.target ?? ctx.subjectIds[0];
      if (!id) throw new Error("[harness] AR update missing target id");
      const objectKey =
        ctx.objectKeyById.get(id) ?? `app/${spec.appId}/${id}`;
      const hlc = side.clock.now();
      const entry = arEntry(id, objectKey, hlc, "insert", spec.appId, {
        contentHash: `sha256:${op.side}-updated`,
        deletedAt: null,
      });
      await side.applier.apply(entry);
      if (op.withBlob) {
        await side.storage.put(objectKey, op.newContent ?? NEW_BLOB_BYTES, {
          contentType: "image/jpeg",
        });
      }
      return {};
    }
    case "soft-delete": {
      const id = op.target ?? ctx.subjectIds[0];
      if (!id) throw new Error("[harness] AR soft-delete missing target id");
      const objectKey =
        ctx.objectKeyById.get(id) ?? `app/${spec.appId}/${id}`;
      const hlc = side.clock.now();
      const entry = arEntry(id, objectKey, hlc, "delete", spec.appId, {
        contentHash: "sha256:tombstone",
        deletedAt: hlc,
      });
      await side.applier.apply(entry);
      return {};
    }
  }
}

async function driveAwOperation(
  op: Operation,
  spec: ResolvedSpec,
  local: Side,
  cloud: Side,
  ctx: {
    objectKeyById: Map<StarkeepId, string>;
    subjectIds: StarkeepId[];
  },
): Promise<{ insertedId?: StarkeepId }> {
  const side = op.side === "local" ? local : cloud;
  switch (op.verb) {
    case "insert": {
      const id = generateId() as StarkeepId;
      const hlc = side.clock.now();
      const hlcStr = serializeHLC(hlc);
      await side.applier.apply({
        timestamp: hlc,
        appId: spec.appId,
        table: "test_rows",
        op: "insert",
        row: {
          id,
          payload: `${op.side}-insert`,
          updated_at: hlcStr,
          deleted_at: null,
        },
      });
      ctx.subjectIds.push(id);
      return { insertedId: id };
    }
    case "update": {
      const id = op.target ?? ctx.subjectIds[0];
      if (!id) throw new Error("[harness] AW update missing target id");
      const hlc = side.clock.now();
      const hlcStr = serializeHLC(hlc);
      await side.applier.apply({
        timestamp: hlc,
        appId: spec.appId,
        table: "test_rows",
        op: "insert",
        row: {
          id,
          payload: `${op.side}-updated`,
          updated_at: hlcStr,
          deleted_at: null,
        },
      });
      return {};
    }
    case "soft-delete": {
      const id = op.target ?? ctx.subjectIds[0];
      if (!id) throw new Error("[harness] AW soft-delete missing target id");
      const hlc = side.clock.now();
      const hlcStr = serializeHLC(hlc);
      await side.applier.apply({
        timestamp: hlc,
        appId: spec.appId,
        table: "test_rows",
        op: "delete",
        row: {
          id,
          payload: "tombstone",
          updated_at: hlcStr,
          deleted_at: hlcStr,
        },
      });
      return {};
    }
  }
}

function arEntry(
  id: StarkeepId,
  objectKey: string,
  hlc: HLCTimestamp,
  op: "insert" | "delete",
  appId: string,
  opts: { contentHash: string; deletedAt: HLCTimestamp | null },
): AppSyncableRowEntry {
  const hlcStr = serializeHLC(hlc);
  return {
    timestamp: hlc,
    appId,
    table: FILE_RECORDS_TABLE,
    op,
    row: {
      id,
      object_storage_key: objectKey,
      content_hash: opts.contentHash,
      mime_type: "image/jpeg",
      size_bytes: 100,
      original_filename: null,
      origin_app_id: appId,
      created_at: hlcStr,
      updated_at: hlcStr,
      deleted_at: opts.deletedAt ? serializeHLC(opts.deletedAt) : null,
    },
  };
}
