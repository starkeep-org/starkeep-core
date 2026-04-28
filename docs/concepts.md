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

Every record has a type in `namespace:name` format — for example, `tasks:task` or `@starkeep/image`. Types have schemas that are validated at write time, so bad data never enters storage.

A type registry is the single source of truth for the types an app understands. Registering a type also associates its schema and any metadata generators that apply to it.

## Sync

Sync moves data between a user's local storage and their cloud. It is bidirectional: the local device pulls remote changes first, then pushes local changes. This pull-then-push order minimizes conflicts.

When two versions of a record exist — one local, one remote — the conflict is resolved deterministically using Hybrid Logical Clock (HLC) timestamps. HLCs combine a physical clock with a logical counter so that causal order is preserved even without coordination between devices. The record with the higher HLC timestamp wins.

Records can be marked as sync-eligible or kept local-only. Local-only records are never sent to the cloud and never appear on other devices.

## Access Control

Access control governs who can do what with which data. Subjects (a user, an app, or a sharing token) are granted specific permissions (read, write, delete, admin) on specific resources (a single record, all records of a type, or a collection).

Policies are enforced at the storage layer, not at the application layer. There is no way for app code to bypass them.

Sharing tokens are time-limited, optionally usage-limited credentials that grant a specific set of permissions. They are the mechanism for giving external users or services scoped access to a subset of data.

## Storage Adapters

All data operations go through abstract adapter interfaces — one for the database, one for file (object) storage. The local implementations use SQLite and the filesystem. The cloud implementations use Aurora DSQL and S3.

Because the interfaces are the same in both environments, application code doesn't change between local and cloud. Swapping adapters is a configuration decision, not a code change.
