# Core Concepts

## User-owned infrastructure

In most apps, all users share a single database managed by the developer. Starkeep flips
this: each user gets their own isolated cloud infrastructure — a dedicated database, file
storage bucket, and API endpoint. The developer's code runs against each user's stack, but
no user's data is co-mingled with another's.

This architecture means users can take their data with them, grant access on their own terms,
and trust that their data isn't accessible to other app users by default.

## Data records

A **data record** is the fundamental unit of user content. It represents anything a user
creates or stores: a task, a photo, a document, a message. Every data record has:

- A globally unique, time-sortable identifier
- A **type** that declares what kind of data it contains (e.g., `tasks:task`, `photos:photo`)
- A **payload** — a freeform object containing the record's actual content
- Ownership and timestamp information
- A **sync status** tracking whether the record exists only locally, only in the cloud,
  or has been reconciled between the two

Records can optionally be **file-backed**: a photo or document record carries a reference
to a file in object storage, identified by its content hash.

## Metadata

**Metadata records** are derived from data records by generators. They are not entered by
hand — they are computed. A generator might extract the dimensions of an image, summarize
the properties of a file, or run an AI model over the content of a message.

Metadata records reference their source data record but data records have no knowledge of
their metadata. This separation means generators can be added, removed, or updated without
touching existing data.

Each metadata record tracks the version of the generator that produced it and a hash of
the inputs it was given. This allows the system to detect when metadata is stale and needs
to be regenerated.

## Types and the type registry

Every data and metadata record has a **type**, written as `namespace:name` (e.g.,
`tasks:task`, `@starkeep/metadata-core:image-dimensions`). Namespacing prevents collisions
between types defined by different developers or packages.

Types are registered in a **type registry** with an optional schema for validating payloads.
The registry is the single source of truth for what types exist in an application.

## Search and querying

The **unified index** lets you query across data records and their metadata simultaneously.
A query can filter by record type, date range, full-text content, or values in metadata
fields — for example, all photos wider than 3000 pixels, or all tasks assigned to a
specific person.

**Aggregations** compute summaries over a collection: total counts, total storage used,
breakdowns by type or MIME type, and histograms by date. These are cached and can be
updated incrementally as records change.

## Sync

**Sync** reconciles local and remote state. Starkeep uses a pull-then-push model:

1. **Pull** — fetch changes from the cloud that aren't yet on this device
2. **Merge** — apply conflict resolution to any records modified both locally and remotely
3. **Push** — send local changes to the cloud

Conflicts are resolved by **last-writer-wins**: when two versions of the same record exist,
the one with the later timestamp is kept. Timestamps use Hybrid Logical Clocks (see below),
which provide a reliable total ordering across devices without coordination.

File sync is content-addressed: files are identified by their SHA-256 hash, so a file that
already exists in the cloud is never transferred again even if it was re-created locally.

## Access control

**Access policies** define who can do what. A policy names a subject (a user, app, API key,
or sharing token), a resource (a specific record, a type, a collection, or everything), and
a set of permitted operations (read, write, delete, admin). Policies support expiration.

Access is enforced at the storage layer — every database operation goes through a policy
check before it executes, regardless of which code path initiated it.

**Sharing tokens** are cryptographic tokens tied to a policy. A user can share a token
externally; the recipient presents it to gain the access the policy grants. Tokens can be
revoked by deleting the policy.

## Identifiers and ordering

Every record is identified by a **ULID** — a 26-character string that encodes a millisecond
timestamp followed by random bits. ULIDs are globally unique without coordination and
lexicographically sort in creation order.

Every mutation is timestamped with a **Hybrid Logical Clock (HLC)** timestamp. An HLC
combines a physical wall-clock time, a logical counter, and a node identifier. The counter
advances when multiple events occur within the same millisecond; the node identifier
breaks ties deterministically across devices. Together, these three components provide a
total ordering over all events across all devices — the foundation for conflict resolution
in sync.
