import {
  createDataRecord,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/core";
import type { Operation, ResolvedSpec, Side } from "./types.js";

const NEW_BLOB_BYTES = new Uint8Array([7, 8, 9]);

/**
 * Apply a single operation on the named side. For SR `update`/`soft-delete`,
 * the record id is read from `target` (defaults to the single seeded subject).
 * For SR `insert`, a new id is generated; the harness's `World.subjectId` is
 * updated to point at it.
 *
 * Returns the (possibly newly created) record's id so `setupCase` can update
 * `World.subjectId` after an insert.
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
  if (spec.dt !== "SR") {
    throw new Error(
      `[harness] driveOperation dt=${spec.dt} not implemented yet`,
    );
  }

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
      if (!id) {
        throw new Error("[harness] update operation with no target id");
      }
      const existing = await side.db.get(id);
      if (!existing) {
        throw new Error(
          `[harness] update target ${id} not present on ${side.role}`,
        );
      }
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
      if (!id) {
        throw new Error("[harness] soft-delete operation with no target id");
      }
      await side.db.delete(id, side.clock.now());
      return {};
    }
  }
}
