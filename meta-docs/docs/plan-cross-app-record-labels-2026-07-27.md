# Plan: cross-app record labels

Date: 2026-07-27 (revised same day after review; revised again after a second review)
Status: **agreed; implementation in progress on branch `cross-app-record-labels`.** Two
questions were settled empirically against real DSQL clusters — row-per-key vs jsonb-per-row
(§3a) and the reverse index's shape (§3b) — and everything else was settled in review. §11
records the decisions and the reasoning that changed.
Scope: a new shared label table replacing `records.label`, its write authorization and
quotas, its read API, its SDK surface, and its sync path. Touches protocol-primitives,
both storage adapters, both data servers, the SDK, the sync engine, the app manifest,
and Photos.

**Decisions at a glance.** One mechanism, not two: `shared.record_labels` is added and
`records.label` is **removed** (§9). `parent_id` **stays** (§9a). Caps are a single
manifest-declared limit of 64 keys per app (§6). Writing a label needs only a `read`
grant on the type (§5). The reverse index is
`(app_id, key, deleted_at, value, record_id) INCLUDE (record_type)` — `value` makes bare flags
work with no extra index, `deleted_at` keeps retraction tombstones out of every query's range,
and `record_type` makes the grant check an index condition rather than a post-fetch filter
(§4). **That index shape was verified against a live DSQL cluster** (§3b). Labels get a first-class SDK
surface — **four methods** — with cursor pagination from day one (§7). Record and label writes
share a request but **not** a transaction (§4a). The declared-key registry is **readable
cross-app**, which is what actually delivers the discoverability the manifest declaration is
paid for (§6).

---

## 1. What is actually changing

Today's `records.label` is a **self-classification**: the origin app, at creation, stamps
"this record is of low general interest" (`photos/thumbnail`) so other readers can exclude
it. One value, set once, by the app that made the record.

What's wanted is broader: **assertions about records the asserting app did not create.**
`alpha` says of a photo it never wrote: "I have OCR text for this." `beta`, holding only a
read grant on images, wants to find those photos without asking `alpha` about each one.

An earlier draft of this doc treated those as two different mechanisms and kept both. That
was wrong, and the argument it rested on — that suppressing a record from another app's view
is "the origin's prerogative" — invented an ownership relation the system does not have.
**Shared records are not owned by the apps that created them.** `photos/thumbnail` is
advisory on the read side, and readers choose whether to honor it; that is equally true of
any third-party label. The existing label is not a different kind of thing, it is the
**degenerate case** of the general one: a single key whose author happens to be the origin
app, set once rather than over time.

So there is **one** mechanism. `shared.record_labels` is added, and `records.label` is
removed (§9).

| | `records.label` (removed) | `record_labels` (replacement) |
|---|---|---|
| Author | origin app only | any app with read access to the type |
| Cardinality | 0 or 1 per record | many per record, many authors |
| Mutability | write-once at creation | set, updated, retracted over time |
| Namespacing | `<appId>/` string prefix, validated on write | `app_id` column, server-set (stronger) |
| Filterable | not indexed — and in practice never read at all | indexed in both directions (§4) |

---

## 2. Why a separate table, not a wider `label` column

The obvious move — make `label` a JSON blob or a text array of `appId/purpose` strings —
fails on three counts, all specific to how this system already works:

1. **DSQL OCC contention on the record row.** `occ-retry.ts` exists because DSQL aborts
   transactions that race on the same row. Every app that wants to annotate a photo would
   contend on that photo's single `shared.records` row. A popular record annotated by three
   apps during an import becomes a retry storm. With a per-`(record, app, key)` row, and
   `app_id` server-set from the authenticated caller, **two different apps can never write
   the same row** — the only concurrent writers to a given label row are the same app on two
   devices, which is exactly the case HLC LWW already handles.

   Measured in the §3a POC, and it bites at *any* granularity coarser than one row per key:
   two concurrent transactions setting **two different keys on the same row** — the exact
   pattern a parallel worker fan-out produces — collide with
   `40001: change conflicts with another transaction (OC000)`, and one write is rejected.
   The same two writes as separate rows both committed cleanly. (Control: two *different
   apps* writing the same record never collide in either design, since `app_id` is in the
   primary key either way.)

2. **Whole-record LWW would silently eat labels.** Records are conflict-resolved by
   last-writer-wins on the whole row (`system-design.md` "Sync semantics"). There is no
   field-level merge. Device A adds a label; device B concurrently updates the record's
   metadata; one write wins wholesale and the other's label vanishes. Labels need their own
   row so they get their own HLC and their own LWW domain.

3. **Sync amplification.** A label write would bump `records.updated_at`, which re-ships the
   entire record over the Drive channel and disturbs every peer's watermark. Label writes
   must **not** touch the record row (§8).

*(An earlier draft listed a fourth reason: that the write-once invariant —
`labelHasValidPrefix` plus "set at creation and never changed" — is load-bearing because it
makes the label trustworthy as a filter. It is not load-bearing. A grep of `packages`,
`apps`, and `starkeep-apps` finds **no reader anywhere that filters on `label`**: Photos
writes `photos/thumbnail` in `resize-handler.ts:153` and `app/api/resize/route.ts:141`, both
data servers echo it back, one e2e asserts it round-trips, and that is the whole lifecycle.
There is no trustworthy-filter guarantee to protect. See §9.)*

## 3. Why not the per-category metadata tables

`system-design.md` line 84 states the invariant plainly: metadata columns must be
**deterministically derivable from the file bytes** — "two apps reading the same image see
the same width and height." An app's claim that it has OCR text is derivable from nothing
but that app's own state. Putting it there would break the one property that makes those
tables safe to share, and the columns are platform-declared in `CATEGORIES` anyway, so apps
couldn't extend them without a platform release.

Useful framing to carry forward: the shared plane holds exactly two kinds of thing —
**facts derived from the bytes** (metadata tables, `content_hash`, `size_bytes`) and
**attributed assertions by a named app** (`origin_app_id`, and now labels). Attribution
being part of the data is what makes disagreement representable instead of a conflict:
`alpha/quality=high` and `gamma/quality=low` coexist as two rows, and readers decide whom
to believe.

**This framing has to land in `system-design.md`, not just here.** Its "How data is
classified" section splits user data in two, and puts an app's assertions about a photo in
**app-specific** data — its literal example is "captions on a photo." A label is also an
app's assertion about a shared record, so on the current text an app author cannot tell why
an OCR flag is shared data while a caption is not. The distinguishing property is
*intended audience*: a caption is the app talking to itself, a label is the app talking to
other apps, and only the second earns a place in the shared plane (and the caps in §6 that
come with it). That sentence belongs in the classification section, alongside the rewrite
of the "Advisory interest labels" bullet that §9 forces anyway. Sequenced as step 8.

---

## 3a. Measured: row-per-key beats a jsonb column

DSQL gained `json` and `jsonb` in mid-2026, making one plausible alternative worth testing
before committing: **one row per `(record_id, app_id)` holding all of that app's keys in a
single `jsonb` column.** Fewer rows, trivial per-app byte caps, atomic multi-key updates.

Tested against a real disposable DSQL cluster, both designs seeded with identical logical
data — harness in `e2e-aws/src/poc-record-labels/`. **Row-per-key won decisively; the
jsonb layout is rejected.** Three findings, in order of how much they mattered:

