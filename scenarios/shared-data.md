# Shared data

This file specifies the behavior of shared records for members, app developers, cloud operators, and visitors. A member keeps photos, documents, and other files as shared records that every granted app can read. An app developer writes, queries, labels, deletes, and restores those records through the data servers on a member's computer and in the cloud. A member publishes records through public links, a visitor opens those links, and a cloud operator audits the links in admin-web. The scope covers types and categories, record metadata, cross-app labels, the query grammar as the shared routes apply it, deletion, the Trash and its window, archived records, variants, file URLs and range serving, public links, and the storage guarantees a user can observe.

Related files:

- [residency-and-stand-ins.md](residency-and-stand-ins.md): which file bytes each device keeps, stand-ins, reading content at a chosen size, archiving decisions, and freeing up space.
- [app-data.md](app-data.md): app tables and rows, the general query grammar, and an app's own rows after its records go to the Trash.
- [sync.md](sync.md): the generic exchange that carries records and labels between devices.
- [uploads-and-file-bytes.md](uploads-and-file-bytes.md): uploads, presigned writes, multipart transfers, and moving file bytes between devices.
- [users-and-access.md](users-and-access.md): type grants in both environments, per-member isolation, and outside-client tokens.
- [app-lifecycle.md](app-lifecycle.md): shared records surviving uninstall, and the install consent dialog, including its public-links text.
- [drive.md](drive.md): Drive's Trash view and share dialog.
- [local-data-server.md](local-data-server.md): watched folders and what deletion does to a watched file.

Type-grant rules in both environments live in [users-and-access.md](users-and-access.md), ACCESS-119 to ACCESS-125, ACCESS-174, and ACCESS-175: creating, listing, and reading records, not-found answers, and metadata reads and writes judged by the record's own type. This file states only the grant rules that belong to shared data alone: the read grant that labelling needs, the write grant that restoring needs, the grant that thawing needs, and the metadata route's grant column.

## Types and categories

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-001] Locally, an app lists the record types it can read, with a count and a latest-change time for each
  Given a member's library holds JPEG photos and Markdown documents
  And an app holds a read grant on image/jpeg only
  When the app asks the local data server for the library's types
  Then the answer lists image/jpeg with the number of live JPEG records
  And the entry carries the time of the latest change to a JPEG record
  And the answer leaves out document/markdown
  And the answer carries the total count across the listed types
```

- **Coverage:** `apps/local-data-server/__tests__/integration/records.test.ts` › "list reports types with counts in /data/types" asserts the count and the total, not the latest-change time. `apps/local-data-server/__tests__/integration/access-control.test.ts` › "read visibility ungranted types are invisible in /data/records and /data/types" asserts the omission. Integration, local.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-188] In the cloud, an app lists the record types it can read, with a count for each
  Given a member's cloud library holds records of several types
  And an app holds read grants on some of those types
  When the app asks the cloud data server for the library's types
  Then the answer lists each readable type with the number of its live records
  And the answer leaves out every type the app cannot read
```

- **Coverage:** `packages/admin-installer/builtin-apps/cloud-data-server/__tests__/routes-db.test.ts` › "grants parity on records routes GET /data/types short-circuits with no grants and counts by type otherwise" (unit with a fake database, cloud) asserts that the grant enters the aggregate's predicate and that the handler passes the scripted counts through. The fake database decides which types come back, so no cloud test shows an unreadable type left out. `e2e-aws/src/journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3) asserts only that the app's own type is listed.

- An app with no read grant sees an empty type list: see ACCESS-120 in [users-and-access.md](users-and-access.md) (formerly SHARED-002).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-003] An app cannot register a record whose type is not in the registry
  Given an app holds readwrite grants on every image type
  When the app registers a record with the type "image/made-up"
  Then the app's write fails as an unknown type
  And no record appears in the library
```

- **Coverage:** `packages/protocol-primitives/__tests__/core-types.test.ts` › "isKnownType accepts registered types and rejects unknown / malformed ids" (unit). No route test sends an unknown type to either data server.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-004] An app never receives a watched file with an unmapped or missing extension, and Drive receives it as other/other
  Given a member added a file named "notes.xyz" and a file named "README" to a watched folder
  When an installable app with grants on every grantable category lists the library
  Then the app receives neither record
  And Drive's listing of the library holds both records with the type other/other
```

- **Coverage:** `packages/protocol-primitives/__tests__/core-types.test.ts` › "defaultTypeForExtension (advisory) maps unmapped / empty extensions to other/other" and › "TYPES registry includes the terminal other/other type, which is not app-grantable" (unit). `apps/local-data-server/__tests__/integration/access-control.test.ts` › "metadata writes ordinary apps cannot reach `other` at all (403 before the table guard)" and › "all-access identities starkeep-drive reads and writes every type with no grant rows" (integration, local). No test drives a captured unmapped file end to end.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-005] An app with an image grant receives a watched camera raw file as an image, not as other/other
  Given a member added a camera raw file such as "IMG_0001.CR3" to a watched folder
  When Photos lists the library with its image grant
  Then Photos receives the file's record
  And the record carries an image type
```

- **Coverage:** `packages/protocol-primitives/__tests__/core-types.test.ts` › "camera raw types (media plan item 29) maps every raw extension to a real image type, not the catch-all" (unit). No integration test captures a raw file.

```gherkin
@local @cloud
@intent:confirmed @coverage:none
Scenario: [SHARED-006] An app that declares a record's type finds the record under that type, whatever the filename extension
  Given an app holds a readwrite grant on image/png
  When the app registers PNG bytes under the type image/png with the filename "export.jpg"
  Then the record lists with the type image/png
  And an app with a grant on image/jpeg alone does not see the record
```

- **Coverage:** no test registers a record whose filename extension disagrees with its declared type.

## Writing records

### Registering a record

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-007] An app registers a record for bytes it uploaded first, and the record appears in listings
  Given an app holds a readwrite grant on image/jpeg
  And the app has uploaded the bytes of a photo under their content hash
  When the app registers a record with the type, the content hash, the size, and the filename
  Then the app receives the new record
  And the record appears in the app's next listing
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/records.test.ts` › "create — key-ref shape registers a record for previously-uploaded bytes" (integration; a single-record read). Tier-2 local: `e2e/tests/probe-platform.spec.ts` › "every app-facing data route answers through the app's own proxy" (registers two records and counts and pages them in listings). Cloud: `e2e-aws/src/journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3; the same sweep). Unit: `routes-db.test.ts` › "record registration 201s and persists when the blob exists".

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-008] An app cannot register a record whose bytes it never uploaded, and no record appears
  Given an app holds a readwrite grant on image/jpeg
  And the app has not uploaded any bytes under a content hash
  When the app registers a record with that content hash
  Then the app's registration fails with a conflict that says the bytes are missing
  And no record appears in the library
```

- **Coverage:** local: `records.test.ts` › "create — key-ref shape refuses to register a record whose blob was never uploaded" (integration) asserts the 409 and the "Blob not found" message. Cloud: `routes-db.test.ts` › "record registration 409s when no blob exists at the content-addressed key" (unit) asserts the 409. Neither test checks that no record appears afterwards.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario Outline: [SHARED-009] An app that registers with a malformed content hash or a bad size is refused
  Given an app holds a readwrite grant on image/jpeg
  When the app registers a record with <field> set to <value>
  Then the app's registration fails as a bad request
  And no record appears in the library

  Examples:
    | field       | value                   |
    | contentHash | an uppercase hex digest |
    | contentHash | a 10-character string   |
    | sizeBytes   | missing                 |
    | sizeBytes   | a negative number       |
```

- **Coverage:** `records.test.ts` › "create — key-ref shape validates contentHash format and sizeBytes" (integration, local) sends one body, a contentHash of "XYZ" with no size, and asserts the 400. No test sends each example row on its own, and no test checks that no record appears. The cloud validates the same fields, and no cloud test drives them.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-010] A local app registers a record from a file path on the member's computer
  Given a local app holds a readwrite grant on document/pdf
  And a PDF file sits at a path on the member's computer
  When the app registers a record with the type document/pdf and that file path
  Then the record appears in the library with the file's name
  And the app can read the file's bytes through the record's file URL
```

- **Coverage:** `records.test.ts` › "create — filePath shape ingests a local file by path" (integration, local) asserts the record's filename and size. The test does not load the file through a file URL.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-189] A local app that registers a record without bytes or a file path is refused
  Given a local app holds a readwrite grant on image/jpeg
  When the app registers a record with a type and neither a content hash nor a file path
  Then the app's registration fails as a bad request
```

- **Coverage:** `records.test.ts` › "create — filePath shape requires one of filePath or contentHash" (integration, local).

```gherkin
@local @cloud
@intent:unclear
Scenario: [SHARED-206] A member who creates an empty file in the example app is told the file cannot be created
  Given a member has the example app open
  When the member creates a file named "blank.txt" with no content
  Then the status line shows "Create file failed: Request body must not be empty"
  And the member finds no file named "blank.txt" in the file list
```

- **Notes:** both data servers refuse an empty file body with "Request body must not be empty" (`apps/local-data-server/server.ts` at `POST /data/files`; cloud `api-handler.ts` at `POST /data/files`), and the example app's status line shows the server's message after "Create file failed: " (`example-app/web/src/browser/main.ts` `run`). A watched folder brings in every non-empty file (LDS-042 in [local-data-server.md](local-data-server.md)).

- An app without a readwrite grant on a type cannot register a record of that type: see ACCESS-119 in [users-and-access.md](users-and-access.md) (formerly SHARED-011).

### Duplicates and identity

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-012] An app that registers the same bytes under the same filename gets the existing record, marked as a duplicate
  Given a member's library holds a record for "beach.jpg"
  When an app registers the same bytes again under the filename "beach.jpg" with no parent
  Then the app receives the existing record
  And the answer marks the record as a duplicate
  And the library still holds one record for "beach.jpg"
```

- **Coverage:** local: `records.test.ts` › "dedup same bytes + same filename → deduped:true with the original id" (integration); tier-2 local: `e2e/tests/probe-platform.spec.ts` › "re-uploading identical bytes dedups at the platform layer" (the library's count stays the same). Cloud: `routes-db.test.ts` › "record registration dedups a byte-identical top-level record, not just a derived child" (unit with a fake database) hands the route an existing row as the dedup lookup's answer, so no cloud test shows a real lookup finding the duplicate.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-013] An app that registers the same bytes under a different filename gets a second record
  Given a member's library holds a record for "beach.jpg"
  When an app registers the same bytes under the filename "beach-copy.jpg"
  Then the app receives a new record
  And the library lists both "beach.jpg" and "beach-copy.jpg"
```

- **Coverage:** local: `records.test.ts` › "dedup same bytes under a different filename is a new record" (integration) asserts a new id and no duplicate mark, not that both records list. Cloud: `routes-db.test.ts` › "record registration asks for the filename too, so two copies under different names stay apart" (unit with a fake database) asserts the dedup lookup's text only.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-014] An app that registers identical renditions under two originals gets a separate rendition under each
  Given a member's library holds two originals
  And an app has registered a rendition of the first original
  When the app registers byte-identical rendition bytes under the same filename as a child of the second original
  Then the app receives a new record under the second original
  And each original lists its own rendition
```

- **Coverage:** unit: `packages/protocol-primitives/__tests__/content-id.test.ts` › "createDataRecord ids keeps two originals' identical renditions apart" asserts that the ids differ. Local: `records.test.ts` › "dedup derived children dedup by (parentId, contentHash)" (integration) uses one parent only. Cloud: `routes-db.test.ts` › "record registration dedups a byte-identical derived child of the same parent" and › "record registration does not collapse a top-level record into a child with the same bytes" (unit with a fake database) use one parent or none. No route test registers an identical rendition under a second original.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-015] A member who adds the same file on two computers finds it once in the library
  Given a member's laptop and desktop both watch folders that hold the same photo under the same name
  And both computers have synced with the member's cloud since the member added the photo
  When the member browses the library on either computer or in the cloud
  Then the member finds one copy of the photo, not two
```

- **Coverage:** `packages/protocol-primitives/__tests__/content-id.test.ts` › "createDataRecord ids converges for a named record, across independent clocks" and › "contentAddressedId is the same on every node for the same file" (unit). No integration test captures one file on two nodes.

```gherkin
@local @cloud
@intent:unclear @coverage:partial
Scenario: [SHARED-016] An app cannot rename or reparent a record in place
  Given a member's library holds a record for "beach.jpg"
  When an app tries to change the record's filename or parent in place
  Then the app's change fails with a not-found answer
  And the record keeps its filename and its parent
```

- **Coverage:** `routes-db.test.ts` › "OCC retry on record read-modify-write answers no PUT on a record: a rename would break its content-addressed id" (unit, cloud). No local test.
- **Notes:** a member who expects to rename a file in Drive meets this rule.

### Reading one record

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-017] An app reads one record by id, with metadata and labels when it asks for them
  Given a member's library holds a photo with image metadata and a label from another app
  When an app with a read grant on the photo's type reads the record by id and asks for metadata and labels
  Then the answer carries the record, its image metadata, and the label
  And a read of the same record without the request carries neither metadata nor labels
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/labels.test.ts` › "reading labels renders each label the same way on the single-record route as on the list" (integration) asserts labels on the single-record read. No test asserts metadata on the single-record read. Cloud: no single-record hydration test.

- Reading a missing record answers not found, and reading an unreadable type answers forbidden: see ACCESS-120 and ACCESS-121 in [users-and-access.md](users-and-access.md) (formerly SHARED-018).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-019] An app receives a watched file's own created and modified dates
  Given a member added a file to a watched folder, and the file's filesystem reports a created date and a modified date
  When an app lists the file's record and then reads the record by id
  Then both answers carry both dates as the source file's own dates
  And the record's own creation time is the time Starkeep captured the file
```

- **Coverage:** `apps/local-data-server/__tests__/integration/watcher.test.ts` › "live filesystem events records the file's own dates, on the list and on the single record" (integration, local).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-190] An app filters and orders by the source file's own dates
  Given a member's library holds watched files with different modified dates
  When an app lists records whose source modified date falls after a given day, ordered by that date
  Then the answer holds exactly the files modified after that day, in date order
  And a record with no source date is not in the answer
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/watcher.test.ts` › "live filesystem events records the file's own dates, on the list and on the single record" (integration) filters on `original_updated_at` and orders by both dates, nulls last. Unit: `packages/storage-sqlite/__tests__/shared-records-original-dates.test.ts` › "shared_records original dates round-trip through a record's serialization". Cloud: no test filters or orders on the dates.

### Sharing across apps

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-020] An app sees a record that another app wrote when it holds a grant on the record's type
  Given a member has installed two apps that both hold grants on image/jpeg
  When the first app writes a JPEG record
  Then the second app lists the record
  And the second app can load the record's file
```

- **Coverage:** `e2e/tests/probe-platform.spec.ts` › "a record one app writes is visible to another; its app-private rows are not" (tier-2, local). No cloud test drives two apps over one record.
- **Notes:** the app-private half of the probe test belongs to [app-data.md](app-data.md).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-021] A local app reads the cloud's copy of the library through the local data server
  Given a member's computer is signed in to the member's cloud
  And the cloud holds a record that the computer has not synced yet
  When a local app asks the local data server for the cloud's records
  Then the answer lists the cloud's record
  And the answer passes the cloud's status through unchanged
```

