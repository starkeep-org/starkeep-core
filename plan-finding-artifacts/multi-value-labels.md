# Multi-valued record labels

**Status: implemented, 2026-07-28**, on `cross-app-record-labels` in both repos —
before that branch merged, as recommended below. Proposed 2026-07-27, prompted by the
Photos face-recognition plan (`starkeep-apps/face-recognition-plan.md` §5), but the
change is general and belongs to the label mechanism, not to Photos.

Two things landed differently from the sketch below, both noted at their sections:

- The set-valued write is `POST /data/labels/values` on both data servers, backed by
  `DatabaseAdapter.replaceLabelValues` and `sdk.data.replaceLabelValues` (§1).
- The value cap counts **stored** values, not just the batch's, which needs a second
  batched read on the write path (§2).

**Recommended timing: fold into `cross-app-record-labels` before it merges.** This is
a primary-key change. It is nearly free now and is a migration later, in a system that
deliberately has no migration story (`CLAUDE.md`: migrations are a production concern
we are not yet in).

---

## The requirement

An arbitrary app holding only a **read** grant on images should be able to ask *"which
photos contain Alice?"* — where the labels were written by a different app (Photos),
without calling Photos about each record.

This is the query labels exist for. Today it cannot be expressed.

## Why it cannot be expressed today

`shared.record_labels` is keyed `(record_id, app_id, key)`
(`packages/admin-installer/src/dsql-schema-init.ts:238`; the SQLite mirror at
`packages/storage-sqlite/src/schema/bootstrap.ts:130`). **One row per key per record.**

A photo with three people therefore has to pack three names into one 128-byte value —
`"Alice,Bob,Carol"` — and values are matched by equality only. So
`?label=photos/faces&labelValue=Alice` matches nothing, and the label degrades from a
query surface into a publication that only its author can interpret.

### Why substring matching is the wrong fix

- **It cannot use the index.** A leading-wildcard `LIKE '%Alice%'` is a full scan of
  the app's label space, forever, and it is the *reverse* path — the one the design
  explicitly protects because it runs over an unbounded set.
- **It is wrong.** `Alice` matches `Alicent`. Delimiter-aware matching just moves the
  bug (`Alice` vs `Alice Smith`).
- **It legitimises structured values.** `packages/protocol-primitives/src/records/labels.ts`
  is explicit that a value is "an enum, an opaque id, a count, or a timestamp — never
  a sentence". A delimited list is a payload, and making the query layer parse it
  concedes the point permanently.

## What is already in place

The reverse index is already shaped for this query:

```
idx_record_labels_reverse ON shared.record_labels (app_id, key, deleted_at, value, record_id)
```
(`dsql-schema-init.ts:416`, mirrored in the SQLite bootstrap.)

`value` sits **ahead of** `record_id`, so `(app_id, key, value) → record_ids` is
already an index range scan. The query path, the `labelValue` filter, the cursor
paging (`packages/storage-adapter/src/database/label-cursor.ts`), and the shared query
builder (`label-queries.ts`) all need no new capability.

**The primary key is the only thing standing in the way.**

---

## The change

```
PK: (record_id, app_id, key)  →  (record_id, app_id, key, value)
```

`faces=Alice` and `faces=Bob` become two rows on the same photo.
`?label=photos/faces&labelValue=Alice` then works with the equality matching that
already exists, over the index that already exists.

### Consequences, all of them

**1. Set semantics replace replace-semantics.** Today `set(faces, X)` overwrites the
single row. With `value` in the PK, writes accumulate and removing a name requires an
explicit retraction. Leaving this to callers means every writer reimplements the
same diff, non-atomically.

*Recommendation:* add a set-valued write — `{ recordId, key, values: [...] }` — that
upserts the given values and tombstones the absent ones for that `(record, app, key)`
in one statement. Per-row upsert stays for single-valued keys.