1. **jsonb cannot be indexed on DSQL by any route.** B-tree on the column, `USING gin`
   (with or without `jsonb_path_ops`), and expression indexes on `((labels->>'k'))` are all
   rejected outright; only `INCLUDE (labels)` as a non-key column is accepted. Every jsonb
   *operator* works fine — the machinery was never the problem — but a label filter has no
   seek available and degrades to a scan. A covering index turns a table scan into an
   index-only scan, not a seek, so the cost still grows with the library:

   | Library size | row-per-key (seek) | jsonb + covering index (scan) |
   |---|---|---|
   | 20k records | **3.28 ms** | 100 ms |
   | 60k records | **3.34 ms** | 269 ms |
   | 120k records | **3.40 ms** | 518 ms |

   (DSQL-side `EXPLAIN ANALYZE`, median of 5, "first 50 records where `alpha` set the rare
   key.") Row-per-key is **flat**; jsonb is **linear** at ~4.3 µs/row scanned, so a 1M-photo
   library extrapolates to ~4.3 s per filter query — billed as DPU every time.

2. **Selectivity is what makes jsonb unpredictable.** For a *common* key the two tie exactly
   (37.9 vs 38.6 ms wall), because `LIMIT 50` is satisfied within the first ~64 rows
   scanned. Only *rare* keys are pathological — and rare flags (`needs-review`, `duplicate`,
   `failed`) are precisely the high-value ones. A design whose performance depends on how
   many records happen to match can't be reasoned about in advance.

3. **The row-count saving that motivated jsonb is 0.08%** — 25,020 rows vs 25,000 on
   identical data. It only materializes when one app puts many keys on the *same* record;
   in the common bulk case (one app labels 20k records with one key) both write exactly one
   row per record. The write-cost argument was close to nil.

**One thing carried over from the jsonb design.** `INSERT … ON CONFLICT (record_id, app_id,
key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at` is replay-safe
under `occ-retry.ts` with no read-modify-write round trip, and a multi-row `VALUES` list
does a whole bulk batch in one statement. Confirmed working on DSQL; it's the write path
in §4.

---

## 3b. Measured: the reverse index shape holds

Step 0c, run 2026-07-27 against a disposable us-east-2 cluster. Both of §4's unmeasured
DSQL assumptions came back **yes**, so the index ships as written and none of the §4
fallbacks are needed.

**Q1 — `INCLUDE` on a regular b-tree: accepted.**
`CREATE INDEX ASYNC … ON … (app_id, key, deleted_at, value, record_id) INCLUDE (record_type)`
was accepted on the first try, and the plan confirms it does the job it was added for: the
reverse query comes back as an **`Index Only Scan`** with
`Projections: value, record_id, record_type` and no `Storage Lookup` on the table at all.
`record_type` really is served from the index, so the grant filter costs no heap access —
it shows up as a `Filter:` on the index-only scan, which is filtering *within the scan*,
not after fetching records. That is what §7's "pages come back full" rests on.

**Q2 — `deleted_at IS NULL` is a scan key.** Answered by contrast rather than by reading
plan text: two tables, identical data (20 live rows behind 20,000 tombstones on one key),
differing only in whether `deleted_at` is a key column of the reverse index.

| | `deleted_at` in the index | control (§4's fallback shape) |
|---|---|---|
| `Index Cond` | `app_id`, `key`, **`deleted_at IS NULL`** | `app_id`, `key` only |
| index entries scanned | **20** | **20,040** |
| DSQL execution time | **0.99 ms** | 30.2 ms |
| tombstone handling | never entered the range | `Rows Removed by Filter: 952`, after a heap lookup |

The control walks the entire tombstone pile and filters post-fetch; the proposed shape
seeks straight to the live rows. So **the tombstone sweep in §10 stays a storage-cost
question, not a latency remedy**, and §6's tombstone-accumulation caveat stays as written.

One methodological note worth keeping, because it nearly produced the wrong answer:
round-trip wall time is useless here. It swung 695 ms → 107 ms → 66 ms for the *same*
control query across three runs on cold vs warm cache — enough noise to swamp a 30× real
difference. The decisive metrics are DSQL-side: index entries actually scanned, and the
engine's own `Execution Time`. §3a used the same metric for the same reason.

---

## 4. Schema

One new shared table. DSQL name `shared.record_labels`, SQLite name `shared_record_labels`
(same prefix convention as the rest).

```
shared.record_labels
  record_id    text     not null   -- StarkeepId of the labeled record
  app_id       text     not null   -- namespace; ALWAYS server-set from the authed subject
  key          text     not null   -- label key within that app's namespace
  value        text     null       -- optional small scalar; null = pure flag
  record_type  text     not null   -- denormalized from records.type (immutable), for read gating
  created_at   text     not null   -- HLC
  updated_at   text     not null   -- HLC (LWW key)
  node_id      text     not null   -- denormalized from updated_at, per existing convention
  deleted_at   text     null       -- HLC tombstone (retraction)
  primary key (record_id, app_id, key)
```

Note there is no `appId/purpose` string here. `app_id` is a **column**, not a prefix. That
is the whole anti-squatting story: there is no way to *express* another app's namespace, so
there is nothing to validate. The `<appId>/<key>` string form survives only as the wire and
UI rendering (`alpha/ocr-available`), parsed on the way in and reassembled on the way out.
This is strictly stronger than today's `labelHasValidPrefix` string check.

**`record_type` denormalization.** Read gating needs the record's type to check the reader's
grant. Without this column every label read is a join back to `shared.records`, including on
the reverse path ("which records has `alpha` labeled X"), where the join is over an unbounded
set. `records.type` is immutable (`readonly type` on `BaseRecord`, declared at creation), so
the denormalization can never go stale. This is the same trade already made for `node_id`.
The column also rides *inside* the reverse index (below), which is what turns the grant check
from a post-fetch filter into an index condition.

### Indexes

Three, and a fourth should be resisted — see the transaction-limit discussion in §6.

1. **PK `(record_id, app_id, key)`** — forward path: "all labels on these records," and
   idempotent upsert by PK.
2. **`(app_id, key, deleted_at, value, record_id) INCLUDE (record_type)`** — reverse path:
   "which records has `alpha` labeled `ocr-available`," and "…labeled `quality = high`." This
   is the query that makes the whole feature worth building. Every column earns its place;
   see below.
3. **`(node_id, updated_at)`** — sync watermark, mirroring `idx_records_node_watermark`.

**`value` is in the reverse index from day one.** Filtering across labels is the *primary*
access pattern — it's the thing that replaces "ask app A about every file" — so
`alpha/quality = 'high'` needs to be a seek, not a filter over every record `alpha` ever
labelled. That second shape is exactly the linear-scan trap §3a disqualified jsonb for.
Including `value` costs no extra index slot and stays inside DSQL's 1 KiB index-key budget
given the 128-byte value cap. CLAUDE.md's "don't build what isn't needed now" would argue
for deferring it; the POC is what says deferring it is the expensive choice.

**`deleted_at` is the third key column so live rows form a contiguous range.** Retraction is
a tombstone, not a hard delete (§10), and DSQL has no partial indexes — so without this,
every retracted row stays in the reverse index forever and every query seeks past rows it
will discard, with no janitor in the design to collect them (§6). B-tree nulls sort together,
so pinning `deleted_at IS NULL` cuts a contiguous live-only range and tombstones sort out of
the way entirely. Position matters: third, *before* `value`, is what makes the live range
contiguous rather than interleaved.

**`record_type` is an `INCLUDE` payload, so the grant filter costs no heap access.** The
caller's readable-type set is applied while scanning the index rather than after fetching
records, so unreadable rows are never materialized and a page of 50 comes back with 50
matches instead of however many survived a post-filter (§7). It is `INCLUDE` rather than a
key column because it is never a seek boundary — `value` sits in front of it either way — so
promoting it to a key column would buy nothing and would push it into the residual sort
order, which the cursor is derived from.

**None of this disturbs the cursor.** With `app_id`, `key` and `deleted_at` all pinned, the
residual order is `(value, record_id)` — exactly what §7 encodes. Had `record_type` gone in
as a key column between `value` and `record_id`, the cursor would have grown to a 3-tuple for
no gain. That is the reason for the placement, and it is worth not "tidying" later.

DSQL specifics that apply, all already documented in `dsql-schema-init.ts`: no FK on
`record_id`, `CREATE INDEX ASYNC` with a `pg_indexes` pre-check, no partial indexes, each
DDL statement issued separately.

> **Verified on a live cluster (2026-07-27) — both assumptions hold; the shape is no longer
> provisional.** Harness in `e2e-aws/src/poc-record-labels/reverse-index.ts` +
> `verify-index.ts`, run against a disposable us-east-2 cluster (since deleted). See §3b.

### Bare flags, and why they need no fourth index

Apps will often want a key with no value — `alpha/needs-review` as a pure flag. `value` is
nullable for exactly this, and **no additional index is required**: `(app_id, key,
deleted_at)` is a leftmost prefix of the reverse index, and every reverse query pins all
three (`deleted_at IS NULL` is always applied — nobody queries for retracted labels), so a
query that omits `value` is a range seek on that prefix, not a scan. For a key that is
*always* flag-only the live range degenerates to `record_id` order exactly — `value` is a
constant within it and costs nothing.

There is one consequence that is easy to miss, and it bites pagination rather than the seek:

- **When `value` is pinned** (`WHERE app_id=? AND key=? AND deleted_at IS NULL AND value=?`),
  the index's residual order is `record_id`, so a `record_id` cursor is index-aligned.
- **When `value` is omitted** and the key carries *varied* values, the range is ordered by
  `(value, record_id)`. `record_id` is therefore **not** monotonic across the range, and a
  bare `record_id > cursor` predicate would silently skip and repeat rows.

So **the cursor is the composite `(value, record_id)`, always** — the index's own order,
which is correct in both cases and collapses to plain `record_id` order whenever `value` is
pinned or uniformly null. `deleted_at` and `record_type` never enter it: the former is pinned
by every query, the latter is an `INCLUDE` payload outside the sort order. Callers never see
any of this: `nextCursor` is an opaque token (§7). This is cheaper and less error-prone than
either adding a fourth `(app_id, key, record_id)` index (write cost on every label, for one
query shape) or forbidding value-less queries on valued keys.

`value IS NULL` is separately indexable if a caller ever needs "the flag rows specifically,
excluding valued ones" — Postgres b-trees index nulls — but nothing needs it now, and for a
flag-only key the presence filter already answers the question.

---

## 4a. Record and label writes share a request, not a transaction

Removing `records.label` means a record and its origin-app label are two rows instead of
one, so a record can exist briefly with no label. The create endpoint takes an optional
`labels` field and writes both in the **same request** — record insert, then label
upsert — with **no enclosing transaction**. Readers must tolerate "record present, label
not yet."

This is deliberately less than atomic, for three reasons:

1. **It matches what metadata already does, and does it better.** The SDK docstring at
   `packages/sdk/src/types.ts:35` claims the metadata row is written "atomically with the
   records-table row." That is **false**: `sdk.ts:126-133` is `await databaseAdapter.put(record)`
   followed by `await databaseAdapter.putMetadata(…)` — two sequential adapter calls, each
   its own `withOccRetry` transaction on DSQL. Over HTTP it isn't even one request, since
   metadata is a separate endpoint (`POST /data/records/:id/metadata`); Photos creates the
   record at `resize-handler.ts:139` and posts metadata at `:164`. Folding labels into the
   create request is therefore a small *improvement* on the established pattern, not a
   departure from it. **That docstring is wrong and must be fixed** (§12 step 0) — it would
   mislead exactly this kind of decision.
2. **Real atomicity would be new machinery.** `transaction()` exists on both adapters and
   has **zero production callers** anywhere in `packages` or `apps`. Using it here means
   the first production exercise of the DSQL savepoint path plus OCC-retry semantics for a
   multi-table write.
3. **It would buy nothing durable, because sync reintroduces the window.** Records and
   labels are two streams applied in merged per-node HLC order (§8). The label is written
   after the record, so it carries the higher HLC, so a peer sees the record before its
   label however atomic the origin write was. Local atomicity closes a millisecond and
   leaves the seconds-to-minutes case untouched.

The clincher is that this tolerance is already load-bearing: a record can arrive at a peer
without its dimensions today, and nothing breaks.

Note the interaction with positive filtering (§9): under a positive filter an unlabelled
record is *excluded*, so the window shows up as a photo that hasn't appeared yet rather
than a thumbnail that shouldn't be there. Both are transient; neither is fixable by a
transaction.

---

## 5. Write authorization

1. **`app_id` is never client-supplied.** Both data servers set it from the authenticated
   subject, exactly as `origin_app_id` is set today. An app cannot name another namespace.
2. **Writing a label requires a `read` grant on the record's type — not `readwrite`.**
   `readwrite` on `image/jpeg` means "may create, modify, and delete image records";
   requiring it to label would force every labelling app (an OCR service, a classifier) to
   hold destructive power over photos it only ever reads. Labelling is additive, namespaced,
   quota-bounded, and advisory — a read grant is the right price. A third grant level
   (`read` / `annotate` / `readwrite`) would be more literally honest and more machinery;
   **decided against it**, and so is the cheaper middle of a per-`fileAccess`-entry
   `labelWrite` boolean alongside the existing `metadataWrite` (`admin-manifest/src/schema.ts:19`).
   Reading a type is enough to justify writes into the app's own namespace on that type.

   **The cost, and who owns paying it.** `read` no longer means "you cannot cause any
   shared-plane write." `data-roles-and-permissions.md:30` stays true as written — an app
   is still confined to the types its manifest declares — but the surrounding claim that a
   read grant is write-inert does not, and nothing in the doc currently says a read-granted
   app can create rows in `shared.record_labels`. That edit is step 8; it is not optional
   bookkeeping, because the confinement story is the doc's central claim.
3. **Delete/retract is scoped by PK**, and the PK contains `app_id`, so an app can only
   retract its own labels. No extra check needed beyond the server-set `app_id`.
4. **Reads are gated by the record's type only.** Per your constraint: any app that can read
   the type sees every app's labels on it. No per-namespace read gating.
5. **All-access (Drive / the watcher) does not grant namespace impersonation.** Drive reads
   everything and writes only `starkeep-drive/*`. Platform-driven deletion of another app's
   label rows (record deletion cascade, §10) is a platform operation, not an app write, and
   should go through a code path that is not reachable from `/data/*`.
6. **PG GRANTs stay category-coarse, as they already are.** Every per-app PG role needs
   `SELECT, INSERT, UPDATE, DELETE` on `shared.record_labels`; the per-app confinement is
   application-layer, identically to `shared.records`. That is not a new weakening — it is
   the same "DSQL has no RLS, so the app layer is the type-granular cut" already documented
   in `data-roles-and-permissions.md` — but it should be written down there explicitly.

---

## 6. Limits

You're right that limits are the thing that keeps this from becoming a smuggled data plane.
There are three levers, and the *key-cardinality* one matters more than the byte ones.

### Caps

| Limit | Value | Why |
|---|---|---|
| `key` length | ≤ 64 chars, `[a-z0-9][a-z0-9._-]{0,63}` | keys are identifiers, not content |
| **distinct keys per app** | **≤ 64, declared in the app manifest** | the only cap that needs enforcing — see below |
| `value` length | ≤ 128 bytes UTF-8, or null | enough for an enum, id, count, or ISO timestamp; not enough for prose |
| labels per `(record, app)` | *(no separate cap — implied)* | an app with ≤ 64 declared keys cannot put more than 64 labels on one record |
| labels per record, all apps | **no cap** | a cross-app cap is a DoS one app can inflict on another |

**One cap, not three.** The per-`(record, app)` limit an earlier draft proposed is redundant
once distinct keys per app are capped: an app that may declare 64 keys cannot exceed 64
labels on a single record even trying. So there is one number and one enforcement point,
with no second check on the write path.

**The key-cardinality cap is the one that actually enforces the intent.** Byte caps alone
don't stop an app from using *keys* as data — writing `alpha/ocr-<first-40-chars-of-text>`
as a flag-only label smuggles 64 bytes per row with an unbounded key space and poisons the
reverse index. Capping an app to a fixed set of distinct keys forces keys to be **schema**,
which is what a label is. **Keys are declared in the app manifest**, the installer registers
them, and the write path rejects anything undeclared. That buys discoverability for free —
app B's developer can see what app A publishes without reading app A's source, which is
arguably half the point of the feature. A runtime distinct-key counter would be less
machinery and was considered; it gives up the discoverability, which is the reason to pay
for the manifest version.

**Discoverability is the reason, so the registry must be readable cross-app.** A declared
key that only exists in the app's source repo and in a table nobody else can select from
buys nothing over a runtime counter — the manifest version is only worth its cost if app
B's developer (and app B's code) can actually enumerate what app A publishes. So the
registry follows `shared.access_grants` exactly, which already solves this problem:

- **`shared.app_label_keys`** — `(app_id, key)` primary key, plus a `description` text
  column carried from the manifest so the enumeration is self-explaining. Written by the
  installer, `GRANT SELECT … TO PUBLIC` and `GRANT INSERT, UPDATE, DELETE … TO
  "<installer>"`, mirroring `dsql-schema-init.ts:206-210`. The local side mirrors it in
  `local/registry.ts` the same way the local grant rows already do.
- **`GET /data/label-keys[?app=<appId>]`** on both data servers — the read path that makes
  the table reachable from app code rather than only from a DB session. Unfiltered by the
  caller's grants: which keys an app declares is public schema, not user data.

The write path's undeclared-key rejection reads the same table. It is a small per-write
lookup on a table of tens of rows, cached per request alongside the grants load
(`access-enforcer.ts:loadAccessGrants`), which already does exactly this shape of query.

**No global per-record cap, deliberately.** A cap across all apps creates a race where app
A's write fails because app B got there first — a denial-of-service one app can inflict on
another, with a confusing error. Per-app caps are the only ones an app can be held
responsible for.

### What 64 keys costs

The caps are as much a spend control as an abuse control (see the DPU note below). Raising
the per-app key cap from 32 to 64, and dropping the per-record cap of 8, multiplies the
worst case by 8×:

| | at 64 keys/app |
|---|---|
| worst case per app per record | ~16 KiB (64 × (64-byte key + 128-byte value + ~60 row overhead)) |
| at 10 installed apps | ~160 KiB per record |
| records per 3,000-row transaction, fully saturated | 46 |
| 100k records fully labelled | 6.4M rows, ~19M index entries across 3 indexes |

None of that is a correctness problem — 160 KiB of labels sits against records whose *bytes*
are megabytes, and the saturated cases are pathological rather than expected. It is the
number to look at if label spend ever shows up in the bill.

**The value is not a place to put data, and no cap can enforce that semantically.** 128
bytes is small enough that anything substantive has to be chunked across keys, which the
key cap then bounds. Document the convention explicitly: a value is an enum, an opaque id
(pointing at the app's own API), a count, or a timestamp. Never a sentence, and never a
pointer into the shared data model (§9a).

### DSQL constraints this has to live inside

Numbers below are from AWS's published DSQL quotas, spot-checked against the live cluster
in the §3a POC.

- **3,000 rows modified per transaction, and secondary-index entries do *not* count
  against it.** Verified directly: a 3,000-row insert into the two-secondary-index label
  table succeeded; 3,001 failed with `54000: transaction row limit exceeded`. So a
  bulk-labeling job (an app that just indexed 40,000 photos) batches at **3,000 labels per
  transaction**, and adding an index does not shrink the batch. *(An earlier draft of this
  doc claimed index entries counted, and budgeted ~500/txn — that was wrong.)* Chunking
  must still be resumable: there is no cross-batch atomicity.
- **10 MiB of modified data per write transaction.** At ~250 bytes/row, 3,000 label rows
  is ~0.75 MiB, so the row limit binds first — the byte limit is not a practical concern
  for labels.
- **5-minute transaction ceiling**, **2 MiB max row size**, **1 KiB max combined size of a
  secondary index's key columns**, **max 8 columns per index**, **max 24 indexes per table**.
  The reverse index sits well inside all three: 5 key columns plus one `INCLUDE`, and
  `app_id`(~32) + `key`(≤64) + `deleted_at`(~30, an HLC string) + `value`(≤128) +
  `record_id`(~26) is roughly **280 bytes** against the 1 KiB budget. There is room for
  another column if one is ever genuinely needed; there is no room for the value cap to grow
  much past its current 128 bytes without revisiting this line.
- **No FK, so no cascade** — record deletion must delete labels in application code (§10).
- **Retraction tombstones accumulate forever, and `deleted_at` in the index is what keeps
  them out of the way.** §10 makes retraction a `deleted_at` tombstone (it has to — the
  retraction itself must sync) and defers the janitor, so a key that churns (set → retract →
  set on the same records) grows the table without bound. DSQL has no partial indexes, so
  `WHERE deleted_at IS NULL` cannot be baked into the index definition; putting `deleted_at`
  in as the third key column (§4) is the available substitute, sorting tombstones into a
  range no query enters. **Confirmed on a live cluster** (§3b): with `deleted_at` in the key
  a query behind 20,000 tombstones scans 20 index entries, against 20,040 for the same index
  without it. §3a's flat 3.3 ms is a steady-state number, not a clean-table one, and the
  sweep in §10 stays "not urgent".
- **Cost, not just correctness.** DSQL bills DPU on writes including index maintenance —
  see the spend table above. This belongs on the same page as
  `todo-cloud-dos-cost-amplification-2026-06-30.md`.

---

## 7. Read API

Two shapes, matching the two access patterns:

1. **Forward, batched with the listing.** Extend `GET /data/records` with
   **`?include=metadata,labels`** — the enrichment parameter is an existing comma-separated
   list, not a per-feature boolean (`api-handler.ts:879-882`, `local-data-server/server.ts:1059-1062`),
   so `labels` is a new member of that list and no new query parameter is introduced. It
   hydrates exactly like `include=metadata` does (one batched query for the page, indexed by
   record id, `labels: []` when none). Optionally `?labelApps=alpha,gamma` to hydrate only
   namespaces the caller cares about.
2. **Reverse.** `GET /data/records?label=alpha/ocr-available` — records carrying that
   label, still filtered by the caller's own read grants. This is the query that replaces
   "ask app A about every file."

### Filtering by value

`?label=` alone is a **presence** filter: records where `alpha` set that key at all,
whatever the value, including flag rows where the value is null. That's the right default
and it's what flag-only keys need.

Exact-value matching gets one more parameter:

```
GET /data/records?label=alpha/quality&labelValue=high
```

`labelValue` requires `label`, matches the `value` column exactly, and is an index seek on
the reverse index's `(app_id, key, deleted_at, value)` prefix — the reason `value` is in that
index at all (§4). It is
deliberately **exact match only**: no ranges, no prefixes, no `IN` list. §6 fixes a value as
an enum, an opaque id, a count, or a timestamp, and equality is the only operator that
matches that contract. Anything richer is a signal the app is using values as data.

Two params rather than folding it into one (`?label=alpha/quality=high`) because a value may
itself contain `=`, and the escaping that avoids is not worth the compactness.

Not included: an explicit "value is null" filter. It's indexable if wanted (§4), but for a
flag-only key the presence filter already answers the question, and for a valued key
"the rows where this app declined to set a value" is not a question anyone has asked.

Both shapes gate on the denormalized `record_type` rather than joining back to
`shared.records`, and on the reverse path that gate is an **index condition**, not a
post-fetch filter (§4). `FIELD_MAP` in both query builders doesn't need a `label` entry any
more (§9); this is a separate table, not a `shared_records` column, so the join/subquery
lives in `buildSelectQuery`.

### Pages should come back full — but the contract still says page to exhaustion

An earlier draft of this section accepted under-filled pages as the contract, because
`record_type` sat outside the reverse index and the grant filter therefore ran after the
records were fetched: a caller asking for 50 could get 3, having paid heap access for 47
rows it wasn't allowed to see. Carrying `record_type` and `deleted_at` in the index (§4) is
what removes that. Both conditions are now evaluated during the index scan, so the executor
keeps scanning until it has a full `limit` of rows that are live *and* readable, and never
materializes the rest. On the two dimensions that used to short pages, pages are full.

One case survives, and it is why the contract does not change: §10's **orphan** — a label
whose record was deleted in a way that raced sync, so the label row is still live while the
record is gone. That is caught only when the records are fetched, and it can still drop a
row from a page. It is rare by construction, but "rare" is not "never", so:

> **Page until `nextCursor` is null.** A short page does not mean the end of the results.
> Only a null `nextCursor` does.

This stays in both the API docs and the SDK docstring. The failure mode if it goes
undocumented is an app that stops on its first short page and silently misses matches —
and it would now be a *rare, load-dependent* bug rather than an obvious one, which is worse.
Worth an explicit test: a reverse query over records of two types where the caller can read
only one, asserting both that pages come back full and that paging to exhaustion finds every
readable match.

### Pagination: cursor from day one

The reverse query returns a page of `{ records, nextCursor }` from the first commit, not a
bare array with a `limit`.

The reason is the SDK, not the query. `data.query()` today returns `Promise<DataRecord[]>`
with no pagination at all. That is a latent problem for `query()`. It would be a
*designed-in* one for `findByLabel`, whose entire purpose is matching many records, and
retrofitting a cursor into an SDK method that shipped returning an array is a breaking
change for every app that adopted it. The plumbing is nearly free: the cursor exists at the
adapter layer (`id > cursor`, `query-builder.ts:67-69` in both adapters) and the
cloud-data-server already surfaces it end to end (`api-handler.ts:875`, `:908-917`).

**The local-data-server does not, and that is a bug this plan should fix.** `GET /data/records`
there reads `limit` but no `cursor`, and returns no `nextCursor`
(`local-data-server/server.ts:1054-1090`) — a plain gap against the cloud handler, not a
deliberate asymmetry. Fixing it is a prerequisite for `findByLabel` behaving the same on
both servers, but it is independent of labels and lands as **its own commit** (step 0b).

One decision inside that fix: LDS sorts `updatedAt desc` (`server.ts:1080-1084`) while the
adapter cursor predicate is `id > cursor`. Plumbing the cursor through without touching the
sort would produce a cursor that silently skips and repeats rows — the same failure §4
describes for the label cursor, arrived at from a different direction. **Drop the LDS sort
and let it default to `id asc`, matching the cloud handler**, rather than building an
`updatedAt`-keyed cursor for one endpoint. Blast radius is nil: Photos' only list calls are
`/data/records?limit=1000` and it sorts client-side (`infra/src/resize-handler.ts:79`,
`app/api/resize/route.ts:62`, `app.tsx:136-145`).

**The cursor encodes `(value, record_id)`, not `record_id`** — see §4. A bare `record_id`
cursor is only correct when `value` is pinned or uniformly null; on a value-less query
against a key with varied values it would silently skip and repeat rows. Encoding the
index's own order is correct in every case and costs nothing, since `nextCursor` is opaque
to callers. Implementations must not "simplify" this back to a bare id.

One constraint to state in the API docs: results come back in reverse-index order only. A
caller wanting label results sorted by `created_at` would need a different index; that is a
deliberate omission, not an oversight.

### SDK surface

Labels are a first-class SDK API, mirroring the metadata trio already in
`packages/sdk/src/types.ts:80-89`. **Four methods:**

```ts
setLabels(entries: Array<{ recordId: StarkeepId; key: string; value: string | null }>): Promise<void>;
retractLabels(entries: Array<{ recordId: StarkeepId; key: string }>): Promise<void>;
getLabelsByIds(recordIds: StarkeepId[]): Promise<Map<StarkeepId, RecordLabel[]>>;
findByLabel(
  sel: { appId: string; key: string; value?: string },
  page?: { limit?: number; cursor?: string },
): Promise<{ records: DataRecord[]; nextCursor: string | null }>;
```

An earlier draft had six. The two that went: `getLabels(recordId)` is
`getLabelsByIds([recordId])`, and a separate `setLabelsBulk` is `setLabels` at a different
arity. **`setLabels` owns the chunking at every size**, so there is no bulk/non-bulk split
and no cliff where a caller's hand-rolled loop quietly stops being the right shape — the
one-record case is a batch of one. `retractLabels` takes the same entry shape as `setLabels`
rather than `(recordId, keys[])`, so retraction mirrors the write instead of being a third
argument convention to remember.

`null` is a first-class value on the write side — `setLabels(id, { "needs-review": null })`
sets a bare flag. On the read side `sel.value` omitted means *presence* (any value, flags
included) and `sel.value` supplied means exact match, mirroring `?label=` / `&labelValue=`.

> **Correction found during implementation.** Point 1 below is **wrong about this
> codebase**: `packages/sdk` has *no* app identity. `StarkeepSdkOptions` carries no
> `appId`, and every write that needs one already takes it explicitly — that is what
> `CreateDataRecordInput.originAppId` is. The SDK is a **per-node** facility used by the
> local-data-server; apps reach the data plane over HTTP via `app-client`'s `signedFetch`,
> never by importing the SDK. So the shipped signatures are
> `setLabels(appId, entries)` / `retractLabels(appId, entries)`, mirroring `originAppId`.
>
> The guarantee itself is not lost, it just lands where it was always actually enforced:
> **both data servers set `app_id` from the authenticated subject and ignore the request
> body**, which is what the cloud test "binds app_id from the authenticated subject" pins.
> The SDK sits *below* that trust boundary, exactly as `query()` does no grant filtering
> there either. Point 3 (manifest-key validation at the call site) moves for the same
> reason — the SDK cannot read `shared.app_label_keys`; it validates key and value *shape*
> only, and the servers reject undeclared keys. Points 2 and 4 hold as written, and 4 —
> `setLabels` owning the chunking — was always the valuable one.

Four things this buys that the HTTP surface alone cannot:

1. **`app_id` never appears in a write signature.** The SDK is bound to one app identity, so
   "you cannot name another namespace" (§5.1) becomes unrepresentable in the types rather
   than a 400 someone has to remember to test.
2. **The `<appId>/<key>` string never reaches app code.** §4 says that form is wire-and-UI
   only; the SDK is what makes that true. Callers pass `{ appId, key }` and parse/format
   lives in one place.
3. **Manifest-key validation at the call site**, so an undeclared key fails immediately
   rather than as a 400 from a bulk job three hours in.
4. **`setLabels` owns the chunking.** The 3,000-rows-per-transaction rule with resumable
   batches and multi-row `ON CONFLICT DO UPDATE` (§3a, §6) is exactly what every app author
   would otherwise reimplement, badly, as a loop of single writes.

### What a batch actually costs

§3a's carried-over finding — a whole batch in one multi-row `ON CONFLICT` statement — is
true of the *write*, and it is easy to read it as the whole cost. It isn't. Every label
write needs `record_type` (§4), which comes from `shared.records`, so a batch is really:

1. one `SELECT id, type FROM shared.records WHERE id IN (…)` over the batch's record ids,
2. a `canRead` check per *distinct type* returned (a handful, not per row),
3. the one multi-row upsert.

The `SELECT` in (1) is very likely the dominant cost of a bulk labelling job, and it is a
read the single-statement framing hides. Two consequences worth stating rather than
discovering: record ids missing from its result must be rejected (that is the
record-existence check §8 requires on the API path), and the batch size that binds it is the
same 3,000 — an `IN` list that large is fine, but it is not free.

This does not change the design. It changes what to measure first if bulk labelling is slow.

And the discoverability point: without an SDK surface this is a mechanism app authors find
by reading data-server source. Today `label` isn't in the SDK at all (no hits in
`packages/sdk` or `packages/shared-space-api`), which is part of why nothing ever read it.

---

## 8. Sync

Labels are shared data, so they ride the **Drive channel** with records, under
`app-starkeep-drive-role`. No new channel.

- **Label writes must not touch `records.updated_at`.** Stated again because it is the single
  most important implementation rule here (§2, points 1 and 3).
- Add a `labels: RecordLabel[]` field to `SyncExchangeRequest`/`SyncExchangeResponse`,
  parallel to `records` and `appSyncableRows`. Same HLC-LWW, same `selectUnseen` predicate on
  `updated_at.nodeId`, same tombstone handling.
- `responderWatermarks` becomes a union over **both** tables on the Drive channel. The
  in-process transport already does exactly this union for `records` + per-app tables
  (`in-process-transport.ts` §5), so the shape is proven — but the "holdings are a contiguous
  per-node prefix" claim that makes the coverage watermark valid now has to hold **across two
  streams**. Concretely: apply records and labels in merged per-node HLC order and stop the
  whole node on first failure. Getting this wrong doesn't corrupt data (LWW is idempotent, a
  re-ship is harmless) but it can make a watermark overstate coverage and silently drop a
  label. This deserves a dedicated test case in the sync harness.