- **Coverage:** `apps/local-data-server/__tests__/integration/cloud-proxy-seam.test.ts` › "LDS /cloud/data proxy with a real device-token check ships a record up under a real token, then reads the cloud view back through the proxy" (integration, local, against a fake cloud) reads the cloud's type list after the record synced, and › "LDS /cloud/data proxy with a real device-token check passes the cloud's answer through, status and all" asserts a 404 passed through. No test lists a cloud record that the computer has not synced.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-191] A local app on a computer that is not signed in is refused the cloud view at once
  Given a member's computer is not signed in to any cloud
  When a local app asks the local data server for the cloud's records
  Then the app's request fails at once, without reaching any cloud
```

- **Coverage:** `cloud-proxy-seam.test.ts` › "a machine that is not signed in refuses the cloud view locally rather than forwarding a request the cloud must reject" (integration, local).

## Record metadata

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-022] An app writes per-category metadata in the same request that creates the record
  Given an app holds a readwrite grant on image/jpeg and a metadata-write grant on the image category
  When the app registers a JPEG record with its width and height in the same request
  Then the record lists with its width and height when the app asks for metadata
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/inline-metadata.test.ts` › "inline metadata at record creation writes the row in the same call as the record" (integration). Cloud: `routes-db.test.ts` › "record registration writes metadata supplied on create, in the same OCC unit as the record" (unit with a fake database) asserts the statements only; no cloud test reads the metadata back.

- An app that may only read a category cannot write its metadata: see ACCESS-125 in [users-and-access.md](users-and-access.md) (formerly SHARED-023).

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-024] An app that sends metadata with an undeclared column is refused, and no record is left behind
  Given an app holds readwrite and metadata-write grants on images
  When the app registers a JPEG record with a metadata column named "mood"
  Then the app's registration fails as a bad request
  And no record appears in the library
```

- **Coverage:** local: `inline-metadata.test.ts` › "inline metadata at record creation rejects unknown columns against the category's declaration" and › "inline metadata at record creation leaves no record behind when the metadata is rejected" (integration). Cloud: `routes-db.test.ts` › "record registration rejects inline metadata columns the category does not declare" and › "metadata routes 400s an image-only column against a video record" (unit).

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-025] Even Drive cannot write metadata on an other record, because the category has no metadata table
  Given Drive registers a record of type other/other
  When Drive writes metadata for the record
  Then Drive's write fails as a bad request
```

- **Coverage:** local: `inline-metadata.test.ts` › "inline metadata at record creation rejects \"other\", which has no metadata table" and `access-control.test.ts` › "metadata writes `other`-category records have no metadata table (400 even for Drive)" (integration). Cloud: `routes-db.test.ts` › "metadata routes 400s metadata writes to \"other\" even for all-access Drive" and › "record registration rejects inline metadata on \"other\", which has no metadata table" (unit).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-026] An app sees a record in its changed-since listing after another app writes the record's metadata
  Given a member's library holds a photo that an app listed an hour ago
  And a second app has since written the photo's image metadata
  When the first app lists the records changed since its last listing
  Then the first app's listing includes the photo with its new metadata
  And the record's version is unchanged
```

- **Coverage:** local: `inline-metadata.test.ts` › "the clock bump on a later metadata write surfaces the record through updated_after, which is what an incremental refresh reads" and › "the clock bump on a later metadata write moves records.updated_at without touching version" (integration). Cloud: `routes-db.test.ts` › "metadata routes moves the record's clock on a metadata write, without touching version" (unit with a fake database) asserts the statement only; no cloud test reads a changed-since listing after a metadata write.

- A metadata write is judged by the record's own type, not by the type the request names: see ACCESS-174 in [users-and-access.md](users-and-access.md) (formerly SHARED-027).

- A metadata read needs a grant on the record's own type: see ACCESS-175 in [users-and-access.md](users-and-access.md) (formerly SHARED-028).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-029] An app receives metadata in a listing only when it asks, with an empty entry for a record with none
  Given a member's library holds one photo with image metadata and one photo without
  When an app lists the photos and asks for metadata
  Then the first photo carries its metadata
  And the second photo carries an empty metadata entry
  And a listing that does not ask for metadata carries no metadata field
```

- **Coverage:** local: `records.test.ts` › "list embeds per-category metadata only when include=metadata is requested" and › "list returns metadata:null for a record with no metadata row when enrichment is requested" (integration). Cloud: `routes-db.test.ts` › "list metadata enrichment (?include=metadata) omits metadata and issues no metadata query by default" (unit) covers the last clause; › "list metadata enrichment (?include=metadata) embeds each record's per-category metadata in one batched read" (unit with a fake database) embeds scripted rows, so no cloud test reads real metadata into a listing.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-192] An app that writes metadata for a missing record gets a not-found answer
  Given an app holds metadata-write grants on images
  When the app writes metadata for an id that matches no record
  Then the app's write fails with a not-found answer
```

- **Coverage:** local: `access-control.test.ts` › "metadata writes a metadata write against a missing record is a 404" (integration). Cloud: `routes-db.test.ts` › "metadata routes 404s a metadata write against a record that does not exist" (unit).

## The shared query grammar

The records, metadata, and label routes apply the general query grammar that [app-data.md](app-data.md) owns. This section states only how the three shared routes apply it.

### Listing records

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-030] An app that names no limit receives 100 records a page locally and 50 in the cloud
  Given a member's library holds more records than one page
  When an app lists records without naming a limit
  Then the app receives 100 records from the local data server
  And the app receives 50 records from the cloud data server
  And each page carries a token for the next page
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/records-grammar.test.ts` › "the route's own defaults, which are not the grammar's answers 100 records rather than the grammar's 30 when no limit is named" (integration) answers all 36 records of a smaller library, so the test shows that the default exceeds 30 but not that it is 100 or that a token follows. Cloud: `routes-db.test.ts` › "the query grammar on /data/records keeps this handler's own page size rather than taking the grammar's" (unit with a fake database) asserts only that the statement binds 51; it checks neither the page the app receives nor its token.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SHARED-031] An app that asks for more than the ceiling gets a clamped page, and an app that sends a malformed limit is refused
  Given a member's library holds records
  When an app lists records with the limit <limit>
  Then <outcome>

  Examples:
    | limit | outcome                                                              |
    | 1000  | the app receives a page of at most 500 records and a next-page token |
    | 0     | the app's request fails as a bad request                             |
```

- **Coverage:** local: `records-grammar.test.ts` › "the route's own defaults, which are not the grammar's clamps a limit above the grammar's ceiling instead of rejecting it" and › "the route's own defaults, which are not the grammar's rejects a limit the grammar would reject for any other reason" (integration). The local library in that test holds fewer than 500 records, so no test sees the 500-record cap. Cloud: no test.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-032] An app pages through the whole library with the page token and sees every record exactly once
  Given a member's library holds more records than one page
  When an app lists records page by page, handing back each page's token, until the token is empty
  Then the app has received every record in the library
  And no record appeared on two pages
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/records.test.ts` › "list pages to exhaustion with page_token, visiting every record exactly once" (integration). Cloud: `e2e-aws/src/journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3; two one-record pages return both records). Tier-2 local: `e2e/tests/probe-platform.spec.ts` › "every app-facing data route answers through the app's own proxy".

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SHARED-033] An app filters the library by type, by a bounded id list, or by parent
  Given a member's library holds JPEG originals, a PNG original, and renditions of the first JPEG
  When an app lists records filtered by <filter>
  Then the app receives exactly <records>

  Examples:
    | filter                          | records                                     |
    | the type image/jpeg             | the JPEG originals and their renditions     |
    | a list of two ids               | those two records, each once                |
    | the first JPEG as parent        | that JPEG's renditions                      |
    | no parent                       | the originals                               |
```

- **Coverage:** local: `records.test.ts` › "list honors limit and type filters" and › "list returns a deterministic bounded set selected by id"; `records-grammar.test.ts` › "the shapes production issues publish-renditions: the children of one record, by label" and › "the shapes production issues originals only, which the parameter set spelled with a sentinel" (integration). Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3) covers the id-list row, and `example-app/e2e/example-app.spec.ts` › "Example files: a derived copy, the copies and originals filters, and file URLs" (end to end, cloud project) covers the parent row. The type and no-parent rows reach the cloud only through `routes-db.test.ts` › "GET /data/records filters pushes a parent predicate into the query rather than filtering after it", › "GET /data/records filters compiles a null parent as IS NULL", and › "the query grammar on /data/records binds a grammar predicate beside the grant rather than instead of it" (unit with a fake database), which assert statement text only.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-034] An app that filters by more ids than the cap allows is refused
  Given a member's library holds records
  When an app lists records filtered by a list of 501 ids
  Then the app's request fails as a bad request
```

- **Coverage:** local: `records.test.ts` › "list rejects an oversized in-list" (integration). Cloud: no test.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-035] An app orders the library by capture time, and records with no capture time come last
  Given a member's library holds photos with capture times and renditions with none
  When an app lists records ordered by capture time, newest first
  Then the app receives the photos newest first
  And the records with no capture time follow every photo that has one
```

- **Coverage:** local: `records-grammar.test.ts` › "what the grammar reaches that the parameter set never could orders the library by capture time, newest first" (integration). Unit: `packages/storage-sqlite/__tests__/sorted-paging.test.ts` › "paging a sorted query puts records with no capture time after every record that has one". Cloud: `routes-db.test.ts` › "the query grammar on /data/records joins the metadata tables for a capture-ordered page" (unit with a fake database) asserts the nulls-last ordering in the statement text only; no cloud test reads a capture-ordered page.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-036] An app that pages by a sort key receives records that tie on it exactly once
  Given a member's library holds many records that share one capture time
  When an app pages through the library ordered by capture time
  Then the app receives every record exactly once
```

- **Coverage:** unit: `sorted-paging.test.ts` › "paging a sorted query does not lose rows that tie on the sort key" and › "paging a sorted query pages through a nullable sort key, null bucket included". Local: `records-grammar.test.ts` › "what the grammar reaches that the parameter set never could pages a capture-ordered library without losing or repeating a record" (integration; the tie is the null bucket of two renditions). Cloud: `routes-db.test.ts` › "the query grammar on /data/records cuts the adapter's keyset cursor, not a bare record id" (unit) checks the token shape only.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-037] An app that hands back a page token cut for a different ordering is refused
  Given an app holds a page token from a listing ordered newest first
  When the app hands the token to a listing ordered oldest first
  Then the app's request fails as a bad request
  And the app receives no page from the middle of either ordering
```

- **Coverage:** unit: `sorted-paging.test.ts` › "paging a sorted query ignores a cursor cut against a different ordering" asserts the current restart at the first page, which covers only the second `Then` clause. No route test.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-038] An app asks for records changed since an instant and gets exactly those
  Given a member's library holds a record last changed before noon and a record changed after noon
  When an app lists records changed after noon
  Then the app receives the record changed after noon
  And the answer leaves out the record changed before noon
```

- **Coverage:** local: `records.test.ts` › "list filters with updated_after" (integration). Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3) asserts only that a recent deletion appears; no cloud test asserts the exclusion.

```gherkin
@local @cloud
@intent:confirmed @coverage:none
Scenario: [SHARED-193] An app that asks for records changed since a value that is not a date is refused
  Given a member's library holds records
  When an app lists records changed after "yesterday-ish"
  Then the app's request fails as a bad request
```

- **Coverage:** no test sends an unparseable `updated_after`.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-039] An app counts the records it can read, in total or by type, without paging
  Given a member's library holds 36 JPEG records and some records of a type the app cannot read
  When an app asks for a count of the library, and then for a count grouped by type
  Then the app receives a total of 36
  And the grouped answer shows image/jpeg with 36 and no other type
```

- **Coverage:** local: `records-grammar.test.ts` › "what the grammar reaches that the parameter set never could counts the readable library without paging through it" and › "what the grammar reaches that the parameter set never could counts by type, which is the same question grouped" (integration). Cloud: `routes-db.test.ts` › "the query grammar on /data/records answers a count over the readable library without paging through it" (unit); `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3; a count of two). The local test library holds only readable records, and the cloud unit test checks that the grant enters the count.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-040] An app asks for originals only by excluding records that carry a label
  Given a member's library holds photos and renditions that Photos labelled as renditions
  When an app lists records that do not carry Photos' rendition label
  Then the app receives the photos
  And the answer holds no rendition
  And a photo with many other labels appears once
```

- **Coverage:** local: `records-grammar.test.ts` › "the shapes production issues photos library: a page of originals with metadata and labels" (integration); unit `packages/storage-sqlite/__tests__/exclude-label.test.ts` › "excludeLabel returns records that carry no such label" and › "excludeLabel returns a record exactly once when it holds many other labels". Tier-2 local: `probe-platform.spec.ts` › "every app-facing data route answers through the app's own proxy". Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3) and `example-app.spec.ts` › "Example files: a derived copy, the copies and originals filters, and file URLs" (cloud project) cover the exclusion. The last clause reaches the cloud only through `packages/storage-aurora-dsql/__tests__/query-builder.test.ts` › "buildPostgresQuery (compile-only, no database) excludeLabel does not join, so a record with many labels cannot be duplicated", which compiles a statement and runs none.

### What the records route refuses

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SHARED-041] An app is refused a records query that the data servers cannot answer faithfully
  Given a member's library holds records
  When an app lists records with <query>
  Then the app's request fails as a bad request
  And the error names what was refused

  Examples:
    | query                                                  |
    | a filter on a column the records table does not have   |
    | a filter on the capture time                           |
    | a filter on the sync clock                             |
    | an ordering that puts missing capture times first      |
```

- **Coverage:** local: `records-grammar.test.ts` › "what the route refuses refuses a column the records table does not have", › "what the route refuses refuses a predicate on captured_at, which is an ordering key and not a column", › "what the route refuses refuses a predicate on the sync clock", and › "what the route refuses refuses nullsfirst, which its cursor cannot honour" (integration). Only the first two assert the error text. Cloud: no test drives these refusals.
- **Notes:** a count combined with a label filter moved to SHARED-205, whose intent is in doubt.

```gherkin
@local @cloud
@intent:confirmed @coverage:none
Scenario: [SHARED-205] An app that counts with a label filter gets the same number as the listing with that filter
  Given a member's library holds photos and renditions that Photos labelled as renditions
  When an app asks for a count of the records that do not carry Photos' rendition label
  Then the app receives the count of the photos without the label
  And the count equals the number of records that a listing with the same filter returns
```

- **Coverage:** no test counts with a label filter. `records-grammar.test.ts` › "what the route refuses refuses an aggregate over an access path it cannot compile" (integration, local) pins the old refusal and must change.
- **Notes:** split from SHARED-041 in review.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-042] An app that sends a parameter the records listing does not have, including a retired spelling, is refused rather than ignored
  Given a member's library holds records
  When an app lists records with a parameter the route does not have, such as an older "parentId" or "cursor" spelling
  Then the app's request fails as a bad request
  And the app never receives the whole library in place of a filtered page
```

- **Coverage:** local: `records-grammar.test.ts` › "what the route refuses refuses a parameter it does not have, retired spellings included" (integration). Cloud: `routes-db.test.ts` › "GET /data/records derived children refuses variantLongEdge, which is no longer a parameter" (unit).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-043] An app that names a type it cannot read gets a forbidden error, not an empty page
  Given an app holds no grant on audio/mpeg
  When the app lists records filtered to the type audio/mpeg
  Then the app's request fails with a forbidden error