> **As built.** `POST /data/labels/values` on both data servers, over
> `DatabaseAdapter.replaceLabelValues` / `sdk.data.replaceLabelValues`. Two statements
> in one transaction rather than one — a tombstone `UPDATE … WHERE value NOT IN (…)`
> and the ordinary multi-row upsert — because the intermediate state is wrong in a way
> a reader would believe (a single-valued key looks *unset*, not mid-update).
>
> The last sentence above turned out to be the trap, not the fallback: since `value`
> joined the primary key, a per-row upsert no longer overwrites, so a single-valued key
> updated that way silently keeps both answers. **`/values` is the endpoint a
> single-valued key uses**, and a plain add is right only for a key that is written once
> and never updated. An empty `values` clears the key, and is routed through the
> retraction gate rather than the write gate — it only tombstones, so requiring a
> declared key would strand rows on a key an upgrade dropped.

`dedupeUpserts` in `label-queries.ts` keys on `${recordId} ${appId} ${key}` and must
become `${recordId} ${appId} ${key} ${value}`; likewise `PK_COLUMNS` and
`dedupeLabelWrites` in protocol-primitives. Missing either reintroduces the DSQL
`21000: cannot affect row a second time` failure that only shows up against the cloud.

**2. A new cap is required.** The 64-keys-per-app cap exists to force keys to be
schema and to stop an app smuggling content through an unbounded key space. Widening
the PK moves that hole to values: 500 rows of `faces=<chunk>` reconstruct a blob and
poison the reverse index — precisely what the key cap defends against.

*Recommendation:* cap values per `(record_id, app_id, key)`. 32 is generous for faces
and small enough to be pointless as a smuggling channel. Enforce it in both data
servers' write paths, next to the existing key-declaration check.