- **Orphan labels are fine and must stay fine.** A label can arrive before its record. Since
  there's no FK and readers reach labels *from* records, an orphan is simply invisible until
  its record lands. So: validate record existence on the **API** write path (we need
  `record_type` anyway), and never validate it on the **sync apply** path.
- **The reverse case — record before label — is also expected**, and is why §4a declines to
  make record+label writes atomic: the label carries the higher HLC, so merged-order apply
  delivers the record first no matter what the origin did. Readers tolerate it; nothing here
  should try to prevent it.
- **A per-app channel must drop inbound labels, exactly as it already drops shared records.**
  `syncSharedRecords=false` channels guard inbound and warn on over-shipped records
  (`sync-engine.ts:257-263`) rather than trusting the responder not to send them. Labels are
  shared data and need the same guard in the same place; without it the channel split holds
  for records and silently doesn't for labels. This is one condition, but it is the kind of
  thing that gets left out because the responder "shouldn't" ship them.
- `ChangeEvent` already carries `recordIds`; a label write can emit `local-change-recorded`
  with the affected ids to nudge the Drive engine. No new event type needed.

---

## 9. `records.label` is removed

The column goes away and `photos/thumbnail` becomes an ordinary label row. Both arguments
for keeping it failed on inspection.

**The semantic argument was wrong.** It claimed the origin app's self-classification is a
categorically different assertion, and that suppressing a record from another app's view is
the origin's prerogative. Neither holds: shared records aren't owned by their creators, and
the existing label is exactly as advisory to other apps as any label we're adding. An app is
free to honor or ignore either. See §1.

