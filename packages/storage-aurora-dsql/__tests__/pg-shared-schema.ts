/**
 * The cloud's shared schema, on Postgres, for tests that run real SQL.
 *
 * Written the way `admin-installer/src/dsql-schema-init.ts` creates it, minus
 * what only DSQL has (`CREATE INDEX ASYNC`, the IAM role mappings, the grants).
 * Every owned table leads with `user_id`, first in its primary key, and
 * `admin-installer/__tests__/dsql-schema-init.test.ts` holds the installer to
 * the same shape, so the two cannot drift apart without a test noticing on one
 * side.
 *
 * Used by `two-users.test.ts` here and by the broker's two-user route test.
 */
import type { PGlite } from "@electric-sql/pglite";
import { CATEGORIES, hasMetadataTable, pgMetadataDdl } from "@starkeep/protocol-primitives";

export async function createSharedSchema(pg: PGlite): Promise<void> {
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS shared;
    CREATE TABLE shared.records (
      user_id text NOT NULL,
      id text NOT NULL,
      type text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      node_id text NOT NULL,
      deleted_at text,
      version integer NOT NULL DEFAULT 1,
      content_hash text NOT NULL,
      object_storage_key text NOT NULL,
      mime_type text,
      size_bytes bigint NOT NULL,
      original_filename text,
      origin_app_id text NOT NULL,
      parent_id text,
      stand_in_role text CHECK (stand_in_role IN ('canonical', 'smaller')),
      fidelity integer,
      canonical_threshold integer,
      self_canonical boolean,
      stand_in_slot text,
      PRIMARY KEY (user_id, id)
    );
    CREATE UNIQUE INDEX uq_records_parent_filename_hash
      ON shared.records (user_id, parent_id, original_filename, content_hash, deleted_at) NULLS NOT DISTINCT;
    CREATE UNIQUE INDEX uq_records_stand_in_slot ON shared.records (user_id, parent_id, stand_in_slot);
    CREATE TABLE shared.record_labels (
      user_id text NOT NULL,
      record_id text NOT NULL,
      app_id text NOT NULL,
      key text NOT NULL,
      value text NOT NULL,
      record_type text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      node_id text NOT NULL,
      deleted_at text,
      PRIMARY KEY (user_id, record_id, app_id, key, value)
    );
    CREATE TABLE shared.node_watermarks_records (
      user_id text NOT NULL,
      type text NOT NULL,
      node_id text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (user_id, type, node_id)
    );
    CREATE TABLE shared.node_watermarks_labels (
      user_id text NOT NULL,
      record_type text NOT NULL,
      node_id text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (user_id, record_type, node_id)
    );
    CREATE TABLE shared.object_availability (
      user_id text NOT NULL,
      object_storage_key text NOT NULL,
      state text NOT NULL,
      tier text,
      expected_latency_hours integer,
      ready_at_ms bigint,
      restored_until_ms bigint,
      observed_at_ms bigint NOT NULL,
      PRIMARY KEY (user_id, object_storage_key)
    );
    CREATE TABLE shared.access_grants (
      app_id text NOT NULL,
      type_id text NOT NULL,
      access text NOT NULL,
      metadata_write boolean NOT NULL DEFAULT false,
      PRIMARY KEY (app_id, type_id)
    );
    CREATE TABLE shared.app_label_keys (
      app_id text NOT NULL,
      key text NOT NULL,
      description text,
      PRIMARY KEY (app_id, key)
    );
    CREATE TABLE shared.app_mobile_identities (
      app_id text PRIMARY KEY,
      android_package text NOT NULL,
      android_cert_digests text NOT NULL,
      callback_scheme text NOT NULL
    );
    CREATE TABLE shared.app_syncable_namespaces (
      app_id text PRIMARY KEY,
      tables_json text NOT NULL,
      files_enabled boolean NOT NULL DEFAULT false
    );
  `);
  for (const c of CATEGORIES.filter((c) => hasMetadataTable(c.id))) {
    await pg.exec(pgMetadataDdl(c));
  }
}

/**
 * An app schema's node watermark table, as `admin-installer/src/dsql-ddl.ts`
 * creates it beside the app's synced tables.
 */
export async function createAppNodeWatermarks(pg: PGlite, schema: string): Promise<void> {
  await pg.exec(`
    CREATE TABLE ${schema}._starkeep_node_watermarks (
      user_id text NOT NULL,
      table_name text NOT NULL,
      node_id text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (user_id, table_name, node_id)
    );
  `);
}