> **As built**, with one thing the sketch left out: the cap has to count **stored**
> values, not the batch's. Counted over the batch alone it is cleared by sending 32
> values thirty times — which is exactly the channel it exists to close, and it would
> pass every test that writes one batch. So `planLabelWrites` takes an `existingValues`
> map (`labelValueSetKey` → the app's live values on that `(record, key)`) and caps the
> **union**; re-writing a value the app already holds costs no slot, so an idempotent
> re-run of a full batch still succeeds.
>
> That map is a second batched read on the write path, alongside the record-type
> lookup — `getLabelsByRecordIds` over the batch's records, filtered to the calling app
> and to live rows. Tombstoned values are skipped: a retraction frees its slot, and
> counting it would make a key that has been edited enough times permanently
> unwritable.

**3. `value` becomes NOT NULL, and NULL leaves the label model entirely.** A PK column
cannot be nullable, and `value` is nullable today because that is how a bare flag is
represented.

*Recommendation: drop NULL from `value` everywhere — storage, wire, and types — and
let `''` be an ordinary value.* Not a sentinel with a mapping layer: there simply
stops being a distinction between "a bare flag" and "a label whose value is empty".

This is not a workaround for the PK. It is a simplification worth making on its own,
and the PK change is just what forces the question.

**The state that carries meaning is row-absent vs row-present, and it is untouched.**
"This image contains a face" is asserted by the row existing. Whether its value is
NULL or `''` adds nothing on top of that. So the domain goes from four states
(absent / null / empty / valued) to three, and the state that disappears never had a
distinct meaning. A key whose values are genuinely open-ended can then use `''` to
mean the empty string, straightforwardly.

*What this deletes, concretely:*

- **`spellOutNullsFirst`** — the `LabelDialect` field and both adapter configs
  (`storage-aurora-dsql/src/adapter.ts:63`, `storage-sqlite/src/adapter.ts:59`) exist
  *only* because SQLite sorts NULLs first in an ASC scan and Postgres/DSQL sorts them
  last. With NOT NULL the backends agree natively: the divergence is removed rather
  than normalized, along with the "Null ordering is normalized to NULLS FIRST" block
  in `label-cursor.ts` and `label-queries.ts` that explains it.
- **The hand-expanded cursor predicate.** `label-cursor.ts` documents that a row-value
  comparison `(value, record_id) > (?, ?)` is unusable because a NULL on either side
  evaluates to NULL — silently returning an empty page rather than erroring — so
  `labelCursorPredicate` expands it manually. With NOT NULL the row-value form becomes
  usable and maps directly onto the reverse index. A simplification *and* a better
  plan, not just a deletion.
- The null branches at `label-cursor.ts:125-126`, the `value !== null && typeof value
  !== "string"` check in `decodeLabelCursor`, and the `?? null` coercions at
  `sdk.ts:301` and `sdk.ts:334`.

*Types and wire:* `RecordLabel.value` becomes `string`; the write shape becomes
`value?: string` defaulting to `''`, so `{ recordId, key }` with no value still works
and still reads back as a flag. `validateLabelWrite` must accept `''` (0 bytes is
trivially within `LABEL_VALUE_MAX_BYTES`). Every `value === null` check on the branch
becomes `value === ""` — or, more often, disappears.

*`deleted_at` stays nullable.* It is genuinely two-state (tombstoned or not) and is
pinned by equality in the reverse index rather than participating in the cursor order.
Only `value` changes.

> **Edge case to get right at the query parser.** `?labelValue=` (match empty-valued
> labels) and an absent `labelValue` (no value filter) are different queries, but
> `url.searchParams.get("labelValue")` returns `""` for the first and `null` for the
> second. The parser must branch on `.has()`. Getting this wrong degrades a flag query
> into an unfiltered presence query — which returns a superset and therefore looks
> like it works.

**4. Sync is unchanged in shape and slightly better in semantics.** Label LWW is
per-PK, so widening the PK gives each `(record, app, key, value)` its own LWW domain.
The per-node HLC watermark, the union-over-both-tables coverage watermark, and the
contiguous-prefix property are all untouched — they are per-node over the table, not
per-row. A rename is retract + set: two rows, both carrying HLCs, both tombstone-aware,
both shipped.

**5. Row growth is real but small.** A ten-person group photo is ten rows, not one.
Note that the DSQL 3,000-modified-row transaction cap now bounds a *variable* number
of rows per image, so publisher chunking can no longer assume a fixed rows-per-record
(the Photos publisher must chunk on rows, not images).

---

## What this deliberately does not solve

**Names are matched as strings.** "Alice" and "Alice Smith" do not unify; a rename
rewrites every row carrying the old name; two apps have no way to agree that their
"Alice" is the same person.

The principled fix is a **person identity in the shared plane** — a `person/...` record
type, with labels carrying its id instead of a display name. Two current rules forbid
it, and both are load-bearing rather than incidental:

- Apps cannot invent types; the type registry is platform-owned, so this needs a new
  platform category.
- Label values are explicitly "never a pointer into the shared data model"
  (`labels.ts`), which is exactly what a person-record id would be.

That is a genuine platform design change with a cross-app identity story attached, not
a tweak to this one. Recorded here so it is not rediscovered as a bug.

## Privacy note

Making names queryable means any app with an image read grant can page
`?label=photos/faces` and enumerate the people in the user's library. Presence already
leaks that faces exist; multi-value makes the social graph precise. This does not
change the trust model — labels are shared-plane data by construction — but it is the
strongest argument for Photos' `publishLabels` defaulting to **off** and being an
explicit, informed opt-in.

## Out of scope

Intersection queries ("photos with Alice **and** Bob") still need either repeated
`label` params with a server-side intersect, or client-side filtering. The current
single-`label` parameter does not express it. Worth doing only if a caller wants it.

---

## Touch list

| Area | Change |
| --- | --- |
| `packages/admin-installer/src/dsql-schema-init.ts` | PK columns; `value` NOT NULL |
| `packages/storage-sqlite/src/schema/bootstrap.ts` | same, mirrored |
| `packages/storage-adapter/src/database/label-queries.ts` | `PK_COLUMNS`, `dedupeUpserts`, set-valued upsert; delete `spellOutNullsFirst` |
| `packages/storage-adapter/src/database/label-cursor.ts` | drop null ordering; switch to a row-value cursor predicate |
| `packages/storage-adapter/src/database/label-row.ts` | `value` non-null |
| `packages/storage-{sqlite,aurora-dsql}/src/adapter.ts` | drop `spellOutNullsFirst` from the dialect config |
| `packages/sdk/src/sdk.ts` | drop `?? null` coercions (301, 334) |
| `packages/protocol-primitives/src/records/labels.ts` | `RecordLabel.value: string`; `dedupeLabelWrites`; accept `''`; new per-key value cap |
| `apps/local-data-server/server.ts` | `POST /data/labels` set-valued shape; cap enforcement; `labelValue` `.has()` vs `.get()` |
| cloud-data-server `api-handler.ts` / `access-enforcer.ts` | same |
| `system-design.md`, `authoring-an-app.md` §9 | labels are set-valued; what that means for writers |