**The cost argument was speculative, and the concern it named has a better answer anyway.**
"List images excluding thumbnails runs on every Photos listing" describes a query that
**does not exist**. Photos lists everything and discriminates client-side on
`parentId !== null` (`photo-thumbnail.tsx:18`); nothing anywhere filters on `label`.

Two things are worth recording about the cost question regardless, since it will come up
again:

- **Hydration is cheap and was never in doubt.** "Labels for these 50 records" is a
  PK-prefix seek with an `IN`-list — one batched query, exactly the shape `?include=metadata`
  already uses.
- **Exclusion filters are the answer to a question we should stop asking.** An anti-join
  ("images *without* label X") executes inside DSQL as one query rather than N client round
  trips, so it isn't disastrous, but it does pay LIMIT amplification: filling a 50-row page
  needs `50/(1 − matched share)` candidate rows scanned plus a probe each. At Photos' one
  thumbnail per original that's ~2× rows touched, forever, and DSQL bills DPU on rows read.
  DSQL has no partial indexes (§4), so there is no way to precompute "not a thumbnail."

  **Prefer positive filters.** Label the thing you want (`photos/original`) and the query
  becomes `WHERE app_id=? AND key=?` — the flat 3.3 ms index seek §3a measured, with no
  amplification and no scan. This is strictly better than what the column ever offered, and
  it is the pattern to document for app authors.

  The one property that inverts, and must be stated in the API docs: an anti-filter is
  **safe by default** (unlabelled ⇒ included) while a positive filter is **unsafe by
  default** (unlabelled ⇒ excluded). `photos/original` only works as a filter if Photos
  labels everything it uploads, and images written by a *different* app will not carry it.
  That is a coverage obligation on the labelling app, and the failure mode is silently
  hidden records — worth an explicit warning wherever `findByLabel` is documented.

