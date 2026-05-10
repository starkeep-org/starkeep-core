-- Cloud Data Server bootstrap migration.
--
-- Creates the shared schema, manager_ddl + user_data_owner roles, the core
-- shared tables (records, access_grants, reclassifications, s3_orphans),
-- per-type metadata tables for every type registered in the deployed
-- CORE_TYPE_REGISTRY at this version (currently: image, markdown), plus the
-- unknown holding-pen metadata table, the app_install_steps idempotency
-- ledger, and the schema_migrations table itself.
--
-- Token substitutions performed by the migration runner:
--   __INSTALLER_USER__ → PG role name for the installer user
--                        (e.g. "starkeep_installer", lowercased, hyphens→underscores)
--
-- Idempotent: every CREATE uses IF NOT EXISTS or DO blocks so re-runs are safe.

CREATE SCHEMA IF NOT EXISTS shared;

-- schema_migrations — the migration ledger itself. Created first so that even
-- this migration's success can be recorded.
CREATE TABLE IF NOT EXISTS shared.schema_migrations (
  id         text        PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- manager_ddl — Manager's PG identity for future DDL migrations
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'manager_ddl') THEN
    CREATE ROLE manager_ddl LOGIN;
  END IF;
END $$;
GRANT CREATE, USAGE ON SCHEMA shared TO manager_ddl;

-- user_data_owner — reserved for Drive, not yet assumable
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'user_data_owner') THEN
    CREATE ROLE user_data_owner;
  END IF;
END $$;
GRANT ALL PRIVILEGES ON SCHEMA shared TO user_data_owner;

-- shared.records — single flat table for all shared data types
CREATE TABLE IF NOT EXISTS shared.records (
  id            text        PRIMARY KEY,
  type          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  origin_app_id text        NOT NULL,
  parent_id     text        REFERENCES shared.records(id) ON DELETE SET NULL,
  size_bytes    bigint      NOT NULL,
  mime_type     text        NOT NULL
);

ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT ALL ON TABLES TO user_data_owner;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA shared TO user_data_owner;

-- shared.access_grants — source of truth for application-layer enforcement
CREATE TABLE IF NOT EXISTS shared.access_grants (
  app_id         text    NOT NULL,
  type_id        text    NOT NULL,
  access         text    NOT NULL,
  metadata_write boolean NOT NULL DEFAULT false,
  PRIMARY KEY (app_id, type_id)
);
GRANT SELECT ON shared.access_grants TO PUBLIC;
GRANT INSERT, UPDATE, DELETE ON shared.access_grants TO __INSTALLER_USER__;

-- shared.reclassifications — audit log for unknown→typed promotions
CREATE TABLE IF NOT EXISTS shared.reclassifications (
  record_id    text        NOT NULL,
  from_type    text        NOT NULL,
  to_type      text        NOT NULL,
  actor_app_id text        NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);

-- shared.s3_orphans — cleanup queue for post-promotion S3 DELETE failures
CREATE TABLE IF NOT EXISTS shared.s3_orphans (
  s3_key      text        PRIMARY KEY,
  detected_at timestamptz NOT NULL DEFAULT now()
);

-- Per-type metadata tables. One per type in CORE_TYPE_REGISTRY at this version.
-- New types in later versions get a new migration file each.

CREATE TABLE IF NOT EXISTS shared.record_image_metadata (
  record_id   text        PRIMARY KEY REFERENCES shared.records(id) ON DELETE CASCADE,
  width       integer,
  height      integer,
  captured_at timestamptz
);

CREATE TABLE IF NOT EXISTS shared.record_markdown_metadata (
  record_id text PRIMARY KEY REFERENCES shared.records(id) ON DELETE CASCADE
);

-- unknown holding-pen metadata table
CREATE TABLE IF NOT EXISTS shared.record_unknown_metadata (
  record_id text PRIMARY KEY REFERENCES shared.records(id) ON DELETE CASCADE
);

-- app_install_steps — tracks per-step state for idempotent install/uninstall.
-- Created here (rather than by per-app installs) so it exists from the moment
-- cloud-data-server's first install completes.
CREATE TABLE IF NOT EXISTS shared.app_install_steps (
  app_id     text        NOT NULL,
  step       text        NOT NULL,
  status     text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  error      text,
  PRIMARY KEY (app_id, step)
);
GRANT INSERT, UPDATE, SELECT ON shared.app_install_steps TO __INSTALLER_USER__;