```

- **Coverage:** local: `records-grammar.test.ts` › "what the route refuses 403s a type the caller may not read rather than answering an empty page" (integration). Cloud: no test.
- **Notes:** the general rule that ungranted types stay out of listings is ACCESS-120 in [users-and-access.md](users-and-access.md). This scenario owns only the forbidden answer to a filter that names the type.

### Querying metadata and label rows

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-044] An app queries one category's metadata and sees only rows of types it can read
  Given a member's library holds JPEG and PNG photos with image metadata
  And an app holds a read grant on image/jpeg only
  When the app queries the image metadata table
  Then the app receives the JPEG photos' rows
  And the answer holds no PNG row
  And an app that holds the PNG grant receives the PNG row
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/shared-query.test.ts` › "GET /data/metadata/:category returns only the rows whose record_type the caller may read" and › "GET /data/metadata/:category returns the png row to the app that holds the png grant" (integration). Cloud: `routes-db.test.ts` › "the shared-plane query routes puts the caller's readable types inside the metadata access path" (unit with a fake database) asserts the statement's predicate only; no cloud test shows a PNG row left out.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-045] An app cannot filter, order by, or see the grant column on the metadata route
  Given an app holds read grants on some image types
  When the app queries the image metadata table
  Then no returned row carries the record's type column
  And a query that filters on that column fails as a bad request
  And a query that orders by that column fails as a bad request
```

- **Coverage:** local: `shared-query.test.ts` › "GET /data/metadata/:category does not return the grant discriminant" and › "GET /data/metadata/:category refuses a predicate on the grant discriminant" (integration). No test orders by the column. Cloud: no test.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-046] An app orders, pages, and aggregates metadata rows by capture time
  Given a member's library holds many photos with capture times
  When an app queries the image metadata ordered by capture time, page by page
  Then the app receives the rows in capture order
  And the pages together hold every readable row exactly once
  And a count over the same table counts only the app's readable rows
```

- **Coverage:** local: `shared-query.test.ts` › "GET /data/metadata/:category orders by capture time, which is what the index is for", › "GET /data/metadata/:category pages with a keyset token that walks every row once", and › "GET /data/metadata/:category filters and aggregates over the caller's rows only" (integration). Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3) asserts only that a page and an aggregate answer.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SHARED-047] An app is refused a metadata query on a category it cannot use
  Given an app holds read grants on image types only
  When the app queries the metadata of <category>
  Then the app's request fails with <error>

  Examples:
    | category                       | error              |
    | the video category             | a forbidden error  |
    | the other category             | a bad request      |
    | a path segment "nonsense"      | a bad request      |
```

- **Coverage:** local: `shared-query.test.ts` › "GET /data/metadata/:category 403s a category the caller holds no type in", › "GET /data/metadata/:category 400s the category with no metadata table", and › "GET /data/metadata/:category 400s a path segment that is not a category" (integration). Cloud: `routes-db.test.ts` › "the shared-plane query routes 403s a category the caller holds no type in, without querying" (unit) covers the first row only.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-048] An app must name the labelling app and the key to query label rows
  Given a member's library holds labelled records
  When an app queries label rows without naming both a labelling app and a key
  Then the app's request fails as a bad request
```

- **Coverage:** local: `shared-query.test.ts` › "GET /data/labels requires app_id and key, because the reverse index does" (integration). Cloud: `routes-db.test.ts` › "the shared-plane query routes requires app_id and key on the label route" (unit).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-049] An app receives another app's label rows only for records of types it can read
  Given a labelling app labelled a JPEG photo and a PNG photo with the key "person"
  And a reading app holds a read grant on image/jpeg only
  When the reading app queries the labelling app's "person" label rows
  Then the reading app receives the JPEG photo's label row
  And the answer holds no row for the PNG photo
  And the labelling app's own query returns both rows
```

- **Coverage:** local: `shared-query.test.ts` › "GET /data/labels returns another app's labels, gated on the labelled record's type" and › "GET /data/labels lets the owner see the label the reader cannot" (integration). Cloud: `routes-db.test.ts` › "the shared-plane query routes gates a label query on the labelled record's type" (unit with a fake database) asserts the statement's predicate only.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-050] An app counts records per label value in one query
  Given a labelling app labelled photos with the values "x" and "y" under one key
  When an app asks for a count of that key's label rows grouped by value
  Then the app receives one count for "x" and one count for "y"
  And a query narrowed to the value "x" returns only rows with that value
```

- **Coverage:** local: `shared-query.test.ts` › "GET /data/labels counts per value in the engine rather than in the browser" and › "GET /data/labels narrows on value, which is an ordered key column of the index" (integration). Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3; counts per value). The narrowing clause has no cloud test.

## Cross-app record labels

A label is an assertion one app makes about a shared record, under a key the app declares in its manifest. The labelling app is named in each scenario as the app that writes the label, and the reading app as the app that queries it.

### Writing labels

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-051] An app with only a read grant labels a record another app wrote
  Given Photos wrote a JPEG record
  And a labelling app holds only a read grant on image/jpeg and declares the key "faces-detected"
  When the labelling app labels the JPEG with "faces-detected"
  Then the label write succeeds
  And a listing with labels shows the label on the JPEG
```

- **Coverage:** local: `labels.test.ts` › "writing labels lets a read-only app label another app's record" (integration) asserts the write; › "reading labels shows every app's labels to any app that can read the type" (integration) shows the read-only app's label to another reader. Cloud: cloud `labels.test.ts` › "POST /data/labels writes a flag and a valued label with only a read grant" (unit) covers the grant decision, which the route makes alone, and `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) cross-app labels round-trip against real DSQL: write, hydrate, reverse query, retract" (tier-3) writes a label and reads it back in a listing. Unit: `packages/protocol-primitives/__tests__/labels.test.ts` › "planLabelWrites allows a write with only a READ grant on the type".

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-052] An app cannot label with a key its manifest does not declare
  Given a labelling app declares the key "faces-detected" and holds a read grant on images
  When the app labels a photo with the key "mood"
  Then the label write fails as a bad request that names the undeclared key
  And the photo carries no "mood" label
```

- **Coverage:** local: `labels.test.ts` › "writing labels rejects a key the app's manifest does not declare" (integration). Cloud: cloud `labels.test.ts` › "POST /data/labels 400s an undeclared key" (unit).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-053] An app that declared no keys cannot write any label
  Given an app's manifest declares no label keys
  When the app labels a record it can read
  Then the label write fails as a bad request
```

- **Coverage:** local: `labels.test.ts` › "writing labels rejects every key from an app that declared none" (integration). Cloud: no test.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-054] An app cannot label a record of a type it cannot read
  Given a labelling app holds no grant on document/markdown
  When the app labels a Markdown record
  Then the label write fails with a forbidden error
```

- **Coverage:** local: `labels.test.ts` › "writing labels 403s a label on a type the app cannot read" (integration). Cloud: cloud `labels.test.ts` › "POST /data/labels 403s a label on a type the caller cannot read" (unit). Unit: `protocol-primitives/__tests__/labels.test.ts` › "planLabelWrites 403s a write against a type the caller cannot read".

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-055] An app cannot label a record that does not exist or is deleted
  Given a labelling app declares a key and holds read grants on images
  When the app labels an id that matches no record, or a photo the member deleted
  Then the label write fails as a bad request that says the record does not exist
```

- **Coverage:** local: `labels.test.ts` › "writing labels rejects a label on a record that does not exist" (integration). Cloud: cloud `labels.test.ts` › "POST /data/labels 400s a label on a record that does not exist" (unit). No test labels a deleted record.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SHARED-056] An app that sends a malformed label batch is refused, and nothing in the batch is written
  Given a labelling app declares the key "face" and holds read grants on images
  When the app sends a label batch with <problem>
  Then the label write fails as a bad request
  And no label from the batch appears

  Examples:
    | problem                                              |
    | a key that starts with a punctuation mark            |
    | a key longer than 64 characters                      |
    | a value longer than 128 bytes                        |
    | no entries at all                                    |
    | one good entry and one entry with a malformed key    |
```

- **Coverage:** local: `labels.test.ts` › "writing labels rejects an oversized value" (integration). Cloud: cloud `labels.test.ts` › "POST /data/labels 400s an empty batch" (unit). Unit: `protocol-primitives/__tests__/labels.test.ts` › "isValidLabelKey rejects a key that does not start alphanumeric", › "isValidLabelKey caps key length at 64 characters", › "isValidLabelValue counts UTF-8 bytes, not characters", and › "planLabelWrites rejects the whole batch on one bad entry rather than partially applying". No route test sends a malformed key.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-057] An app that adds a second value to a key keeps the first value
  Given a labelling app labelled a photo with "face" = "Alice"
  When the app labels the photo with "face" = "Bob"
  Then the photo carries both "face" = "Alice" and "face" = "Bob"
  And a reverse query for "face" = "Alice" still finds the photo
```

- **Coverage:** local: `labels.test.ts` › "writing labels adds a second value to a key rather than overwriting" and › "writing labels writes two values of one key in a single batch" (integration). Cloud: `example-app/e2e/example-app.spec.ts` › "Labels: add, retract one, set exactly, count and retract tags" (end to end, cloud and local projects) adds two tag values and counts both. Unit: `packages/storage-adapter/__tests__/label-queries.test.ts` › "buildLabelUpsert keeps two values of one key as two rows — the set-valued case". No test runs a reverse query for the first value after a second value was added.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-058] An app sets a key to exactly the values it gives
  Given a labelling app labelled a file with "tag" = "draft" and "tag" = "idea"
  When the app sets "tag" to exactly "idea" and "final"
  Then the file carries "tag" = "idea" and "tag" = "final" and no "draft"
  And setting "tag" to an empty list leaves the file with no "tag" label
```

- **Coverage:** local: `labels.test.ts` › "writing labels updates a single-valued key in place with the set-valued write"; `label-lifecycle.test.ts` › "reinstalling with fewer keys leaves live rows on an undeclared key replaces the whole value set with the set-valued write" and › "reinstalling with fewer keys leaves live rows on an undeclared key clears the key when the set-valued write is given nothing" (integration). Cloud: `example-app.spec.ts` › "Labels: add, retract one, set exactly, count and retract tags" (end to end, both projects) and `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3) cover the first clause. No cloud test clears a key with an empty list.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-059] An app cannot give one key more than 32 values on one record, counting values already stored
  Given a labelling app labelled a photo with 30 values of the key "face"
  When the app adds three more values of "face" to the photo
  Then the label write fails as a bad request
  And the photo still carries its 30 values
```

- **Coverage:** local: `labels.test.ts` › "writing labels caps the values one key may hold on one record, counting stored rows" (integration). Unit: `protocol-primitives/__tests__/labels.test.ts` › "planLabelWrites deduping counts stored values against the cap, not just the batch's". Cloud: no route test.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-060] An app cannot write into another app's label namespace
  Given a labelling app declares the key "faces-detected"
  When the app sends a label whose body names another app as its author
  Then the label appears under the labelling app's own namespace
  And the other app's namespace carries no new label
```

- **Coverage:** local: `labels.test.ts` › "writing labels has no way to express another app's namespace" (integration). Cloud: cloud `labels.test.ts` › "POST /data/labels binds app_id from the authenticated subject, not the request body" (unit) shows that the route binds the caller's own id, a decision the route makes alone, and `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) cross-app labels round-trip against real DSQL: write, hydrate, reverse query, retract" (tier-3) reads written labels back under the writer's namespace.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-061] An app does not see a record as changed after another app labels it
  Given a reading app listed the library an hour ago
  And a labelling app has since labelled one of the photos
  When the reading app lists the records changed since its last listing
  Then the reading app's listing does not include the photo
  And the photo's version is unchanged
```

- **Coverage:** unit: cloud `labels.test.ts` › "POST /data/labels never touches shared.records — a label write must not re-ship the record"; `packages/storage-sqlite/__tests__/label-conformance.test.ts` › "label contract — SqliteDatabaseAdapter does not touch the records table when a label is written"; `packages/storage-aurora-dsql/__tests__/labels.test.ts` › "upsertLabels never touches shared.records". No test reads a changed-since listing after a label write.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-062] An app sees both of two apps' contradictory labels on one record
  Given one app labelled a photo "quality" = "high"
  And a second app labelled the same photo "quality" = "low"
  When a reading app lists the photo with labels
  Then the reading app receives both apps' "quality" labels on the photo
```

- **Coverage:** unit: `label-conformance.test.ts` › "label contract — SqliteDatabaseAdapter lets two apps hold contradictory opinions about one record" and › "label contract — MockDatabaseAdapter lets two apps hold contradictory opinions about one record". No route test in either environment.

### Labels on create

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-063] An app attaches labels in the same request that creates the record
  Given an app declares the key "rendition" and holds a readwrite grant on image/jpeg
  When the app registers a JPEG record with the label "rendition" = "thumbnail" in the same request
  Then the new record lists with that label
```

- **Coverage:** local: `labels.test.ts` › "labels on create accepts labels in the same request as the record" (integration). Cloud: `routes-db.test.ts` › "record registration writes labels supplied on create, without a second request" (unit with a fake database) asserts the statements only; no cloud test lists the new record with its label.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-064] An app whose labels on create are rejected keeps the record and learns that only the labels failed
  Given an app holds a readwrite grant on image/jpeg
  When the app registers a JPEG record with a label on a key its manifest does not declare
  Then the app receives the new record
  And the answer reports that the labels were refused
  And the record lists with no label
```

- **Coverage:** local: `labels.test.ts` › "labels on create keeps the record when the labels are rejected, and says so" (integration). Cloud: cloud `labels.test.ts` › "labels supplied on record create keeps the record and reports the failure when a label is rejected" (unit).
- **Notes:** inline metadata behaves the other way: a refused metadata payload leaves no record behind (SHARED-024).

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [SHARED-065] An app that registers a duplicate with a label does not label the existing record
  Given a member's library holds a record for "beach.jpg" that another app wrote
  When an app registers the same bytes under "beach.jpg" with a label in the same request
  Then the app receives the existing record, marked as a duplicate
  And the existing record carries no label from the second app
```

- **Coverage:** no test sends labels with a registration that dedups. `labels.test.ts` › "labels on create does not label a record a dedup hit returned — it is someone else's" (integration, local) sends its second, deduplicated registration with an empty label list, so the test cannot see a label applied or skipped.

### Reading labels

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-066] An app receives labels in a listing only when it asks, and an empty list for a record with none
  Given a member's library holds a labelled photo and an unlabelled photo
  When an app lists the photos and asks for labels
  Then the labelled photo carries its labels
  And the unlabelled photo carries an empty label list
  And a listing that does not ask for labels carries no label field
```

- **Coverage:** local: `labels.test.ts` › "reading labels hydrates labels only when include=labels is asked for" and › "reading labels returns an empty array, not null, for a record with no labels" (integration). Cloud: cloud `labels.test.ts` › "GET /data/records with labels hydrates labels only when include=labels is requested" and › "GET /data/records with labels omits the labels field entirely when not requested" (unit). No cloud test asserts the empty list.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-067] Every app that can read a type sees every app's labels on it
  Given a labelling app labelled a photo
  When a reading app with a read grant on the photo's type lists the photo with labels
  Then the reading app sees the labelling app's label on the photo
```

- **Coverage:** local: `labels.test.ts` › "reading labels shows every app's labels to any app that can read the type" (integration). Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) cross-app labels round-trip against real DSQL: write, hydrate, reverse query, retract" (tier-3; Drive reads Probe's labels).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-068] An app narrows label hydration to the namespaces it names
  Given two labelling apps labelled the same photo
  When a reading app lists the photo with labels from the first labelling app only
  Then the photo carries the first app's labels
  And the photo carries none of the second app's labels
```