There is also a positive reason to remove it that the earlier draft missed: keeping both
means Photos' `photos/thumbnail` is expressed one way and every other app's identical
self-classification is expressed another, permanently — a "why are there two?" for every app
author, and a naming problem (`label` vs `annotations` vs `tags`) that only exists because
of the duplication. Removing the column dissolves it: the new thing is just **labels**.

### Removal work

- `label` off `DataRecord` (`protocol-primitives/src/records/types.ts:54-66`), its builder
  (`builders.ts`), and its validator (`schema/validator.ts`).
- Delete `protocol-primitives/src/records/label.ts` (`labelHasValidPrefix`), its export in
  `records/index.ts:11`, and its tests (`__tests__/records.test.ts:56-72`). The `app_id`
  column supersedes it (§4).
- Drop the column from `dsql-schema-init.ts:187` and `storage-sqlite/src/schema/bootstrap.ts`,
  from both `serialization.ts` files, and the `label` entry from both `query-builder.ts`
  `FIELD_MAP`s.
- Remove the create-path validation and echo in both data servers
  (`local-data-server/server.ts:1200`, `cloud-data-server/src/api-handler.ts:946` and `:691`).
- Photos writes `photos/thumbnail` as a label instead
  (`infra/src/resize-handler.ts:153`, `app/api/resize/route.ts:141`), and the e2e assertions
  at `photos/e2e/photos-app.spec.ts:115-187` move to the label surface.
