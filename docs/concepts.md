# Concepts

## User-Owned Infrastructure

In Starkeep, each user has their own isolated cloud resources: a database, a file storage bucket, and an API endpoint. App developers access user data only through the SDK — they never have direct credentials to any user's infrastructure.

This means users can revoke an app's access, export their data, or move to a different app without losing anything. Data portability is a property of the system, not an afterthought.

## Records

A record is the atomic unit of data in Starkeep. It is a typed payload with a unique identifier, an owner, and timestamps. Records may also have a file attachment (for photos, documents, audio, etc.).

Every record is ontologically independent — it stands alone and doesn't require other records to have meaning. See [Data vs. Metadata App Architecture](data-vs-metadata-app-architecture.md) for guidance on when something should be a record vs. metadata.

## Metadata

Metadata is derived information about a record, computed by generator functions registered at SDK initialization. Examples: image dimensions, file size, word count, a text preview.

Metadata depends on data, but data never depends on metadata. A record is complete without its metadata; metadata is incomplete without the record it references.

Generators declare what inputs they consume and what they produce. The metadata engine handles ordering, cache invalidation (via input hashing), and re-generation when a record changes.

Some generators produce deterministic outputs (e.g., image dimensions) and don't need to be synced — they can be recomputed on any device. Others produce non-deterministic outputs (e.g., an AI-generated caption) and must be synced from the device that first produced them.

## Types

Every record has a type that determines its schema and which apps can access it. Starkeep maintains a fixed **core type registry** — a closed set of well-known types such as `image` and `markdown`. Apps cannot define new types.

This constraint is intentional. A fixed type set means the system can provide consistent per-type metadata tables, schema enforcement, and access grants without needing a dynamic registry. It also prevents type proliferation across a multi-app ecosystem.

### The Unknown Holding Pen

Apps that receive files of an unrecognized format can ingest them as type `unknown`. Unknown records sit in a holding pen until an authorized app **promotes** them to a typed record. Promotion is a one-way, audited operation logged in `shared.reclassifications`.

Only apps granted `canIngestUnknown` or `canPromoteFromUnknown` can interact with the unknown type. These are explicit flags in the app manifest, not derived from type access declarations.

## Sync

Sync moves data between a user's local storage and their cloud. It is bidirectional: the local device pulls remote changes first, then pushes local changes. This pull-then-push order minimizes conflicts.

When two versions of a record exist — one local, one remote — the conflict is resolved deterministically using Hybrid Logical Clock (HLC) timestamps. HLCs combine a physical clock with a logical counter so that causal order is preserved even without coordination between devices. The record with the higher HLC timestamp wins.

Records can be marked as sync-eligible or kept local-only. Local-only records are never sent to the cloud and never appear on other devices.

## Access Control

Access control operates at two layers.

**IAM layer (hard enforcement):** Every app has its own IAM role, minted by the Manager at install time and bounded by the app permissions boundary. The role's inline policy is derived directly from the app's manifest — if the manifest doesn't declare `image: readwrite`, the IAM policy won't allow S3 writes to the image prefix, and DSQL won't grant INSERT on the image metadata table. No code path can bypass this.

**Application layer (audit trail):** The `shared.access_grants` table mirrors the IAM grants. The protocol-core Lambda reads this table to decide which records to include in sync responses and to tag records with `origin_app_id`. It is not a second enforcement gate — IAM enforces — but it provides a human-readable, queryable audit record of what each app is permitted to do.

Apps that need to access other apps' data (e.g., the data-server acting as a broker) are granted `brokerPower`. A broker app's role can assume other per-app roles, allowing it to act on behalf of other apps in a single request. Brokers still run within per-app role sessions — they never access data with their own base credentials.

## Storage Adapters

All data operations go through abstract adapter interfaces — one for the database, one for file (object) storage. The local implementations use SQLite and the filesystem. The cloud implementations use Aurora DSQL and S3.

Because the interfaces are the same in both environments, application code doesn't change between local and cloud. Swapping adapters is a configuration decision, not a code change.

In cloud deployments, the protocol-core Lambda uses per-app STS-assumed credentials for every adapter. The Lambda execution role itself has no data-plane access — it only holds `sts:AssumeRole` on per-app roles.