- **Coverage:** local: `labels.test.ts` › "reading labels narrows hydration to the namespaces asked for with labelApps" (integration). Cloud: cloud `labels.test.ts` › "the reverse query end to end narrows hydration to the namespaces labelApps asks for" (unit with a fake database) asserts the statement's filter only.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-069] A member sees a file's labels the same way in the open file and in the file list
  Given the example app labelled one of the member's files with "tag" = "draft" and the flag "reviewed"
  When the member opens the file in the example app
  Then the open file shows "example-app/tag=draft" and "example-app/reviewed"
  And the file's row in the file list shows the same labels
```

- **Coverage:** local: `labels.test.ts` › "reading labels renders each label the same way on the single-record route as on the list" (integration). Both environments: `example-app.spec.ts` › "Labels: add, retract one, set exactly, count and retract tags" (end to end, local and cloud projects).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-070] An app lists every app's declared label keys, or one app's
  Given Photos and a second app both declare label keys
  When an app lists the declared label keys
  Then the answer holds both apps' keys, whatever types the asking app can read
  And a listing narrowed to Photos holds only Photos' keys
```

- **Coverage:** local: `labels.test.ts` › "GET /data/label-keys enumerates every app's declared keys, not just the caller's" and › "GET /data/label-keys filters to one app with ?app=" (integration). Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) cross-app labels round-trip against real DSQL: write, hydrate, reverse query, retract" (tier-3) covers the narrowed listing. The unnarrowed listing reaches the cloud only through cloud `labels.test.ts` › "GET /data/label-keys returns every app's declared keys, unfiltered by the caller's grants" and › "GET /data/label-keys?app= filters the registry to one app" (unit with a fake database).

### Reverse query

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-071] An app finds the records another app labelled with a key
  Given a labelling app labelled two photos with "faces-detected"
  When a reading app lists records carrying the labelling app's "faces-detected" label
  Then the reading app receives exactly those two photos
```

- **Coverage:** local: `labels.test.ts` › "reverse query finds records another app labelled, across the namespace boundary" (integration) asserts that both labelled records come back, not that the unlabelled third record stays out. Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) cross-app labels round-trip against real DSQL: write, hydrate, reverse query, retract" (tier-3) asserts that the labelled record is among the results; cloud `labels.test.ts` › "the reverse query end to end returns the labelled records, in the reverse index's order" (unit with a fake database).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-072] An app narrows a reverse query to an exact value, or to bare flags
  Given a labelling app labelled one photo "face" = "Alice", one "face" = "Bob", and one with the bare flag "face"
  When a reading app lists records carrying "face" = "Alice"
  Then the reading app receives only the photo labelled "Alice"
  And a reverse query for "face" with an empty value returns only the bare-flag photo
```

- **Coverage:** local: `labels.test.ts` › "reverse query filters by exact value with labelValue" (integration). Cloud: cloud `labels.test.ts` › "the reverse query end to end passes labelValue through as an exact-match filter" (unit); `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) cross-app labels round-trip against real DSQL: write, hydrate, reverse query, retract" (tier-3; a match and a non-match). Bare flags: unit only, `label-conformance.test.ts` › "label contract — SqliteDatabaseAdapter value \"\" is a filter for bare flags, not the absence of a filter" and `packages/storage-adapter/__tests__/label-find.test.ts` › "planFindByLabel value: \"\" is a real filter — bare flags — and not \"no filter\"".

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario Outline: [SHARED-073] An app that sends a malformed reverse query is refused
  Given a member's library holds labelled records
  When an app lists records with <query>
  Then the app's request fails as a bad request

  Examples:
    | query                                         |
    | a label value but no label                    |
    | a label reference with no key after the app   |
```

- **Coverage:** local: `labels.test.ts` › "reverse query 400s labelValue without label" and › "reverse query 400s a malformed label ref" (integration). Cloud: cloud `labels.test.ts` › "GET /data/records with labels 400s labelValue without label" and › "GET /data/records with labels 400s a malformed label ref" (unit).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-074] An app pages through a reverse query to the end without skipping or repeating a record
  Given a labelling app labelled more photos than one page holds
  When a reading app pages through the reverse query until the page token is empty
  Then the reading app has received every labelled photo exactly once
```

- **Coverage:** local: `labels.test.ts` › "reverse query pages to exhaustion without skipping or repeating" (integration). Unit: `label-conformance.test.ts` › "label contract — SqliteDatabaseAdapter pages several values of ONE key on one record without skipping any". Cloud: cloud `labels.test.ts` › "the reverse query end to end hands back a nextCursor and accepts it back as a page token" (unit) checks the token round trip only.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-075] An app that continues a reverse query with a made-up page token is refused rather than restarted
  Given a reading app holds a made-up page token
  When the app continues a reverse query with that token
  Then the app's request fails as a bad request
  And the app receives no first page in place of the continuation
```

- **Coverage:** `labels.test.ts` › "reverse query 400s a page_token this server did not issue, rather than restarting" (integration, local). Unit: `label-find.test.ts` › "planFindByLabel rejects a token cut under a different ordering".
- **Notes:** the records listing restarts on a mismatched token instead. SHARED-037 records the doubt.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-076] An app that pages a reverse query over a partly readable library receives only readable records, in full pages
  Given a labelling app labelled JPEG photos and Markdown documents with one key
  And a reading app holds a read grant on image/jpeg only
  When the reading app pages through the reverse query
  Then every page is full until the last
  And the pages together hold every labelled JPEG and no Markdown document
```

- **Coverage:** local: `labels.test.ts` › "reverse query across a partially-readable library returns only readable records, keeps pages full, and finds every match" (integration). Unit: `label-conformance.test.ts` › "label contract — SqliteDatabaseAdapter filters by the caller's readable types, and the page still comes back full". Cloud: cloud `labels.test.ts` › "GET /data/records with labels constrains the reverse query to the caller's readable types" (unit with a fake database) asserts the statement's predicate only.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-077] An app that pages a reverse query skips a label whose record is gone and keeps paging
  Given a labelling app labelled photos, and one labelled photo's record is gone before its label is
  When a reading app pages through the reverse query
  Then the reading app receives every labelled photo that still exists
  And the page token keeps going past the missing record
```

- **Coverage:** local: `labels.test.ts` › "reverse query across a partially-readable library drops an orphaned label from a page without ending the results" (integration). Cloud: cloud `labels.test.ts` › "the reverse query end to end drops a label whose record is gone, without ending the page" (unit).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-078] An app that excludes Photos' rendition label still receives records whose label Photos retracted or that carry another app's key
  Given Photos labelled one photo as a rendition and later retracted that label
  And a second app labelled another photo with its own "rendition" key
  When an app lists records that do not carry Photos' rendition label
  Then the answer includes the photo whose label Photos retracted
  And the answer includes the photo the second app labelled
```

- **Coverage:** unit: `packages/storage-sqlite/__tests__/exclude-label.test.ts` › "excludeLabel does not exclude on a tombstoned label" and › "excludeLabel is scoped to the naming app"; `packages/storage-aurora-dsql/__tests__/query-builder.test.ts` › "buildPostgresQuery (compile-only, no database) excludeLabel ignores tombstoned label rows". No route test in either environment.

### Retracting labels

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SHARED-079] An app retracts a label, and readers stop seeing it
  Given a labelling app labelled a photo "face" = "Alice", "face" = "Bob", and the bare flag "reviewed"
  When the app retracts <what>
  Then listings and reverse queries no longer show <gone>
  And the photo keeps <kept>

  Examples:
    | what                         | gone                  | kept                              |
    | "face" = "Alice"             | "face" = "Alice"      | "face" = "Bob" and "reviewed"     |
    | "face" with no value         | both "face" values    | "reviewed"                        |
    | "reviewed" with an empty value | "reviewed"          | both "face" values                |
```

- **Coverage:** local: `labels.test.ts` › "retraction hides a retracted label from both read paths" and › "writing labels retracts every value of a key when no value is given" (integration). Both environments: `example-app.spec.ts` › "Labels: add, retract one, set exactly, count and retract tags" (end to end; one value, then a flag). Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) cross-app labels round-trip against real DSQL: write, hydrate, reverse query, retract" (tier-3; a whole key, the flag kept). The bare-flag row has unit coverage only: `label-conformance.test.ts` › "label contract — SqliteDatabaseAdapter retracting value \"\" reaches the bare flag and nothing else".

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-080] An app cannot retract another app's label
  Given Photos labelled a photo "faces-detected"
  When a second app retracts "faces-detected" on that photo
  Then Photos' label still shows on the photo
```

- **Coverage:** local: `labels.test.ts` › "retraction cannot retract another app's label" (integration). Cloud: cloud `labels.test.ts` › "POST /data/labels/retract scopes the update by the authenticated app_id" (unit with a fake database) asserts the statement's predicate only; no cloud test reads the other app's label after the attempt.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-081] An app retracts a label on a key its manifest no longer declares
  Given an app labelled photos with a key that a later version of its manifest dropped
  When the app retracts that key on a photo
  Then the retraction succeeds
  And the photo no longer shows the label
```

- **Coverage:** local: `label-lifecycle.test.ts` › "reinstalling with fewer keys leaves live rows on an undeclared key ALLOWS retracting the undeclared key, so the app can clean up after itself" (integration). Cloud: cloud `labels.test.ts` › "POST /data/labels/retract accepts a key the manifest no longer declares" (unit) covers the acceptance, which the route decides alone, and `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) cross-app labels round-trip against real DSQL: write, hydrate, reverse query, retract" (tier-3) shows a retracted label gone from a reverse query.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-082] An app in the cloud stops seeing a label that the same app retracted on the laptop
  Given a member's laptop and the cloud both hold a label on a photo
  And an app on the laptop retracted the label, and the laptop has since synced with the cloud
  When the app reads the photo with labels in the cloud
  Then the app no longer sees the label
```

- **Coverage:** unit: cloud `labels.test.ts` › "POST /data/labels/retract tombstones rather than deleting, so the retraction can sync"; `label-conformance.test.ts` › "label contract — SqliteDatabaseAdapter retracts as a tombstone, invisible to readers but still readable by the sync path". No test syncs a retraction between devices.
- **Notes:** [sync.md](sync.md) owns the generic exchange that carries labels.

### Labels across uninstall and reinstall

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-083] An app still finds an uninstalled app's labels, though the uninstalled app's keys are no longer declared
  Given an app labelled photos with "faces-detected"
  And that app is no longer installed on the member's computer
  When a second app lists the declared label keys and runs a reverse query for the uninstalled app's "faces-detected" label
  Then the uninstalled app's keys no longer appear in the declared label keys
  And the reverse query still finds the photos
```

- **Coverage:** `label-lifecycle.test.ts` › "uninstall drops every declaration but keeps the labels the app asserted" and › "uninstall still answers reverse queries for a departed app's labels" (integration, local).
- **Notes:** [app-lifecycle.md](app-lifecycle.md) owns shared records surviving an uninstall.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-084] An app reinstalled without a key cannot add values to that key but can still clear it
  Given an app labelled photos with the keys "face" and "mood"
  And the app now runs as a reinstalled version whose manifest declares only "face"
  When the app adds a "mood" value to a photo
  Then the label write fails as a bad request
  And the photo's existing "mood" label still shows
  And the app can retract "mood" from the photo
```

- **Coverage:** `label-lifecycle.test.ts` › "reinstalling with fewer keys leaves live rows on an undeclared key rejects a NEW write to the undeclared key", › "reinstalling with fewer keys leaves live rows on an undeclared key keeps reading the rows on the now-undeclared key", and › "reinstalling with fewer keys leaves live rows on an undeclared key ALLOWS retracting the undeclared key, so the app can clean up after itself" (integration, local).

## Variants

A variant is a derived child of an original, such as a rendition, that carries a label from the app that made the child. [residency-and-stand-ins.md](residency-and-stand-ins.md) owns stand-ins and reading content at a chosen size.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-085] An app lists a record's labelled derived children with their dimensions and a URL for each, smallest first
  Given Photos made renditions of a photo with long edges of 1280, 400, and 128 pixels, each labelled "rendition"
  When Photos lists the photo with its variants under the "rendition" label
  Then Photos receives the three renditions ordered 128, 400, 1280
  And each rendition carries its width, height, label value, and a file URL
```

- **Coverage:** local: `variant-candidates.test.ts` › "asking for the whole set returns every derived child, ascending by long edge" and › "asking for the whole set carries dimensions and a URL for each, so the caller needs no second call" (integration). Unit: `packages/storage-sqlite/__tests__/variant-queries.test.ts` › "loadVariantCandidatesForPage keeps each record's children to itself" and › "loadVariantCandidatesForPage never lists the parent record itself". Cloud: `routes-db.test.ts` › "GET /data/records derived children accepts a variant label, and answers with candidates" (unit with a fake database) answers scripted candidates.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SHARED-086] An app does not receive a derived child it cannot rank or should not see among the variants
  Given Photos made renditions of a photo, and one rendition is <state>
  When Photos lists the photo with its variants under the "rendition" label
  Then the answer leaves out that rendition
  And the answer lists the other renditions

  Examples:
    | state                                       |
    | missing its stored dimensions               |
    | no longer carrying the "rendition" label    |
    | deleted                                     |
    | labelled by another app's "rendition" key   |
```

- **Coverage:** local: `variant-candidates.test.ts` › "asking for the whole set omits a child with no stored dimensions, which nothing could order" (integration). Unit: `variant-queries.test.ts` › "loadVariantCandidatesForPage ignores a child whose label has been retracted", › "loadVariantCandidatesForPage ignores a soft-deleted child", and › "loadVariantCandidatesForPage is scoped to the naming app". Cloud: no test.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-087] An app that asks the variant listing to choose a size is refused
  Given Photos made renditions of a photo
  When Photos lists the photo's variants and asks for the one closest to 500 pixels
  Then the app's request fails as a bad request
  And the error names the refused parameter