- Adapter and server tests that exercise the column: `storage-aurora-dsql/__tests__/serialization.test.ts:50-58`,
  `storage-sqlite/__tests__/adapter.test.ts:66-73` and `:168-182` (the label *filter* test —
  note it is the only thing in the tree that ever filtered on `label`), and
  `cloud-data-server/__tests__/routes-db.test.ts:276-310` (round-trip and squatting-rejection).
  The squatting test has no successor and is deleted rather than ported: `app_id` is
  server-set, so there is no request that can express the attack (§4).
- **Docs are step 8, not this list** — `system-design.md`'s "Advisory interest labels" bullet
  describes the removed column in detail and cannot survive it. Called out here because it is
  the easiest thing to miss while working a file-by-file removal.

No migration: per CLAUDE.md, development data is disposable.

---

## 9a. `parent_id` stays — and the bug it is hiding

The same "keep the records table pure" instinct suggests replacing `parent_id` with a label.
It shouldn't be, for three reasons that do **not** apply to `label`:

1. **It is a link to another record, not an assertion about one.** The label PK is
   `(record_id, app_id, key)` — single-valued *per app*. `photos/parent = <id>` therefore
   gives every app its own opinion about a record's parent, where today there is exactly one
   parent systemwide. That single-valuedness is load-bearing: the `(parentId, contentHash)`
   dedup of derived children on the write path depends on it
   (`local-data-server/server.ts:1287-1290`, `api-handler.ts:984-987`).
2. **It breaks the invariant the table rests on.** `app_id` is server-set from the
   authenticated caller (§5.1) — that is what makes namespace squatting *unrepresentable*
   rather than merely rejected. Parenthood isn't the origin app's opinion, so keeping it
   single-valued needs a `starkeep/` platform namespace no app may write: a second write path
   into the label table, and the one clean rule acquires an exception.
3. **It puts a data-model pointer in the value column.** "Children of X" runs on every
   thumbnail upload; as a label that is `WHERE app_id=? AND key='parent' AND value=?`, which
   works only because §4 put `value` in the reverse index — and it stores a record id in the
   128-byte opaque scalar that §6 explicitly says is never a pointer into the data model.

**But the instinct is reacting to something real: `parent_id` is already overloaded.**
`resize-handler.ts:149` sets it for thumbnails and `app/api/photos/crop/route.ts:107` sets it
for crops, while Photos' grid at `photo-thumbnail.tsx:18` reads `parentId !== null` as "this
is a thumbnail." **A crop therefore renders in the grid as if it were its source's
thumbnail — a live bug today**, independent of this plan. The missing piece is not that the
link belongs elsewhere; it is that the *edge has no type*.

The clean fix uses labels without moving the link: **keep `parent_id` as the edge and let a
label type it** — `photos/thumbnail-of`, `photos/crop-of` as flag-only keys on the child.
Photos' discriminator then reads the label instead of `parentId !== null`, which fixes the
crop bug, and the records table stops carrying the semantic overload. Same purity motive,
none of the three problems above. Sequenced as step 11 below, after a real consumer exists.

---

## 10. Lifecycle

- **Record deleted** → tombstone its label rows in the same operation. DSQL has no cascade;
  this joins the existing hand-rolled delete-path cleanup (records row + metadata row + now
  label rows). A record with 8 labels is 9 rows — nowhere near the transaction limit.
- **App uninstalled** → **labels survive**, matching the existing "shared data outlives
  uninstall" principle. Reinstalling re-exposes them. Consistent, and it means a reader
  doesn't lose annotations because the producer was temporarily removed. The counter-case is
  a permanently-removed app leaving stale claims forever; that's a job for an explicit
  "purge app data" admin action, not for uninstall.
- **App uninstalled, or upgraded with a key removed** → the `shared.app_label_keys` rows go
  away (uninstall) or shrink (upgrade), while the label rows themselves survive per the
  bullet above. So **live label rows can reference an undeclared key**, and that is the
  intended steady state, not a corruption: the registry gates the *write* path only.
  Concretely — reads and reverse queries return those rows normally; new writes to the
  undeclared key are rejected; retraction of an existing row is **allowed** (it is scoped by
  PK, §5.3, and refusing it would strand rows the app can no longer clean up); reinstalling
  with the key re-declared makes writes work again with the old rows still in place. Without
  this written down, the obvious implementation validates the key on retraction too and
  makes an app's own rows permanently unreachable to it after a manifest edit.
- **Retraction** is a tombstone, not a hard delete, so the retraction itself syncs. Same
  `deleted_at` HLC pattern as records.
- **Labels cannot go stale against changed bytes**, because a record's bytes are immutable:
  `DataOperations.update` patches only `originalFilename` and `parentId`
  (`packages/sdk/src/types.ts:71-77`), and new bytes mean a new record via `putWithFile`. So
  `alpha/ocr-available` on record X stays true as long as X exists — an assertion is bound
  to a content-addressed thing, not to a mutable slot. This is what makes third-party
  assertions safe to trust at all, and it is worth stating because it is an invariant labels
  *depend on* rather than one they establish; anything that later makes record content
  mutable in place has to revisit this section.
- **Orphan sweep** — labels whose record is gone (a delete that raced a sync). Not urgent,
  and not worth a janitor until we see it happen; note it and move on. Orphans are the one
  thing that can still short a reverse-query page (§7), which is why the page-to-exhaustion
  contract survives the index change.
- **Tombstone sweep** — retracted rows, which accumulate without bound since retraction never
  hard-deletes. Deliberately *not* needed for latency: `deleted_at` in the reverse index (§4)
  keeps them out of every query's range — measured, not assumed (§3b). It is a storage-cost
  question, not a performance one.

---

## 11. Resolved questions

All seven open questions from the first draft were settled in review.

| # | Question | Decision |
|---|---|---|
| 1 | Naming — two mechanisms, or one? | **One.** `records.label` is removed and the new thing is just *labels*; the `annotations`/`tags` naming problem existed only because of the duplication (§9). |
| 2 | `read` grant or a new `annotate` level? | **`read` suffices.** Reading a type justifies writes into the app's own namespace on it. Neither a third grant level nor a `labelWrite` manifest flag alongside `metadataWrite` is worth the machinery; `data-roles-and-permissions.md` gets updated instead (§5.2). |
| 3 | Manifest-declared keys or a runtime counter? | **Manifest**, and **discoverability is the reason** — not consent, which isn't owed for writes into an app's own namespace. That makes cross-app readability of the registry load-bearing rather than incidental (§6). |
| 4 | `value` in the reverse index on day one? | **Yes.** Filtering is a primary access pattern, and the POC shows what the alternative costs. The full index grew in the second review to `(app_id, key, deleted_at, value, record_id) INCLUDE (record_type)` (§4). |
| 5 | Do labels reach the SDK? | **Yes** — four methods, with chunking owned by `setLabels` at every size rather than split into a separate bulk call (§7). |
| 6 | Are the numbers right? | **64 keys per app**, 64-byte keys, 128-byte values, and the redundant per-record cap dropped (§6). Still not derived from a measured workload. |
| 7 | Cursor pagination from day one? | **Yes**, and the reason is the SDK: retrofitting a cursor into a shipped array-returning method breaks every adopter (§7). |

Four further decisions came out of the same review, recorded above rather than here:
`parent_id` **stays** (§9a); record+label writes share a request but **not** a transaction
(§4a); **bare flags** (null values) are supported and need no fourth index, because
`(app_id, key, deleted_at)` is a leftmost prefix of the reverse index and every query pins
all three (§4); and the reverse-query cursor therefore encodes the composite
`(value, record_id)` rather than a bare id (§4, §7).

### From the second review

A later review found three factual errors and a set of unowned gaps. The errors, corrected
in place: the enrichment parameter is a comma list (`?include=metadata,labels`), not a new
boolean; HTTP `GET /data/records` **does** already expose a cursor in the cloud-data-server
(the gap is LDS-only, now step 0b); and `setLabels`' single-statement batch hides a
per-batch `record_type` read that is probably the larger cost (§7).

The gaps, each now owned by a section: undeclared-key rows surviving uninstall and manifest
edits, with retraction staying legal for them (§10); doc updates given a step of their own
(§3, §5.2, step 8); labels' place in `system-design.md`'s two-way data classification (§3);
per-app sync channels dropping inbound labels (§8); and record-byte immutability named as an
invariant labels *depend on* (§10).