```

- **Coverage:** local: `variant-candidates.test.ts` › "choosing a size is not a parameter of the listing any more" (integration). Cloud: `routes-db.test.ts` › "GET /data/records derived children refuses variantLongEdge, which is no longer a parameter" (unit).
- **Notes:** [residency-and-stand-ins.md](residency-and-stand-ins.md) owns the content read at a chosen size.

## File URLs and serving bytes

### Single and batch file URLs

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-088] An app gets a time-limited URL for a record's file and the browser loads it
  Given a member's library holds a photo that an app can read
  When the app asks for the photo's file URL
  Then the app receives a URL with its lifetime, the file's content type, and its size
  And the app's page loads the photo's bytes from the URL without further sign-in
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/auth.test.ts` › "token-in-URL exemptions serves file bytes to an unauthenticated GET with a valid token" (integration) loads the bytes. Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) Part B: shared bytes via CloudFront signed URL — edge hit, tamper rejected, apps/* isolated" (tier-3). Both: `example-app.spec.ts` › "Example files: a derived copy, the copies and originals filters, and file URLs" (end to end, both projects) loads batch URLs. No test asserts the lifetime, the content type, or the size in a single file-URL answer.

- A file URL for a type the app cannot read is forbidden: see ACCESS-120 in [users-and-access.md](users-and-access.md) (formerly SHARED-089).

```gherkin
@local @cloud
@intent:confirmed @coverage:none
Scenario: [SHARED-090] An app that asks for the file URL of a record with no file gets a not-found answer
  Given a member's library holds a record with no attached file
  When an app with a read grant on the record's type asks for its file URL
  Then the app receives a not-found answer that says the record has no file
```

- **Coverage:** no test asks for the file URL of a file-less record.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-091] An app on a computer without a cloud gets a not-found answer for a file the computer does not hold
  Given a member's computer syncs with no cloud
  And the library lists a photo whose bytes are not on the computer
  When an app asks for the photo's file URL
  Then the app receives a not-found answer that says nothing could fetch the bytes
```

- **Coverage:** `stand-ins-residency.test.ts` › "a desktop that syncs with no cloud answers file-url with 404 for bytes that are not here, since nothing could fetch them" (integration, local).
- **Notes:** [residency-and-stand-ins.md](residency-and-stand-ins.md) owns what stays on the computer after a fetch.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-092] An app gets a gateway error rather than a broken URL when the fetch from the cloud fails
  Given a member's computer syncs with the member's cloud
  And the library lists a photo whose bytes are on neither the computer nor the cloud
  When an app asks for the photo's file URL
  Then the app receives a gateway error that says the fetch from the cloud failed
  And the app receives no URL that would fail in the browser
```

- **Coverage:** `stand-ins-residency.test.ts` › "what a desktop receives against its ceiling when the cloud cannot hand over the bytes answers file-url with 502" (integration, local) asserts the 502, not what the error says.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-093] An app gets URLs for many records in one request, and ids it cannot answer are left out
  Given a member's library holds readable photos, a deleted photo, a record with no file, and a Markdown document the app cannot read
  When the app asks for file URLs for all of those ids and one id that matches no record
  Then the app receives a URL for each readable photo
  And the answer has no entry for the deleted photo, the file-less record, the Markdown document, or the unknown id
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/file-urls-batch.test.ts` › "POST /data/records/file-urls returns servable URLs for every known id and omits unknown ids" and › "POST /data/records/file-urls omits records whose type the caller cannot read" (integration). Cloud: `routes-db.test.ts` › "batch file-urls route presigns readable records in one query, omitting unreadable/deleted/file-less/unknown ids" (unit). No local test asks for a deleted or file-less id.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-094] An app that names an id twice in a batch gets one entry for it
  Given a member's library holds a photo
  When an app asks for file URLs and names the photo's id twice
  Then the app receives one entry for the photo
```

- **Coverage:** local: `file-urls-batch.test.ts` › "POST /data/records/file-urls collapses duplicate ids into a single entry" (integration). Cloud: `routes-db.test.ts` › "batch file-urls route deduplicates repeated ids before querying" (unit).

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario Outline: [SHARED-095] An app that sends a batch with a bad id list is refused
  Given a member's library holds photos
  When an app asks for file URLs with <ids>
  Then the app's request fails as a bad request

  Examples:
    | ids                         |
    | no id list                  |
    | an empty id list            |
    | a list holding a number     |
    | a list of 501 ids           |
```

- **Coverage:** local: `file-urls-batch.test.ts` › "POST /data/records/file-urls 400s on a missing, empty, non-string, or oversized ids array" (integration). Cloud: `routes-db.test.ts` › "batch file-urls route 400s on a missing, empty, non-string, or oversized ids array without querying" (unit).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-096] An app learns from a cloud batch which files are still uploading and which will never come
  Given a member's cloud library lists a photo whose bytes are still on the member's laptop
  And the cloud holds the bytes of a second photo
  When an app asks the cloud for file URLs for both photos and an unknown id
  Then the app receives a URL for the second photo
  And the answer names the first photo as awaiting upload
  And the answer names neither the unknown id nor the second photo as awaiting upload
```

- **Coverage:** `packages/admin-installer/builtin-apps/cloud-data-server/__tests__/stand-ins.test.ts` › "reads of a file not uploaded yet omits an id from the batch file-urls whose file S3 lacks, and names it" (unit with a fake database and a mocked S3, cloud). Whether the cloud holds the bytes depends on real storage, and no integration or tier-3 test asks for a batch that holds a file awaiting upload.
- **Notes:** [uploads-and-file-bytes.md](uploads-and-file-bytes.md) owns the upload itself.

### Caching and tokens

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-097] An app gets the same URL for one file across separate requests, so the browser reuses its cached copy
  Given a member's library holds a photo
  When an app asks for the photo's file URL twice, a few seconds apart
  Then both answers carry the same URL
  And the URL's expiry lies in the future
```

- **Coverage:** `apps/local-data-server/__tests__/integration/file-url-caching.test.ts` › "the signed URL is identical across separate calls for the same key" and › "the signed URL still carries an expiry that is in the future" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-098] An app receives a file that the browser may cache only as long as its URL works
  Given an app holds a file URL that expires in 40 minutes
  When the app's page loads the file
  Then the answer lets the browser keep the file for at most 40 minutes
  And the answer lets no shared cache keep it
```

- **Coverage:** `file-url-caching.test.ts` › "the file response is cacheable for as long as its URL works, and no longer" (integration, local).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-099] An app's page that loads an invalid, forged, or expired file URL is refused
  Given an app holds a file URL for a photo
  When the app's page loads a URL whose token is garbage, carries a forged signature, or has expired
  Then the page receives a forbidden answer and no bytes
```

- **Coverage:** local: `auth.test.ts` › "token-in-URL exemptions rejects garbage and forged tokens" (integration). Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) Part B: shared bytes via CloudFront signed URL — edge hit, tamper rejected, apps/* isolated" (tier-3; a tampered URL). No test loads an expired URL in either environment.
- **Notes:** [users-and-access.md](users-and-access.md) links here for the local file link refusal.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [SHARED-194] A member with Photos open generally keeps seeing photos after the local data server restarts
  Given a member has Photos open on this computer, with file links that Photos fetched within their stated lifetime
  And the local data server restarted after Photos fetched those links
  When the member views a photo through one of those links
  Then the member should see the photo
```

- **Coverage:** `auth.test.ts` › "token-in-URL exemptions invalidates outstanding file tokens on server restart (per-boot secret)" (integration, local) pins the old outcome and must change.
- **Notes:** the scenario says "should" on purpose: a URL generally survives a restart, but the platform does not promise it in every case, for example after the member clears local data.
- **Notes:** [users-and-access.md](users-and-access.md) links here for local file links across a restart.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-100] An app's page cannot load a tampered cloud file URL or reach an app's private files through it
  Given an app holds a signed cloud URL for a shared photo
  When the app's page loads the URL with a changed signature
  Then the page receives a refusal and no bytes
  And the same signing cannot reach a file under any app's private storage
  And the untampered URL loads from the edge cache on a second visit
```

- **Coverage:** `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) Part B: shared bytes via CloudFront signed URL — edge hit, tamper rejected, apps/* isolated" (tier-3, cloud).

### Range serving

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-101] An app receives every file with range support advertised, so its video player can seek
  Given a member's library holds a video
  When an app's page loads the video's file URL without a range
  Then the page receives the whole file
  And the answer says ranges are accepted, so the app's scrub bar works
```

- **Coverage:** `apps/local-data-server/__tests__/integration/range-serving.test.ts` › "serving bytes without a range returns the whole object and advertises that ranges are possible" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario Outline: [SHARED-102] An app that asks for a byte range receives exactly those bytes with the full size
  Given a member's library holds a 1,000-byte file
  When an app's page loads the file's URL with the range <range>
  Then the page receives a partial answer holding <bytes>
  And the answer reports the range and the full size of 1,000 bytes

  Examples:
    | range         | bytes                 |
    | bytes=0-99    | bytes 0 to 99         |
    | bytes=900-    | bytes 900 to 999      |
    | bytes=-100    | the last 100 bytes    |
```

- **Coverage:** `range-serving.test.ts` › "serving a range returns 206 with exactly the requested bytes", › "serving a range reports the range and the full size in Content-Range", › "serving a range serves the open-ended form a video element opens with", and › "serving a range serves a suffix range from the end of the file" (integration, local). Unit: `apps/local-data-server/__tests__/range-requests.test.ts` › "parsing a Range header reads a suffix range as the LAST n bytes, not the first".

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-103] An app whose range overruns the file receives the bytes to the end rather than a refusal
  Given a member's library holds a 1,000-byte file
  When an app's page asks for the range bytes=900-5000
  Then the page receives bytes 900 to 999 as a partial answer
```

- **Coverage:** `range-serving.test.ts` › "serving a range clamps an end that overruns rather than failing" (integration, local). Unit: `range-requests.test.ts` › "parsing a Range header clamps an end that overruns the file" and › "parsing a Range header treats an oversized suffix as the whole file rather than an error".

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-104] An app that asks for a range starting past the end is refused with the real length
  Given a member's library holds a 1,000-byte file
  When an app's page asks for the range bytes=2000-
  Then the page receives a range-not-satisfiable answer
  And the answer gives the file's real length of 1,000 bytes
```

- **Coverage:** `range-serving.test.ts` › "serving a range answers 416 with the real length when the start is past the end" (integration, local). Unit: `range-requests.test.ts` › "parsing a Range header reports a start past the end as unsatisfiable, not as a clamp".

```gherkin
@local
@intent:confirmed @coverage:full
Scenario Outline: [SHARED-105] An app that sends a range the server will not honour receives the whole file
  Given a member's library holds a file
  When an app's page asks for <range>
  Then the page receives the whole file with a full answer

  Examples:
    | range                                  |
    | a malformed range such as bytes=abc    |
    | two ranges in one header               |
    | two Range headers                      |
```

- **Coverage:** `range-serving.test.ts` › "serving a range falls back to the whole object for a range it will not honour" (integration, local). Unit: `range-requests.test.ts` › "parsing a Range header falls back to the whole object rather than guessing at nonsense", › "parsing a Range header declines multi-range requests instead of honouring only the first", and › "parsing a Range header ignores a repeated header, which cannot be a single coherent range".

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-106] A member who leaves a video halfway through its download can keep opening files
  Given a member is watching a large video in the browser
  When the member closes the video halfway through its download
  Then the next photo or video the member opens loads normally
```

- **Coverage:** `file-stream-abort.test.ts` › "a client that hangs up mid-download leaves the server serving" (integration, local).

## Deleting records

A deletion puts a record in the Trash: the record stays restorable until the trash window ends. [drive.md](drive.md) owns Drive's Trash view, and [local-data-server.md](local-data-server.md) owns what a deletion does to a file in a watched folder.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-107] An app that deletes a record no longer finds it, its stand-ins, derived records, or labels in any listing
  Given a member's library holds a photo with two stand-ins, a derived copy, and labels from two apps
  When an app with a readwrite grant on the photo's type deletes the photo
  Then the photo, its stand-ins, and its derived copy disappear from every app's listing
  And no app's reverse query finds the photo's labels
  And the photo appears in the deleted feed
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/stand-ins-read.test.ts` › "DELETE /data/records/:id deletes the original, every stand-in and every derived record" (integration). Unit: `label-conformance.test.ts` › "label contract — SqliteDatabaseAdapter tombstones every app's labels when a record is deleted, and only that record's"; `packages/shared-space-api/__tests__/delete-and-restore.test.ts` › "applyRecordDelete keeps the deleted record out of a metadata query". Both: `example-app.spec.ts` › "Deleted: a deletion appears in the reconcile, restores, and takes derived copies but not notes" (end to end, local and cloud projects) covers the derived copy and the deleted feed. The stand-ins and labels reach the cloud only through cloud `stand-ins.test.ts` › "DELETE /data/records/:id tombstones the original's stand-ins and derived records with it" and cloud `labels.test.ts` › "DELETE /data/records/:id cascades to labels tombstones the record's labels in the same request" (unit with a fake database), and no local route test checks the labels after a delete.

- An app without a readwrite grant on a record's type cannot delete the record: see ACCESS-119 in [users-and-access.md](users-and-access.md) (the grant clause of SHARED-108).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-108] An app that deletes a record that does not exist gets a not-found answer
  Given an app holds a readwrite grant on image/jpeg
  When the app deletes an id that matches no record
  Then the app receives a not-found answer
```

- **Coverage:** local: `stand-ins-read.test.ts` › "DELETE /data/records/:id answers 404 for a missing record and 403 without a write grant" (integration). Cloud: no test deletes a missing id.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-109] An app cannot delete a canonical stand-in on its own while its original lives
  Given a member's library holds a photo and its canonical stand-in
  When an app deletes the canonical stand-in alone
  Then the app's delete fails with a conflict
  And the app still lists both the photo and its canonical stand-in
```

- **Coverage:** local: `stand-ins-read.test.ts` › "DELETE /data/records/:id refuses the canonical stand-in alone while the original is live" (integration). Cloud: cloud `stand-ins.test.ts` › "DELETE /data/records/:id refuses the canonical stand-in alone while its original is live" (unit).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-195] An app that deletes a smaller stand-in alone frees its slot for a new one
  Given a member's library holds a photo with a canonical stand-in and a smaller stand-in
  When an app deletes the smaller stand-in
  Then the app still lists the photo and its canonical stand-in
  And the app can register a new stand-in in the freed slot
```

- **Coverage:** `stand-ins-read.test.ts` › "DELETE /data/records/:id deletes a smaller stand-in alone, freeing its slot" (integration, local).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-110] An app on one device stops listing a photo that an app on another device deleted
  Given a member's laptop and desktop both list a photo
  And an app on the desktop deleted the photo
  And both computers have since synced with the member's cloud
  When an app lists the library on the laptop and in the cloud
  Then the laptop's listing leaves out the photo
  And the cloud's listing leaves out the photo
```

- **Coverage:** `apps/local-data-server/__tests__/integration/sync-over-wire.test.ts` › "shared records across the wire a watched file's record deleted on B is excluded on A, and comes back when B restores it" (integration, local and an in-process cloud) covers a watched file's record only. Unit: `packages/storage-sqlite/__tests__/delta-scan.test.ts` › "querySince — delta scan includes tombstones — a deletion has to reach the peer too".
- **Notes:** [sync.md](sync.md) owns the generic exchange.

## Trash, restore, and the trash window

### Seeing what was deleted

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-111] An app lists deleted records only when it asks, and each one carries its deletion time
  Given a member deleted a photo and kept another
  When an app lists the library without asking for deleted records
  Then the app receives the kept photo only
  And a listing that asks for deleted records only returns the deleted photo with the time it was deleted
  And a listing that asks for both returns both photos
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/trash.test.ts` › "the deleted feed answers live records by default, and tombstones only when asked" and › "the deleted feed carries the deletion time, which is what a Trash shows" (integration). Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3); `example-app.spec.ts` › "Deleted: a deletion appears in the reconcile, restores, and takes derived copies but not notes" (end to end, both projects). The cloud tests assert that a deletion appears in the deleted feed, not the deletion time or the combined listing.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-112] An app reads every record deleted since it last reconciled
  Given an app last reconciled at noon
  And a member deleted one photo before noon and one after
  When the app lists deleted records changed after noon
  Then the app receives the photo deleted after noon
  And the answer leaves out the photo deleted before noon
```

- **Coverage:** local: `trash.test.ts` › "the deleted feed composes with updated_after, which is the whole of an app's delete feed" (integration). Cloud: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3; finds a recent deletion). Both: `example-app.spec.ts` › "Deleted: a deletion appears in the reconcile, restores, and takes derived copies but not notes".
- **Notes:** the cloud tests show only the inclusion. SHARED-038 covers the exclusion side of `updated_after`.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-113] An app that misspells the deleted value is refused rather than given the live library
  Given a member deleted a photo
  When an app lists the library asking for deleted records with the value "onlyy"
  Then the app's request fails as a bad request
  And the app never receives the live library in place of the deleted feed
```

- **Coverage:** local: `trash.test.ts` › "the deleted feed refuses a misspelled value rather than quietly answering the live library" (integration). Cloud: no test.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-114] An app reads the trash window, with the platform default beside it
  Given the cloud operator set the trash window to 90 days
  When an app reads the trash window
  Then the app receives 90 days
  And the answer carries the platform default of 30 days beside it
  And an app on a deployment where nobody set a window receives 30 days
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/trash.test.ts` › "the retention window is reported with the platform default beside it" (integration) covers the default only. Cloud: cloud `stand-ins.test.ts` › "GET /data/trash answers the window the owner chose, to an ordinary app" and › "GET /data/trash answers the default when the operator set none" (unit, with the deployment's settings mocked); `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3) asserts only that the field is present. Both: `example-app.spec.ts` › "Deleted: a deletion appears in the reconcile, restores, and takes derived copies but not notes" (the default of 30 days). No local test reads a window the cloud operator chose.
- **Notes:** a phone app reads the cloud's answer.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-115] An app on a device that cannot read the deployment's settings receives no trash window
  Given a device cannot read the deployment's settings
  When an app on that device reads the trash window
  Then the app receives an empty trash window rather than an error
  And every deleted record on that device stays restorable while the window stays unknown
```

- **Coverage:** cloud: cloud `stand-ins.test.ts` › "GET /data/trash answers null when the deployment's settings cannot be read" and › "POST /data/reap — the window it applies reaps nothing when the deployment's settings cannot be read" (unit). Local: no test reads the trash window without settings.

### Restoring

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-116] An app that restores a record gets it back with its stand-ins, derived records, labels, and metadata
  Given a member deleted a photo that had stand-ins, a derived copy, labels, and image metadata
  When an app with a readwrite grant on the photo's type restores the photo
  Then the app lists the photo, its stand-ins, and its derived copy again
  And the photo carries its labels and its image metadata
  And the app's answer names every record the restore brought back
```

- **Coverage:** local: `trash.test.ts` › "restore brings the record back with its labels and its metadata" (integration). Unit: `delete-and-restore.test.ts` › "applyRecordRestore brings the original and its cascade back, original first", › "applyRecordRestore brings the metadata row back on every record in the cascade", and › "applyRecordRestore lifts the labels the delete retracted, and no others"; `packages/storage-adapter/__tests__/metadata-sync.test.ts` › "deleteRecordMetadata is lifted again by restoreRecordMetadata". Both: `example-app.spec.ts` › "Deleted: a deletion appears in the reconcile, restores, and takes derived copies but not notes" (the derived copy comes back). Cloud: `routes-db.test.ts` › "per-record routes honor read/write grants POST /data/records/:id/restore takes a delete back lifts a deleted record's tombstone and answers its ids" (unit with a fake database). No route test restores stand-ins, and no cloud test reads the labels or the metadata after a restore.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-117] An app that restores a live record is refused
  Given a member's library holds a photo that nobody deleted
  When an app restores the photo
  Then the app's restore fails with a conflict that says the record is not deleted
```

- **Coverage:** local: `trash.test.ts` › "restore refuses a record that is not deleted" (integration). Cloud: `routes-db.test.ts` › "per-record routes honor read/write grants POST /data/records/:id/restore takes a delete back answers 409 NotDeleted for a live record" (unit).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-118] An app that restores a record that never existed gets a not-found answer
  Given an app holds a readwrite grant on image/jpeg
  When the app restores an id that matches no record
  Then the app receives a not-found answer
```

- **Coverage:** local: `trash.test.ts` › "restore answers 404 for a record that never existed" (integration). Cloud: no test.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-119] An app needs a write grant on a record's type to restore the record
  Given a member deleted a photo
  And an app holds only a read grant on the photo's type
  When the app restores the photo
  Then the app's restore fails with a forbidden error
  And the app still finds the photo in the deleted feed
  And an app with no grant on the type receives a not-found answer instead
```

- **Coverage:** cloud: `routes-db.test.ts` › "per-record routes honor read/write grants POST /data/records/:id/restore takes a delete back 404s a type the caller cannot read" (unit) covers the last clause. No test restores with a read-only grant in either environment.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-120] An app cannot restore a stand-in whose slot another stand-in took
  Given a member deleted a photo with a 400-pixel stand-in
  And an app has since registered a new 400-pixel stand-in for the photo
  When an app restores the photo
  Then the photo comes back with the new stand-in in that slot
  And the old stand-in stays deleted
  And the app's restore of the old stand-in on its own fails with a conflict
```

- **Coverage:** local: `apps/local-data-server/__tests__/integration/stand-ins-write.test.ts` › "restoring a stand-in answers 409 when another stand-in has taken its slot since the delete" (integration) covers the last clause. Unit: `delete-and-restore.test.ts` › "planRecordRestore leaves a stand-in whose slot a live sibling already holds" and › "planRecordRestore refuses a stand-in whose slot a live sibling already holds". Cloud: no route test.

```gherkin
@local @cloud
@intent:confirmed @coverage:none
Scenario: [SHARED-204] An app cannot restore a record permanently deleted after the trash window
  Given a member deleted a photo longer ago than the trash window
  And the photo was permanently deleted
  When an app restores the photo
  Then the app's request fails with an answer that says the photo is gone for good
  And the app does not find the photo in its listings
```

- **Coverage:** no test restores a permanently deleted record.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-122] An app on one device lists a photo again after an app on another device restores it
  Given a member deleted a photo on the desktop, and the deletion reached the laptop
  And an app on the desktop restored the photo
  And both computers have since synced with the member's cloud
  When an app lists the library on the laptop and in the cloud
  Then the app finds the photo again on the laptop and in the cloud
```

- **Coverage:** `sync-over-wire.test.ts` › "shared records across the wire a watched file's record deleted on B is excluded on A, and comes back when B restores it" (integration, local and an in-process cloud) covers a watched file's record only. Unit: `delete-and-restore.test.ts` › "applyRecordRestore advances the version rather than writing the old one back".
- **Notes:** [sync.md](sync.md) owns the generic exchange.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-123] A member who restores a file in the example app finds its note and its collections again
  Given a member wrote a note about a file in the example app
  When the member deletes the file and then restores it
  Then the note still shows on the restored file
  And the file comes back to the collections it was in
```

- **Coverage:** `example-app.spec.ts` › "Deleted: a deletion appears in the reconcile, restores, and takes derived copies but not notes" and › "Collections: a deleted file keeps its collections, and a restore returns it to them" (end to end, local and cloud projects).
- **Notes:** [app-data.md](app-data.md) owns how an app handles its own rows across a trash and restore.

### Permanent deletion after the window

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-124] An app can still restore a photo deleted inside the trash window after a permanent deletion
  Given the trash window is 30 days
  And a member deleted one photo 40 days ago and another 10 days ago
  And a permanent deletion of items past the trash window has since run
  When an app restores both photos
  Then the photo deleted 40 days ago can no longer be restored
  And the photo deleted 10 days ago comes back whole
```

- **Coverage:** local: `trash.test.ts` › "the reaper reclaims nothing inside the window, and says what it looked at" (integration) covers the item inside the window and the report. Unit: `reaper.test.ts` › "the retention window reaps bytes deleted before the window and leaves the rest" and › "a restored record is not reaped, because its tombstone is gone". Cloud: cloud `stand-ins.test.ts` › "POST /data/reap — the window it applies applies the window the owner chose, on an environment that has stamped nothing" (unit with a fake database). No integration test reclaims an item past the window.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-207] The local operator sees how many deleted items a permanent deletion looked at
  Given the trash window is 30 days
  And the local operator's computer holds one photo deleted 40 days ago and another deleted 10 days ago
  When the local operator permanently deletes items past the trash window in admin-web
  Then the page reports the files it permanently deleted
  And the page says how many items deleted more than 30 days ago it looked at
```

- **Coverage:** local: `trash.test.ts` › "the reaper reclaims nothing inside the window, and says what it looked at" (integration) checks the report that the page shows. No admin-web test renders the count of items looked at.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-125] An app can still restore every deleted photo after an estimate of a permanent deletion
  Given a member deleted photos longer ago than the trash window
  And someone estimated a permanent deletion of items past the trash window
  When an app restores the deleted photos
  Then every deleted photo comes back whole
```

- **Coverage:** local: `trash.test.ts` › "the reaper estimates without removing on a dry run" (integration). Unit: `reaper.test.ts` › "the retention window estimates without removing on a dry run". Cloud: the cloud route runs the same reaper, and no cloud route test drives a dry run.
- **Notes:** SHARED-196 covers what the cloud operator's page says after an estimate.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-126] An app can still restore a deleted photo on a device that does not know the trash window
  Given a device cannot read the deployment's settings
  And a member deleted a photo on that device a year ago
  And a permanent deletion of items past the trash window ran on that device
  When an app on that device restores the photo
  Then the photo comes back whole
```

- **Coverage:** unit: `reaper.test.ts` › "the retention window reaps nothing at all when this host cannot read the window". Cloud: cloud `stand-ins.test.ts` › "POST /data/reap — the window it applies reaps nothing when the deployment's settings cannot be read" (unit).
- **Notes:** SHARED-197 covers what the cloud operator's page says when the computer does not know the trash window.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-127] An app still loads a live record's file after a permanent deletion removes a record with the same bytes
  Given a member's library holds two records with the same bytes under different names
  And the member deleted one of them longer ago than the trash window
  And a permanent deletion of items past the trash window has since run
  When an app loads the live record's file
  Then the file loads
```

- **Coverage:** unit: `reaper.test.ts` › "the refcount over the object key leaves bytes a live record still holds", › "the refcount over the object key waits for the newest tombstone on the key, not the oldest", and › "the refcount over the object key finds the newest tombstone on a key shared by more records than one page holds". No route test in either environment reclaims shared bytes.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-128] A member still finds a file in a watched folder after its deleted record is permanently deleted
  Given a member deleted the record of a file that still sits in a watched folder
  And the deletion is older than the trash window
  And a permanent deletion of items past the trash window has since run
  When the member opens the watched folder
  Then the file is still there
```

- **Coverage:** unit: `reaper.test.ts` › "bytes this host only links to are refused rather than unlinked and counted as reclaimed" and › "bytes this host only links to keep the rows a restore needs, because the bytes are still readable here". No integration test reclaims with a watched folder.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-208] The local operator sees a watched-folder file counted as kept rather than permanently deleted
  Given the local operator's computer holds a deleted record of a file that still sits in a watched folder
  And the deletion is older than the trash window
  When the local operator permanently deletes items past the trash window in admin-web
  Then the page counts the file as kept rather than permanently deleted
```

- **Coverage:** unit: `reaper.test.ts` › "bytes this host only links to are refused rather than unlinked and counted as reclaimed" checks the count that the page shows. No admin-web test renders a kept file.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [SHARED-129] An app other than Drive cannot reclaim deleted items in the cloud
  Given a member's cloud holds deleted items past the trash window
  When an app other than Drive asks the cloud to reclaim
  Then the app's request fails with a forbidden error
  And every deleted item can still be restored whole
```

- **Coverage:** no test sends a reclaim from an ordinary app. `packages/admin-installer/builtin-apps/cloud-data-server/__tests__/delegation-policy.test.ts` refuses the route to delegated tokens only, which [users-and-access.md](users-and-access.md) owns.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-196] The local operator permanently deletes items past the trash window only from an estimate
  Given the local operator opens the stand-ins section of admin-web
  When the local operator looks at "Permanently delete items past the trash window"
  Then the "Permanently delete" button is disabled
  And after the local operator presses Estimate the page says what would be permanently deleted and "Permanently delete" turns on
  And after the local operator presses "Permanently delete" the page reports what was deleted and the button turns off again
```

- **Coverage:** `apps/admin-web/__tests__/stand-ins-section.test.tsx` › "the stand-in section reclaiming deleted files reclaims only from an estimate, like every other destructive pass" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-197] The page says the computer does not know the trash window rather than reporting a clean run
  Given the local operator's computer cannot read the deployment's settings
  When the local operator estimates a permanent deletion of items past the trash window
  Then the page says the computer does not know how long a deleted item is kept and that nothing will be permanently deleted
  And the page shows the reason the settings read failed
```

- **Coverage:** `stand-ins-section.test.tsx` › "the stand-in section reclaiming deleted files says it does not know the window rather than reporting a clean run" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-198] The page names deleted files held in deep archive, so their standing cost stays visible
  Given four deleted files past the trash window sit in deep archive in the cloud
  When the local operator estimates a permanent deletion of items past the trash window
  Then the page says four files sit in deep archive and that removing them now would cost as much as keeping them
```

- **Coverage:** `stand-ins-section.test.tsx` › "the stand-in section reclaiming deleted files names the deep-archive exception, so its standing cost stays visible" (unit, local). Unit: `reaper.test.ts` › "an archived object is skipped and counted, because deleting it early is charged anyway".

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-199] The cloud operator changes how long deleted items are kept, and the page says every device will use the new window
  Given the trash window is 30 days
  When the cloud operator sets "Keep deleted items for" to 90 days and saves
  Then the page says every device will use 90 days within a minute
```

- **Coverage:** `stand-ins-section.test.tsx` › "the trash window shows the deployment's window and saves a change through the settings route" (unit, local).
- **Notes:** [residency-and-stand-ins.md](residency-and-stand-ins.md) owns the other deployment settings on the same page.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-209] An app on any device reads the new trash window soon after the cloud operator changes it
  Given the trash window was 30 days
  And the cloud operator has since changed "Keep deleted items for" to 90 days
  When an app on any device or in the cloud reads the trash window a minute later
  Then the app receives 90 days
```

- **Coverage:** unit: `reaper.test.ts` › "the retention window honours a window the settings file widened"; `packages/sync-engine/__tests__/library-settings.test.ts` › "the cache never answers the retention window from the cache". No test reads the new window on another device.

```gherkin
@local @cloud
@intent:confirmed @coverage:none
Scenario: [SHARED-200] A member finds items past the trash window gone for good, with their storage freed, without anyone's help
  Given a member deleted photos longer ago than the trash window
  And no local operator chose "Permanently delete" in admin-web
  When a day passes
  Then the member can no longer restore those photos
  And the photos' files no longer take up the member's storage
```

- **Coverage:** no test runs a scheduled permanent deletion.
- **Notes:** SHARED-196 covers the local operator's way to permanently delete at once.

## Archived records

In the cloud, an original whose canonical stand-in is safe can move to an archive storage tier. [residency-and-stand-ins.md](residency-and-stand-ins.md) owns when an original archives, the canonical stand-in it keeps, and the do-not-archive label. This section owns what an app sees of an archived record and how it thaws one.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SHARED-130] An app learns from a listing whether each record's bytes are readable now
  Given a member's library holds a record whose bytes are <state> on the device the app asks
  When an app lists the record
  Then the record carries the availability <answer>

  Examples:
    | state                                     | answer                                          |
    | stored and readable                       | readable now                                    |
    | archived in the cloud                     | archived, with the tier and the expected wait   |
    | being thawed in the cloud                 | restoring, with the time it should be ready     |
    | declined by this computer                 | absent                                          |
    | still on another device, in the cloud     | awaiting upload                                 |
```

- **Coverage:** cloud: `routes-db.test.ts` › "availability and restore reports instant for an object nothing has moved" and › "availability and restore reports archived, with the tier and the wait, on the listing itself" (unit); cloud `stand-ins.test.ts` › "reads of a file not uploaded yet reports the original's availability on the record route" (unit). Unit: `packages/protocol-primitives/__tests__/availability.test.ts` › "availability defaults treats only instant as readable now". No test reads a restoring or an absent answer from a listing, and no local test reads availability.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-131] An app is refused a file URL for archived bytes, and its request starts no thaw
  Given a member's cloud library holds an original whose bytes are archived
  When an app asks the cloud for the original's file URL
  Then the app's request fails with a conflict that says the bytes are archived
  And the app still finds the original archived
```

- **Coverage:** `routes-db.test.ts` › "availability and restore refuses a file-url for archived bytes with 409, and does not restore" (unit, cloud).
- **Notes:** [residency-and-stand-ins.md](residency-and-stand-ins.md) owns the content read of an archived original that stands in for itself.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-132] An app that asks for bytes already thawing is refused rather than queueing another thaw
  Given an app started a thaw of an archived original
  When an app asks for the original's file URL before the thaw finishes
  Then the app's request fails with a conflict that says the bytes are being restored
  And no second thaw starts
```

- **Coverage:** `routes-db.test.ts` › "availability and restore 409s a read of bytes already being restored rather than queueing another" (unit, cloud).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-133] An app that asks to thaw without confirming receives a cost and time estimate and starts nothing
  Given a member's cloud library holds an archived original
  When an app asks to thaw the original without confirming
  Then the app receives an estimate of the cost and the hours until the bytes are readable
  And the answer says confirmation is required
  And the app still finds the original archived
```

- **Coverage:** `routes-db.test.ts` › "availability and restore POST /data/records/:id/thaw-archive returns an estimate and does nothing without confirmation" and › "availability and restore POST /data/records/:id/thaw-archive does not ask S3 to thaw anything when only an estimate was requested" (unit, cloud). Unit: `availability.test.ts` › "restore estimates carries the object count and how long the thawed copy lasts".

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-134] An app that confirms a thaw starts it on the fast tier, or on the cheap tier when it asks
  Given a member's cloud library holds an archived original
  When an app confirms a thaw of the original
  Then the original's availability becomes restoring, with the time it should be ready
  And the thaw uses the fast tier unless the app asked for the cheap, slower tier
```

- **Coverage:** `routes-db.test.ts` › "availability and restore POST /data/records/:id/thaw-archive issues the restore only on explicit confirmation", › "availability and restore POST /data/records/:id/thaw-archive actually asks S3 to thaw the object", and › "availability and restore POST /data/records/:id/thaw-archive defaults to the fast tier and lets a caller opt into the cheap one" (unit, cloud). The test sees the thaw and the availability write only as calls to a mocked S3 and a fake database, and no tier-3 test thaws an object.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-135] An app that thaws a readable record, or one already thawing, starts no second thaw
  Given a member's cloud library holds a readable original and an original already thawing
  When an app confirms a thaw of each
  Then the app learns that the first is already readable
  And the app learns that the second is already restoring
  And no new thaw starts for either
```

- **Coverage:** `routes-db.test.ts` › "availability and restore POST /data/records/:id/thaw-archive reports an already-readable record without restoring it" and › "availability and restore POST /data/records/:id/thaw-archive does not queue a second restore for bytes already thawing" (unit, cloud).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-136] An app with only a read grant may thaw a record, and an app with no grant may not
  Given a member's cloud library holds an archived original
  When an app with only a read grant on the original's type confirms a thaw
  Then the thaw starts
  And an app with no grant on the type receives a forbidden error instead
```

- **Coverage:** `routes-db.test.ts` › "availability and restore POST /data/records/:id/thaw-archive 403s a caller with no read grant on the type" (unit, cloud) covers the last clause. No test thaws with a read-only grant.

```gherkin
@cloud
@intent:unclear @coverage:none
Scenario: [SHARED-137] An app is refused a thaw while too many thaws are already in flight
  Given a member's apps have thaws in flight for 100 archived files
  When an app confirms a thaw of one more archived file
  Then the app's request fails with a too-many-requests error that says to wait for thaws to finish
  And no thaw starts for that file
```

- **Coverage:** no test drives the limit.

## Public links

A public link lets a visitor see a member's records without signing in. A label link shows the stand-ins of every record that carries one label, such as a Photos album. A record link shows one record. Public links live in the cloud. A signed-in computer and a phone create and manage them through the cloud. The Photos share buttons belong to the Photos files in starkeep-apps, and Drive's share dialog belongs to [drive.md](drive.md). Unless a scenario names it, `public-shares-routes.test.ts` means `packages/admin-installer/builtin-apps/cloud-data-server/__tests__/integration/public-shares-routes.test.ts` (integration, cloud data server against a real database) and `public-share-signing.test.ts` means `packages/admin-installer/builtin-apps/cloud-data-server/__tests__/public-share-signing.test.ts` (unit, cloud).

### Allowing an app to publish

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-138] Only an app whose manifest declares public sharing, and which the member approved at install, can create a public link
  Given Photos declares public sharing and the member approved it at install
  And a second app declares no public sharing
  When each app creates a public link to one of the member's photos
  Then Photos receives a new link
  And the second app's request fails with a forbidden error
```

- **Coverage:** `public-shares-routes.test.ts` › "the owner's public-share routes refuse creation without the approved capability" (integration); `packages/admin-installer/builtin-apps/cloud-data-server/__tests__/integration/two-users-routes.test.ts` › "a mobile app through the broker creates no public link for an app that was not approved to publish" (integration); `packages/admin-manifest/__tests__/validate.test.ts` › "id-bound privilege flags rejects publicSharing for an app with no cloud target" (unit).
- **Notes:** the install consent dialog's public-links text is APP-LIFE-018 in [app-lifecycle.md](app-lifecycle.md).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-139] A visitor is told an app's link does not exist once an upgrade drops the app's public sharing
  Given Photos made a public link to an album
  And an upgrade of Photos has since dropped public sharing from its manifest
  When a visitor opens the link
  Then the visitor is told the link does not exist
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share is refused once the app loses the capability" (integration) deletes the capability row directly. No test drives an upgrade that drops the declaration.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-203] A visitor is told an app's links do not exist once the app is no longer installed
  Given Photos made public links to two albums
  And Photos is no longer installed in the cloud
  When a visitor opens either link
  Then the visitor is told the link does not exist
```

- **Coverage:** `packages/admin-installer/__tests__/dsql-ddl.test.ts` › "uninstall DDL deletes the app's public shares, its capability, its delegations, their OAuth rows and its job enrollments" (unit). No test opens a link after an uninstall.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-140] A cloud operator finds Drive's public-link switch off after installing Drive
  Given a cloud operator installed Drive in the cloud
  When the cloud operator opens Drive's card in admin-web
  Then the "Enable sharing" switch is off
  And Drive cannot create a public link until the cloud operator turns it on
```

- **Coverage:** `apps/admin-web/__tests__/public-shares-route.test.ts` › "the Drive public-link switch starts off and reads without writing" (unit, local admin-web); `public-shares-routes.test.ts` › "a record share is refused for Drive once the admin-web switch is off" (integration, cloud).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-141] A cloud operator turns Drive's public links on and off from admin-web
  Given Drive's public-link switch is off
  When the cloud operator turns the switch on
  Then Drive can create public links
  And turning the switch off again stops Drive from creating them
  And no other app's permission changes
```

- **Coverage:** `public-shares-route.test.ts` › "the Drive public-link switch turns on and off by writing Drive's row only" and › "the Drive public-link switch refuses an enabled value that is not a boolean" (unit, local admin-web). `public-shares-routes.test.ts` › "a record share is refused for Drive once the admin-web switch is off" (integration, cloud).
- **Notes:** the switch sits on Drive's card, which [drive.md](drive.md) owns.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-142] A visitor is told a Drive link does not exist once Drive's public-link switch is off
  Given Drive made a public link to a file
  And the cloud operator has since turned Drive's public-link switch off
  When a visitor opens the link
  Then the visitor is told the link does not exist
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share is refused once the app loses the capability" (integration) drives a Photos share, and › "a record share is refused for Drive once the admin-web switch is off" drives a new Drive link. No test opens an existing Drive link after the switch goes off.

### Creating and managing a link

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-143] A member creates a link to a label's records, such as a Photos album, that expires in 30 days by default
  Given a member has an album in Photos in the cloud
  When the member makes a public link to the album without choosing a lifetime
  Then the member receives a link
  And the link expires 30 days from now
```

- **Coverage:** `public-shares-routes.test.ts` › "the owner's public-share routes default to a 30-day lifetime, and allow never" (integration). End to end: `example-app.spec.ts` › "Public links: create one to a file, open it signed out, and revoke it" (cloud project).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario Outline: [SHARED-144] A member chooses a link's lifetime
  Given a member has an album in Photos in the cloud
  When the member makes a public link to the album with the lifetime <lifetime>
  Then the link expires <expiry>

  Examples:
    | lifetime | expiry               |
    | 1 day    | one day from now     |
    | 7 days   | seven days from now  |
    | 30 days  | 30 days from now     |
    | 1 year   | 365 days from now    |
    | never    | never                |
```

- **Coverage:** `public-share-signing.test.ts` › "public-share identifiers turns a lifetime into an expiry, and refuses anything else" (unit); `public-shares-routes.test.ts` › "the owner's public-share routes default to a 30-day lifetime, and allow never" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SHARED-145] An app that creates a link with a bad label key, lifetime, or title is refused
  Given Photos can create public links
  When Photos creates a link with <problem>
  Then Photos' request fails as a bad request
  And Photos finds no new link among the member's links

  Examples:
    | problem                                         |
    | a label key its manifest does not declare       |
    | the lifetime "3 weeks"                          |
    | an empty title                                  |
    | a title longer than 200 characters              |
```

- **Coverage:** `public-shares-routes.test.ts` › "the owner's public-share routes refuse an undeclared label key and a bad lifetime" (integration). No test sends a bad title.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-146] A member changes a link's title or lifetime, and the lifetime counts from the change
  Given a member made a 7-day link to an album five days ago
  When the member changes the link's lifetime to 7 days and its title to "Summer"
  Then the link expires seven days from now
  And the link's page shows the title "Summer"
  And the link's address stays the same
```

- **Coverage:** `public-shares-routes.test.ts` › "the owner's public-share routes let a signed-in desktop create, change and stop a link, as its local data server forwards" (integration) changes a link. No test checks that the expiry counts from the change.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-147] A member replaces a link, and the old address stops working while the share stays
  Given a member made a public link to an album and sent it to a friend
  When the member replaces the link
  Then the member receives a new address for the same album
  And opening the old address shows that the link does not exist
  And opening the new address shows the album
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share loses the old link when the owner replaces it" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-148] A member stops a link, and the next visit is refused
  Given a member made a public link to an album
  When the member stops the link
  Then the link no longer appears in the member's list of links
  And opening the link after the edge cache expires shows that the link does not exist
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share is refused an unknown token, a revoked share and an expired one" (integration); `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" (tier-3; the list drops the stopped link); `example-app.spec.ts` › "Public links: create one to a file, open it signed out, and revoke it" (end to end, cloud project).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-149] An app acting for one member cannot see or change another member's link
  Given two members of one deployment each made a public link in Photos
  When Photos, acting for the first member, changes or stops the second member's link by its id
  Then Photos receives an answer that no such link exists
  And the second member's link keeps working
```

- **Coverage:** `public-shares-routes.test.ts` › "the owner's public-share routes refuse another user's share as missing" (integration).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-150] An app on a signed-in computer creates, changes, and stops a public link in the cloud
  Given a member's computer is signed in to the member's cloud
  When Photos on the computer creates a public link, changes its title, and stops it
  Then each step takes effect in the cloud
  And the app can manage only the member's own links, and only when the app is approved to publish
```

- **Coverage:** `apps/local-data-server/__tests__/integration/cloud-proxy-seam.test.ts` › "LDS /cloud/data proxy with a real device-token check creates, changes, lists and stops a public link in the cloud, on the app's own channel" (integration, local and cloud); `public-shares-routes.test.ts` › "the owner's public-share routes let a signed-in desktop create, change and stop a link, as its local data server forwards" and › "the owner's public-share routes hold a signed-in desktop to the capability and to its own user's shares" (integration).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [SHARED-201] An app on a computer that is not signed in to a cloud is refused a public link at once
  Given a member's computer is not signed in to any cloud
  When Photos on the computer creates a public link
  Then the app's request fails at once
  And the app can tell the member that public links need a cloud
```

- **Coverage:** `cloud-proxy-seam.test.ts` › "a machine that is not signed in refuses a public link locally, and the cloud holds none" (integration, local); `example-app.spec.ts` › "Public links: unavailable without a cloud" (end to end, local project); `e2e/tests/probe-platform.spec.ts` › "every app-facing data route answers through the app's own proxy" (tier-2, local).

```gherkin
@mobile
@intent:confirmed @coverage:full
Scenario: [SHARED-202] A phone app creates and stops public links for its own app only
  Given a member signed in to Photos on a phone
  When Photos on the phone creates a public link and then stops it
  Then each step takes effect in the cloud, as the member
  And Photos on the phone is refused when it asks for a public link on Drive's channel
```

- **Coverage:** `two-users-routes.test.ts` › "a mobile app through the broker creates and stops a public link for its own app, as its user, and not on Drive's channel" (integration, cloud); `packages/admin-installer/builtin-apps/cloud-data-server/__tests__/handler-mobile-key.test.ts` › "a signed request passes the gate for its attested app's public links" and › "a signed request refuses public links on Drive's channel, which its key may sync on" (unit).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-151] An app finds a member's existing link by the record it shares
  Given a member made a record link to one photo
  When an app lists the member's links for that photo
  Then the app receives the photo's link with what it serves
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share is listed by its record, and answers its source" (integration).

### Visiting a label link

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-152] A visitor sees an album's stand-ins and nothing that names or reaches an original
  Given a member made a public link to a Photos album
  When a visitor opens the link without signing in
  Then the visitor sees each photo's stand-ins
  And the page carries no record id, label, caption, date, or metadata beyond each photo's display size
  And no URL on the page reaches an original
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share sees the album's stand-in and nothing that names or reaches the original" (integration). Unit: `public-share-signing.test.ts` › "signPublicShareCloudFrontUrl signs a display child the page admitted", › "signPublicShareCloudFrontUrl refuses a member's own key", and › "signPublicShareCloudFrontUrl refuses a key the page never returned".

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-153] A visitor sees a video's poster frame and playable stand-in, never the video itself
  Given a member's album holds a video
  When a visitor opens the album's public link
  Then the visitor sees the video's poster frame and can play its stand-in
  And no URL on the page reaches the original video
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share sees a video's poster frame and playable stand-in, never the video itself" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-154] A visitor sees a photo the member added to the album on the next visit, and stops seeing one the member removed
  Given a member made a public link to an album
  And the member has since added one photo to the album and removed another
  When a visitor opens the link after the edge cache expires
  Then the visitor sees the added photo
  And the visitor no longer sees the removed photo
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share stops seeing a photo once the owner takes it out of the album" (integration) covers the removal. No test adds a photo after the link exists.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-155] A visitor does not see a photo whose stand-ins do not exist yet
  Given a member's album holds a photo whose stand-ins do not exist yet
  When a visitor opens the album's public link
  Then the visitor does not see that photo
  And the visitor sees the album's other photos
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share does not see a member with no stand-in yet" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-156] A visitor sees nothing extra when an app puts the album's label on a stand-in
  Given a member made a public link to an album
  And an app put the album's label on a stand-in rather than on an original
  When a visitor opens the link
  Then the visitor sees nothing for that stand-in
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share sees nothing through a label on a child record" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-157] A visitor never sees another member's photos that carry the same label value
  Given two members of one deployment each have an album whose label value is the same
  When a visitor opens the first member's album link
  Then the visitor sees only the first member's photos
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share never sees another user's photos carrying the same label value" (integration). Unit: `public-share-signing.test.ts` › "signPublicShareCloudFrontUrl refuses another user's key, even one admitted by mistake".

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-158] A visitor who makes up a page cursor gets no error and no wider page
  Given a member made a public link to an album
  When a visitor opens the link's next page with a cursor the visitor made up
  Then the visitor receives no error
  And the visitor sees nothing beyond the album's photos
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share gets no error and no wider page for a cursor it made up" (integration) asserts a status below 500 and no other member's data. A 400 would pass the test, so no test shows that the visitor receives no error.

```gherkin
@cloud
@intent:unclear @coverage:none
Scenario: [SHARED-159] A visitor sees at most 2,000 photos on a link and is told when it holds more
  Given a member's album holds 2,500 photos
  When a visitor opens the album's public link
  Then the visitor sees at most 2,000 photos
  And the page says that the album holds more than it shows
```

- **Coverage:** no test builds a link with more than 2,000 members.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-160] A visitor of two links cannot match a photo's item id on one link to its item id on the other
  Given a member made two public links, and one photo appears in both albums
  When a visitor opens both links
  Then the photo carries a different item id on each link
  And the photo keeps the same item id on every visit to one link
```

- **Coverage:** `public-share-signing.test.ts` › "public-share identifiers derives item ids stable within a share and unlinkable across shares" (unit).
- **Notes:** the stand-in URLs themselves still let a visitor of both links tell that one photo appears in both (`docs/data-roles-and-permissions.md` › "A public share's visitor", residual risks).

### Visiting a record link

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-161] A visitor of a Photos record link sees one photo's stand-in on the page and through the direct link
  Given a member made a record link to one photo in Photos
  When a visitor opens the link's page and its direct file link
  Then the page shows the photo's stand-in
  And the direct link opens the photo's stand-in
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share from Photos shows one photo's stand-in on the items page and through the direct link" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-162] A visitor of a Photos record link never receives the original
  Given a member made a record link to one photo in Photos
  When a visitor asks the direct link for the original
  Then the visitor receives the stand-in or a refusal, never the original
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share from Photos is refused the original" (integration). Unit: `public-share-signing.test.ts` › "signPublicFileCloudFrontUrl admits a photo's original only when the share says original".

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-163] A visitor of a Drive record link receives a photo's largest stand-in by default, named in its own format
  Given a member shared a photo from Drive without choosing the original
  When a visitor opens the direct link
  Then the visitor receives the photo's largest stand-in
  And the download name carries the stand-in's own format extension
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share from Drive serves a photo's largest stand-in by default, named in its own format" (integration). Unit: `public-share-signing.test.ts` › "publicFileResponse names a stand-in with its own format in place of the original's extension".

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-164] A visitor of a Drive record link receives a photo's original when the member chose it, named after the title
  Given a member shared a photo from Drive and chose to share the original
  When a visitor opens the direct link
  Then the visitor receives the original photo
  And the download name is the link's title with the original's extension
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share from Drive serves a photo's original when asked, named after the title" (integration). Unit: `public-share-signing.test.ts` › "publicFileResponse adds the original's extension to the title" and › "publicFileResponse keeps a title that already ends in the extension".

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-165] A visitor of a Drive record link plays a video's stand-in, or receives the video itself when the member chose it
  Given a member shared one video from Drive with the stand-in and another with the original
  When a visitor opens each direct link
  Then the visitor plays the video's stand-in from the first link
  And the visitor receives the original video from the second link
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share from Drive serves a video's playable stand-in, or the video itself" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-166] A visitor of a Drive record link to a non-media file receives the original
  Given a member shared a PDF from Drive
  When a visitor opens the direct link
  Then the visitor receives the PDF itself, whichever choice the member made
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share from Drive serves a file's original, whatever serves was asked" (integration). Unit: `public-share-signing.test.ts` › "signPublicFileCloudFrontUrl admits a file member whatever the share's serves column says".

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario Outline: [SHARED-167] A visitor sees a linked file in the browser as its real content type, with the title as its download name
  Given a member shared a <type> file from Drive with the title "Notes"
  When a visitor opens the direct link
  Then the visitor sees the file as <shown>
  And the visitor who saves the file is offered a name that starts with "Notes"

  Examples:
    | type             | shown                         |
    | JPEG             | a JPEG image                  |
    | QuickTime video  | a QuickTime video             |
    | MP3              | audio                         |
    | PDF              | a PDF                         |
    | Markdown         | plain text                    |
```

- **Coverage:** `public-share-signing.test.ts` › "publicFileResponse shows image/jpeg in the browser as image/jpeg", › "publicFileResponse shows video/mov in the browser as video/quicktime", › "publicFileResponse shows audio/mp3 in the browser as audio/mpeg", › "publicFileResponse shows document/pdf in the browser as application/pdf", › "publicFileResponse shows document/markdown in the browser as text/plain; charset=utf-8", and › "publicFileResponse gives a non-ASCII title an ASCII fallback and the UTF-8 form" (unit); `public-shares-routes.test.ts` › "a record share from Drive serves a photo's original when asked, named after the title" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-168] A visitor receives a linked SVG or HTML file as a download instead of a page, so its script never runs
  Given a member shared an SVG file and an HTML file from Drive
  When a visitor opens either direct link
  Then the visitor receives the file as a download rather than seeing it
  And no script in the file runs on the deployment's address
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share from Drive downloads an SVG as an opaque file, so its script never runs on this origin" and › "a record share from Drive downloads an HTML file as an opaque file, so its script never runs on this origin" (integration). Unit: `public-share-signing.test.ts` › "publicFileResponse downloads image/svg as an opaque file, never shown" and › "publicFileResponse downloads document/html as an opaque file, never shown".

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-169] A visitor of a label link gets no file from its direct file address
  Given a member made a public link to an album
  When a visitor opens the link's direct file address
  Then the visitor receives no file
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share gives a label share no direct link, and an expired one the expiry" (integration). Unit: `public-share-signing.test.ts` › "signPublicFileCloudFrontUrl admits nothing for a label share, a child record or another record".

### Refusals and unavailable content

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario Outline: [SHARED-170] A visitor is refused an unknown, stopped, or expired link, and learns when a link has expired
  Given a visitor holds <link>
  When the visitor opens it
  Then the visitor is told <answer>

  Examples:
    | link                        | answer                                        |
    | a link that never existed   | the link does not exist                       |
    | a link the member stopped   | the link does not exist                       |
    | a link past its expiry      | the link has expired                          |
```

- **Coverage:** `public-shares-routes.test.ts` › "a visitor of a public share is refused an unknown token, a revoked share and an expired one" and › "a record share gives a label share no direct link, and an expired one the expiry" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-171] A visitor of a record link sees nothing once the member deletes the record
  Given a member made a record link to one photo
  And the member has since deleted the photo
  When a visitor opens the link
  Then the visitor sees no photo and receives no file
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share stops showing anything once its record is deleted" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario Outline: [SHARED-172] An app cannot create a record link for a record it may not share
  Given Photos can create public links
  When Photos creates a record link to <record>
  Then Photos' request is refused
  And Photos finds no new link among the member's links

  Examples:
    | record                               |
    | a stand-in rather than an original   |
    | another member's photo               |
    | a record of a type Photos cannot read |
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share is refused for a child record, another user's record and a type the app cannot read" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-173] An app cannot link an archived or thawing original, and can still link its stand-in
  Given a member's photo has an archived original and a stand-in in the cloud
  When Drive creates a record link that serves the original
  Then Drive's request is refused because the original is archived
  And Drive can create a record link that serves the photo's stand-in, and the link works
  And the same holds while the original is thawing
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share is refused an original that is archived, and may still share the stand-in" and › "a record share is refused an original that is restoring, and may still share the stand-in" (integration) assert the refusal and the creation of the stand-in link. No test opens the stand-in link.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-174] A visitor of a link whose original archived later is told it is archived
  Given a member shared a photo's original from Drive
  And the original moved to the archive tier after the link was made
  When a visitor opens the direct link
  Then the visitor is told the file is archived
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share answers archived for an original that archived after its link was made" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [SHARED-210] An app still finds a linked original archived after a visitor opens its link
  Given a member shared a photo's original from Drive
  And the original moved to the archive tier after the link was made
  And a visitor has since opened the direct link
  When an app lists the photo
  Then the original's availability is still archived, with no thaw under way
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share answers archived for an original that archived after its link was made" (integration) asserts the visitor's answer only. No test checks that a visitor's open starts no thaw.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-175] A visitor is told a photo is still uploading rather than gone
  Given a member shared a photo whose stand-in has not reached the cloud yet
  When a visitor opens the record link
  Then the visitor is told the photo is still uploading
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share tells a visitor a photo is still uploading, rather than gone" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SHARED-176] A visitor is told a file is not uploaded when its bytes are still on a device
  Given a member shared a file from Drive whose bytes are still only on the member's computer
  When a visitor opens the direct link
  Then the visitor is told the file is not uploaded yet
```

- **Coverage:** `public-shares-routes.test.ts` › "a record share answers not uploaded for a file whose bytes are still on a device" (integration).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-177] A visitor may still see a stopped link's album for up to a minute, and stand-ins already loaded for up to an hour
  Given a visitor opened an album's public link a moment ago
  And the member has since stopped the link
  When the visitor reopens the page and the stand-in URLs the visitor already holds
  Then the visitor may still see the album within a minute of the stop
  And a stand-in URL the visitor already holds keeps loading for up to an hour
  And the visitor sees nothing on a visit after those limits
```

- **Coverage:** `packages/admin-installer/__tests__/cloudfront-distribution.test.ts` › "/public-shares/* — anonymous public-share items pages caches for a minute, keyed by path and query string" (unit) covers the first clause. No test checks the URL lifetime after a stop.

### Public Links in admin-web

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SHARED-178] A cloud operator sees every public link in the deployment, with its app, what it shows, its owner, and its expiry
  Given members made public links in Photos and Drive
  When the cloud operator opens the Public Links section of admin-web
  Then the section lists every link with its app, its title, its owner, and its expiry
  And each link says what it shows, such as an album's stand-ins or one file's original
  And a link that serves an original is marked
```

- **Coverage:** `apps/admin-web/__tests__/public-shares-section.test.tsx` › "PublicSharesSection says what each link shows, and marks a link that serves an original" (unit, local) covers the last two clauses.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [SHARED-179] A cloud operator turns off a link after confirming, and the list no longer shows it
  Given a member made a public link to an album
  When the cloud operator presses "Turn off" for the link in admin-web
  Then admin-web asks the cloud operator to confirm that anyone holding the link loses access
  And after the cloud operator confirms, the list no longer shows the link
  And opening the link shows that it does not exist
```

- **Coverage:** no test drives Turn off.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [SHARED-180] An empty deployment shows "No public links", and a failed load shows an error
  Given the deployment has no public links, or its list of links cannot load
  When the cloud operator opens the Public Links section of admin-web
  Then the section shows "No public links", or "Could not load public links" with the reason
```

- **Coverage:** no test renders the empty or the failed state.

- The install consent dialog's public-links text is APP-LIFE-018 in [app-lifecycle.md](app-lifecycle.md), covered by `apps/admin-web/__tests__/public-sharing-consent.test.ts` (formerly SHARED-181).

## Storage guarantees

[uploads-and-file-bytes.md](uploads-and-file-bytes.md) owns the checksum on upload. This section owns what a member or an app sees when stored or fetched bytes do not match their record.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-182] An app never receives a file whose bytes do not match its content hash
  Given a member's library lists a photo whose bytes live only in the cloud
  And the bytes that arrive from the cloud do not match the photo's content hash
  When an app on the member's computer asks for the photo's file URL
  Then the app receives an error rather than a URL
  And no later file URL for the photo serves the mismatched bytes from the member's computer
```

- **Coverage:** unit: `packages/storage-adapter/__tests__/stream-verify.test.ts` › "verifyingStream errors the stream rather than closing it when the digest disagrees" and › "verifyingStream names the key and both digests, so a corrupt copy can be found"; `packages/storage-fs/__tests__/adapter.test.ts` › "FsObjectStorageAdapter streaming leaves nothing at the key when the digest disagrees"; `packages/storage-adapter/__tests__/mock-object-storage-adapter.test.ts` › "MockObjectStorageAdapter checksum enforcement stores a body that matches the declared checksum". No route test serves a mismatched file.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-183] An app receives an error, not a complete-looking file, when a download from the cloud is cut short
  Given a member's library lists a video whose bytes live only in the cloud
  And the connection to the cloud ends before the whole video reaches the member's computer
  When an app on the member's computer asks for the video
  Then the app receives an error
  And no later file URL for the video serves the partial file
```

- **Coverage:** unit: `stream-verify.test.ts` › "verifyingStream catches a truncated stream" and › "verifyingStream propagates cancellation to the source". No integration test cuts a download short.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-184] An app finds two records for one file added under two names, and the two share one stored copy
  Given a member's library holds "beach.jpg"
  And an app or a watched folder has since added the same bytes as "beach-copy.jpg"
  When an app lists the library and loads both files
  Then the app receives two records
  And both records load the same bytes
  And the second copy adds no stored bytes to the member's library
  And after one record is deleted, the other still loads its bytes
```

- **Coverage:** local: `records.test.ts` › "dedup same bytes under a different filename is a new record" (integration) covers the two records. Unit: `packages/protocol-primitives/__tests__/object-keys.test.ts` › "dataRecordObjectKey places data record blobs under shared/<userId>/<category>/<shard>/<hash>"; `reaper.test.ts` › "the refcount over the object key leaves bytes a live record still holds". Cloud: `routes-db.test.ts` › "record registration asks for the filename too, so two copies under different names stay apart" (unit). No test checks that the two records share one stored object.
- **Notes:** [local-data-server.md](local-data-server.md) links here for watched folders.

- A member's records are invisible to every other member of the deployment: see ACCESS-102 in [users-and-access.md](users-and-access.md) (formerly SHARED-185).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [SHARED-186] An app receives the same records and labels from the local and the cloud data servers
  Given a member's computer and the member's cloud hold the same records and labels
  When an app sends the same records query, label query, or reverse query to each
  Then the app receives the same records in the same order from both
  And a page token from one server's answer continues that server's query
```

- **Coverage:** unit: `label-conformance.test.ts` runs one label contract against the in-memory and the SQLite adapters (for example › "label contract — SqliteDatabaseAdapter pages a key whose values are a MIX of flags and strings"); `label-find.test.ts` › "planFindByLabel orders on the index's residual key, identically on both backends"; `mock-shared-query.test.ts` › "MockDatabaseAdapter.queryShared orders with the term's own null position and pages by keyset". Both: `journey.test.ts` › "tier-3 cloud journey: probe (prefix sk112) every app-facing data route answers through the cloud-served probe proxy" and `probe-platform.spec.ts` › "every app-facing data route answers through the app's own proxy" run one sweep on each surface. No test compares the two servers' answers to one query.