**Two of those gaps then turned out to be one index shape.** The first-pass answers — accept
under-filled reverse pages as the API contract, accept tombstones accumulating in the scanned
range — were both consequences of a reverse index that carried neither `record_type` nor
`deleted_at`, and both dissolve once it does:
`(app_id, key, deleted_at, value, record_id) INCLUDE (record_type)`. Grant filtering and
tombstone exclusion move into the index scan; pages come back full; the `(value, record_id)`
cursor is untouched. §4 carries the reasoning and the fallbacks. **Both DSQL assumptions were
then measured and both held** (§3b) — §3a is a list of index shapes DSQL rejected that
Postgres accepts, so this got measured rather than assumed, and the fallbacks went unused.

The lesson worth keeping: both gaps were framed as costs to document and warn callers about,
when they were really symptoms of an under-specified index. "What does the index have to
carry for this filter to be free?" was the question that dissolved them.

One suggestion was considered and **rejected**: that removing `records.label` regresses the
thumbnail-flooding case for third-party image apps, since positive filtering asks the reader
to know about `photos/original`. It has no effect on the implementation — `parent_id IS NULL`
already serves that filter, nothing filters server-side on either column today, and the plan
keeps `parent_id` regardless (§9a). Recorded so it isn't re-raised as new.

### Deliberately not measured

Whether the anti-join is actually expensive was left unmeasured, unlike the jsonb question.
The §3a harness in `e2e-aws/src/poc-record-labels/` would extend to it in about an hour, but
positive filtering (§9) removes the anti-join from the design entirely, so the answer
wouldn't change anything. Noted here so a future reader doesn't mistake the gap for an
oversight.

This is now the *only* deliberate gap. The reverse index's two DSQL assumptions — `INCLUDE`
acceptance and `IS NULL` as a scan key — were also unmeasured when first written down, but
they were not left that way: step 0c measured both and both held (§3b), because unlike the
anti-join their answers would have changed the design (§4).

---

## 12. Implementation order

**The whole thing ships at once.** These are not independently-shippable increments, so the
ordering is chosen for implementation ease — keeping each piece of code written once — not
to keep a release-able system at every point. Each step should still leave the tree building
and its own tests green, per the CLAUDE.md "fully hooked up" rule.

0. **Fix the false atomicity docstring** at `packages/sdk/src/types.ts:35` (and the matching
   comment on `DataOperations.update` at `:71`, which describes the same write path). It
   claims the metadata row is written "atomically with the records-table row"; `sdk.ts:126-133`
   writes it in a second, separate transaction. Independent of everything below, and worth
   doing first because §4a's design rests on knowing what the existing pattern actually is.
0b. **Give the local-data-server the cursor it's missing** (§7): accept `cursor`, return
   `nextCursor`, and drop the `updatedAt desc` sort so the endpoint matches the cloud
   handler and the adapter's `id > cursor` predicate. A pre-existing gap, not label work —
   **its own commit**, and a prerequisite for `findByLabel` paginating identically on both
   servers.
0c. **Verify the reverse index shape on the POC** (§4), before any of the code below assumes
   it. **Done — both answers yes; see §3b.** `reverse-index.ts` + `verify-index.ts` in
   `e2e-aws/src/poc-record-labels/` answer it against a real cluster: DSQL accepts
   `INCLUDE (record_type)` on a regular b-tree, and plans `deleted_at IS NULL` as a **scan
   key**. §3a is the reason this wasn't assumed: DSQL rejected four index shapes plain
   Postgres accepts. The §4 fallbacks went unused, so §6, §7 and §10 stand as written.
1. `RecordLabel` type, key/value validators, and the `<appId>/<key>` parse/format helpers in
   `protocol-primitives`, with unit tests. `records/label.ts` is deleted in the same step
   (§9) — `labelHasValidPrefix` has no successor; the `app_id` column replaces it.
2. **Both tables' DDL and the manifest schema**, in `dsql-schema-init.ts` (async indexes,
   per-statement, PG GRANTs) and `storage-sqlite/src/schema/bootstrap.ts`:
   `shared.record_labels` (§4) *and* the `shared.app_label_keys` registry with its
   PUBLIC select grant (§6), plus the manifest field, its validator, and installer
   registration in both `dsql-ddl.ts` and `local/registry.ts`. Then the adapter methods:
   get-by-record-ids, find-by-label (cursor-paginated), upsert, tombstone.
   *The registry moved here from a late step deliberately* — the write path in step 3 needs
   it, and deferring it means writing key-cap enforcement twice (a runtime counter, then the
   registry lookup that replaces it).
3. Write + read endpoints in the local-data-server: grant checks, declared-key rejection,
   the optional `labels` field on record create (§4a), and `GET /data/label-keys` (§6).
   Local-only first: fully testable offline, and the layer-1 enforcement point.
4. Same in the cloud-data-server `api-handler.ts`.
5. SDK surface (§7) — the four methods, chunking at 3,000 rows inside `setLabels`, cursor
   plumbed adapter → HTTP → `findByLabel`, and the page-until-null contract in the docstring.
6. Sync: wire type, scan/apply, watermark union, the per-app-channel inbound guard, and the
   merged-order test case (§8).
7. Delete-path cascade in both servers (§10).
8. **Doc updates.** `system-design.md`: rewrite the "Advisory interest labels" bullet the
   removed column owns, and place labels in the "How data is classified" section as
   cross-app-visible app assertions (§3). `data-roles-and-permissions.md`: a read grant now
   permits namespaced shared-plane writes (§5.2), and the label table's PG GRANTs are
   category-coarse with app-layer confinement (§5.6). `authoring-an-app.md`: the label
   surface, the manifest declaration, and the positive-filter coverage warning (§9).
9. **Remove `records.label`** (§9 removal list) and move Photos' `photos/thumbnail` onto the
   label surface. Late in the order deliberately: the replacement has to work before the
   thing it replaces comes out, so Photos is never without its thumbnail marker.
10. **A throwaway second-app consumer** — see below. Without one this is a mechanism with no
    user and we won't find out what's wrong with it.
11. Type the parent edge (§9a): `photos/thumbnail-of` / `photos/crop-of` labels, and Photos'
    grid discriminator switched off `parentId !== null`. Fixes the crop-renders-as-thumbnail
    bug. Sequenced last because it's a Photos correctness fix riding on this mechanism, not
    part of the mechanism.

Steps 0, 0b and 11 are independent bug fixes that this plan happens to surface; each stands
alone, and step 11's underlying bug exists today regardless of whether any of this ships.
Step 0c is not a bug fix but a measurement, and it gates step 2's DDL.

### The consumer (step 10)

A mocked face detector, standing in for the real face detection planned for Photos next.
The point is to exercise the mechanism, so the shape matters more than the detection:

**It must be a separate app id with a `read`-only grant on `image/jpeg` — not a module
inside Photos.** Inside Photos it would be the origin app labelling its own records, which
is the degenerate case §1 says was always covered; it would test none of what is new. A
distinct app id is what exercises the three decisions this plan actually rests on: writing a
label with no `readwrite` grant (§5.2), a reverse query across a namespace the caller
doesn't own (§7), and server-set `app_id` making squatting unrepresentable (§5.1).

Concretely: a `face-index` app whose manifest declares `read` on `image/jpeg` and two keys —
`faces-detected` as a bare flag and `face-count` as a valued key — and which "detects" by
returning a fixed count per record id. That covers flag writes, valued writes, bulk chunking,
presence queries, and exact-value queries. Photos then reads it back via
`?include=metadata,labels` and `findByLabel`, which is the cross-app read path in full.

It is throwaway: when real face detection lands it replaces the mock behind the same labels,
and nothing else moves.
