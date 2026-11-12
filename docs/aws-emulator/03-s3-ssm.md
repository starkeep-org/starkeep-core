# AWS Emulator, S3 storage adapter and SSM credential paths

Issue: AI-734 (epic AI-678, wave 2). Spike: [`spikes/aws-emulator/s3-ssm/`](../../spikes/aws-emulator/s3-ssm/).
Builds on [01-runtime.md](01-runtime.md) (install, TLS trust, credentials) and [02-coverage.md](02-coverage.md)
("Top three worth an experiment", item 1).

**Emulator version used: 1.0.322** (release date 2026.11.10, commit `7753983c6e495ec3612695b1336bf4936fc7b7fd`),
`aws-emulator_1.0.322-1_amd64.deb`. `EMULATOR_VERSION=latest` also resolved to 1.0.322 on 2026-11-12.
SDKs: `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` 3.1009.0 (what `packages/storage-s3` resolves),
`@aws-sdk/client-ssm` 3.1045.0 (what `admin-installer` and `app-client` resolve). Node 24.22.3.

## Findings

1. **Every adapter method and every SSM reader works against the emulator unchanged.** 53 S3 rows and 23 SSM
   rows, 0 failures. The adapter's `S3Client` is built from `region` alone and picked up
   `AWS_ENDPOINT_URL=https://127.0.0.1:9297` and the emulator's credentials file from the environment; with
   an IP endpoint the SDK chose path-style addressing on its own. **No seam is needed** in `packages/storage-s3`,
   `admin-installer` or `app-client` (see [Seams](#seams)).
2. **Presigned GET, PUT and UploadPart URLs are accepted**, including a PUT that signs
   `x-amz-checksum-sha256`, `x-amz-storage-class` and `x-amz-tagging` as headers, and the signed values land
   on the object (checksum, storage class, tags read back). The emulator also **refuses** what the signature
   forbids: a body that does not match the signed checksum (400 `BadDigest`, PUT and UploadPart), a signed
   header dropped or changed (403 `SignatureDoesNotMatch`), an expired URL (403 `AccessDenied: Request has expired`).
3. **One presigning fidelity gap matters to us: the emulator accepts headers that are present but not signed.**
   Presigned the way `adapter.ts` warns against (`signableHeaders` without `unhoistableHeaders`, so
   `SignedHeaders=host` and the values hoisted into the query) and then sent with the values as headers, the
   PUT gets **HTTP 200** from the emulator; per the comment in `packages/storage-s3/src/adapter.ts`, S3 answers
   403 `AccessDenied: There were headers present in the request which were not signed`. An emulator job
   would **not** catch a regression of that bug; `__tests__/presign-signed-headers.test.ts` (offline URL
   shape check) remains the guard.
4. **SSM error classes satisfy our `instanceof` branches.** Every swallow-on-`ParameterNotFound` and
   `ParameterAlreadyExists` branch in `app-creds.ts`, `pulumi-passphrase.ts` and `credentials.ts` took the
   intended path (`ensureAppCredsParameter` → `false`, `onlyIfAbsent` → `false`, missing →
   `null`, second `ensurePulumiPassphrase` → `already-exists`, `loadAppCredentials` for a missing parameter
   → `null`, not a throw). The `ParameterAlreadyExists` message is AWS's exact sentence, so cause 1 of
   [G-ssm-err] does not reproduce in 1.0.322.
5. **S3 checksums match AWS for our paths.** `stat()` reports the whole-object SHA-256 for `put`, both
   `putStream` paths (including the SDK's trailing-checksum streaming upload), and presigned PUTs; the
   multipart object reports the composite `<base64>-2` that `compositeSha256Checksum` from
   `@starkeep/storage-adapter` computes. UploadPart echoes `x-amz-checksum-sha256` ([G-s3-crc64] is about
   CRC64NVME only, which we do not use).
6. **`CompleteMultipartUpload` returns `Location` on the real AWS host** (`https://<bucket>.s3.us-east-1.amazonaws.com/<key>`,
   [G-s3-urls]). Harmless here: `completeMultipartUpload` discards the response.
7. **`packages/storage-s3`'s vitest suite cannot be pointed at the emulator by environment.** It passes 20/20
   with the emulator's environment and 20/20 with an endpoint where nothing listens: no test reaches S3.
   `whole-object-checksum.test.ts` and `multipart-upload.test.ts` replace the adapter's private `client`
   with a `{ send }` stub; `presign-signed-headers.test.ts` only presigns (no network); `adapter.test.ts`
   only constructs and calls `init`/`close`. See [What a real-S3 test would need](#what-a-real-s3-test-would-need).
8. **Fast.** All 76 calls take about 2 s in total; the drivers take 3.6 s (S3, including a deliberate 2.1 s
   wait for URL expiry) and 1.8 s (SSM, under `tsx`). The run is dominated by the 163 MiB download.

## Verdict

**Yes, with gaps.** A CI job running this code on the emulator is worth the 163 MiB download: today nothing in
CI sends a real request through `S3ObjectStorageAdapter` or the SSM readers (the storage-s3 suite is entirely
stubbed), and the emulator exercised every method end to end, enforced signed headers, checksums and expiry
on presigned URLs, kept storage class, tags and composite checksums, and raised SSM errors our `instanceof`
branches recognise. On GitHub Actions the download is under half a second and install plus start about 15 s
([01-runtime.md](01-runtime.md)), so the job would cost well under a minute on top of a workspace install.
The gaps it would not cover: unsigned-but-present headers on presigned URLs are accepted (finding 3, so the
existing offline test must stay), IAM scoping is not enforced (out of scope), and response URLs name real AWS
hosts. It should be an opt-in or non-required job pinned to an emulator version, since the emulator releases
several times a day.

## Per-operation results

Sandbox run of `bash spikes/aws-emulator/s3-ssm/run.sh`, 2026-11-12, emulator 1.0.322. Outcome: **ok** = the call
succeeded and matched what AWS does (for a refusal row: the emulator refused, as AWS does); **differs** = the
call succeeded but the behaviour differs from AWS; **failed** = the call threw where AWS succeeds, or the driver aborted (none). `ms` is the call's wall
time in the driver. The bucket name and stack prefix are random per run (shown as `<bucket>` / `<prefix>`); the
HMAC secret is printed only as its shape. Rows marked "(spike client)" or "control" use the spike's own SDK
client, never in place of an adapter method; every other row is the adapter or reader itself.

`put` takes no tags or storage class (`PutOptions` has `contentType`, `metadata` and `checksumSha256` only), so
tags and storage class were exercised through `setTags`, `getSignedPutUrl` and `createMultipartUpload`, and the
`DEEP_ARCHIVE` object that `restoreObject` needs came from a presigned PUT, the path a device uses.

### S3: `S3ObjectStorageAdapter` (plain node, built `dist`)

| #   | Operation                                                                  | Outcome     | ms  | Result or exact emulator error                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------- | ----------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | setup: CreateBucket (spike client)                                         | ok          | 145 | `<bucket>`                                                                                                                                                                                                 |
| 2   | init                                                                       | ok          | 0   |                                                                                                                                                                                                            |
| 3   | healthCheck                                                                | ok          | 82  | `true`                                                                                                                                                                                                     |
| 4   | healthCheck (bucket does not exist)                                        | ok          | 48  | `false`                                                                                                                                                                                                    |
| 5   | put (contentType, metadata, checksumSha256 set)                            | ok          | 15  |                                                                                                                                                                                                            |
| 6   | put (no checksum: adapter computes SHA-256)                                | ok          | 9   |                                                                                                                                                                                                            |
| 7   | put (checksumSha256 does not match body)                                   | ok          | 13  | `refused: BadDigest: The SHA256 you specified did not match the calculated checksum.; HTTP 400`                                                                                                            |
| 8   | putStream (sizeBytes + expectedSha256Hex)                                  | ok          | 11  |                                                                                                                                                                                                            |
| 9   | putStream (sizeBytes, no hash: SDK trailing SHA-256)                       | ok          | 7   |                                                                                                                                                                                                            |
| 10  | putStream (unknown length: spool, then put)                                | ok          | 11  |                                                                                                                                                                                                            |
| 11  | putStream (sizeBytes + wrong expectedSha256Hex)                            | ok          | 4   | `refused: BadDigest: The SHA256 you specified did not match the calculated checksum.; HTTP 400`                                                                                                            |
| 12  | get                                                                        | ok          | 5   | `{"data":"<65536 bytes>","contentType":"application/octet-stream","size":65536}`                                                                                                                           |
| 13  | get (missing key)                                                          | ok          | 2   | `null`                                                                                                                                                                                                     |
| 14  | getStream (range bytes=10-19)                                              | ok          | 23  | `"<10 bytes>"`                                                                                                                                                                                             |
| 15  | getStream (open-ended range bytes=65530-)                                  | ok          | 3   | `"<6 bytes>"`                                                                                                                                                                                              |
| 16  | getStream (whole object, streamed upload)                                  | ok          | 7   | `"<204800 bytes>"`                                                                                                                                                                                         |
| 17  | has                                                                        | ok          | 3   | `true`                                                                                                                                                                                                     |
| 18  | has (missing key)                                                          | ok          | 2   | `false`                                                                                                                                                                                                    |
| 19  | stat (put object)                                                          | ok          | 2   | `{"sizeBytes":65536,"checksumSha256":"G2hOjV9hmgtES062ch+PEX/peH1aieUAw399f6pCAK4=","storageClass":"STANDARD","availability":{"state":"instant"},"contentType":"application/octet-stream","metadata":{...` |
| 20  | stat (stream-trailer.bin: whole-object checksum stored)                    | ok          | 2   | `{"sizeBytes":204800,"checksumSha256":"fNjv5sNAW7lb61CkQ/Rde3TcII4LEP9RqoJmksjcNK4=","storageClass":"STANDARD","availability":{"state":"instant"},"contentType":"application/octet-stream","metadata":{}}` |
| 21  | stat (stream-spooled.bin: whole-object checksum stored)                    | ok          | 2   | `{"sizeBytes":204800,"checksumSha256":"fNjv5sNAW7lb61CkQ/Rde3TcII4LEP9RqoJmksjcNK4=","storageClass":"STANDARD","availability":{"state":"instant"},"contentType":"application/octet-stream","metadata":{}}` |
| 22  | stat (missing key)                                                         | ok          | 2   | `null`                                                                                                                                                                                                     |
| 23  | setTags (+ GetObjectTagging read-back)                                     | ok          | 7   | `{"starkeep:intent":"keep","app":"spike"}`                                                                                                                                                                 |
| 24  | list (prefix list/, limit 2)                                               | ok          | 4   | `{"keys":["list/item-1.txt","list/item-2.txt"],"nextCursor":"73337631207370696b652d7072656669782f6c6973742f6974656d2d332e747874","hasMore":true}`                                                          |
| 25  | list (page 2 via cursor)                                                   | ok          | 2   | `{"keys":["list/item-3.txt"],"nextCursor":null,"hasMore":false}`                                                                                                                                           |
| 26  | delete (+ has afterwards)                                                  | ok          | 3   | `false`                                                                                                                                                                                                    |
| 27  | delete (missing key: S3 answers 204)                                       | ok          | 1   |                                                                                                                                                                                                            |
| 28  | getSignedUrl                                                               | ok          | 2   | `https://127.0.0.1:9297/<bucket>/spike-prefix/objects/put.bin SignedHeaders=host`                                                                                                                          |
| 29  | presigned GET (fetch)                                                      | ok          | 53  | `HTTP 200`                                                                                                                                                                                                 |
| 30  | presigned GET, expired (expiresIn 1, fetched after 2 s)                    | ok          | 2   | `HTTP 403 AccessDenied: Request has expired`                                                                                                                                                               |
| 31  | getSignedPutUrl (checksum, storage class, tagging)                         | ok          | 1   | `https://127.0.0.1:9297/<bucket>/spike-prefix/objects/signed-put.bin SignedHeaders=host;x-amz-checksum-sha256;x-amz-storage-class;x-amz-tagging`                                                           |
| 32  | presigned PUT (fetch with the signed headers)                              | ok          | 45  | `HTTP 200, x-amz-checksum-sha256 echoed`                                                                                                                                                                   |
| 33  | presigned PUT read-back (get + stat + tags)                                | ok          | 8   | `{"got":{"data":"<32768 bytes>","contentType":"image/jpeg","size":32768},"facts":{"sizeBytes":32768,"checksumSha256":"tLPV5Hu2iCekznIwnnHYOy7bWgQscheJeg1BKSO6SgQ=","storageClass":"INTELLIGENT_TIERIN...` |
| 34  | presigned PUT, body does not match signed checksum                         | ok          | 6   | `HTTP 400 BadDigest: The SHA256 you specified did not match the calculated checksum.`                                                                                                                      |
| 35  | presigned PUT, signed x-amz-storage-class header dropped                   | ok          | 2   | `HTTP 403 SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check your key and signing method.`                                                        |
| 36  | presigned PUT, x-amz-storage-class changed from the signed value           | ok          | 2   | `HTTP 403 SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check your key and signing method.`                                                        |
| 37  | control: presigned PUT with headers hoisted (the bug adapter.ts documents) | **differs** | 2   | `HTTP 200; AWS refuses with 403 AccessDenied (headers present which were not signed)`                                                                                                                      |
| 38  | presigned PUT (storage class DEEP_ARCHIVE)                                 | ok          | 2   | `HTTP 200, x-amz-checksum-sha256 echoed`                                                                                                                                                                   |
| 39  | stat (DEEP_ARCHIVE object)                                                 | ok          | 2   | `{"sizeBytes":32768,"checksumSha256":"tLPV5Hu2iCekznIwnnHYOy7bWgQscheJeg1BKSO6SgQ=","storageClass":"DEEP_ARCHIVE","availability":{"state":"archived","tier":"DEEP_ARCHIVE","expectedLatencyHours":12},...` |
| 40  | get (DEEP_ARCHIVE object, not restored)                                    | ok          | 2   | `null`                                                                                                                                                                                                     |
| 41  | restoreObject (Standard, 1 day)                                            | ok          | 3   | `started`                                                                                                                                                                                                  |
| 42  | restoreObject (again, while in progress)                                   | ok          | 3   | `already-in-progress`                                                                                                                                                                                      |
| 43  | stat (DEEP_ARCHIVE object after restore request)                           | ok          | 2   | `{"sizeBytes":32768,"checksumSha256":"tLPV5Hu2iCekznIwnnHYOy7bWgQscheJeg1BKSO6SgQ=","storageClass":"DEEP_ARCHIVE","availability":{"state":"restoring","readyAt":null},"contentType":"image/jpeg","meta...` |
| 44  | restoreObject (STANDARD object)                                            | ok          | 3   | `refused: InvalidObjectState: Restore is not allowed for the object's current storage class; HTTP 403`                                                                                                     |
| 45  | createMultipartUpload (contentType, storage class, tagging)                | ok          | 3   | `upload id returned`                                                                                                                                                                                       |
| 46  | getSignedUploadPartUrl (part 1)                                            | ok          | 12  | `https://127.0.0.1:9297/<bucket>/spike-prefix/objects/multipart.bin SignedHeaders=host;x-amz-checksum-sha256`                                                                                              |
| 47  | presigned UploadPart (part 1, 5242880 B, fetch)                            | ok          | 118 | `HTTP 200, ETag present, x-amz-checksum-sha256 echoed`                                                                                                                                                     |
| 48  | getSignedUploadPartUrl (part 2)                                            | ok          | 1   | `https://127.0.0.1:9297/<bucket>/spike-prefix/objects/multipart.bin SignedHeaders=host;x-amz-checksum-sha256`                                                                                              |
| 49  | presigned UploadPart (part 2, 1024 B, fetch)                               | ok          | 2   | `HTTP 200, ETag present, x-amz-checksum-sha256 echoed`                                                                                                                                                     |
| 50  | presigned UploadPart, body does not match signed checksum                  | ok          | 2   | `HTTP 400 BadDigest: The SHA256 you specified did not match the calculated checksum.`                                                                                                                      |
| 51  | completeMultipartUpload                                                    | **differs** | 55  | `response Location is https://<bucket>.s3.us-east-1.amazonaws.com/spike-prefix/objects/multipart.bin (real AWS host, not the emulator)`                                                                    |
| 52  | multipart read-back (stat composite checksum + get + tags)                 | ok          | 43  | `{"facts":{"sizeBytes":5243904,"checksumSha256":"rTLrQk1YsQUg1zHlv8xq18kSaGv1TeE03HoxlGUl16M=-2","storageClass":"INTELLIGENT_TIERING","availability":{"state":"instant"},"contentType":"video/mp4","me...` |
| 53  | close                                                                      | ok          | 0   |                                                                                                                                                                                                            |

### SSM: `app-creds.ts`, `pulumi-passphrase.ts` (tsx), `loadAppCredentials`

| #   | Operation                                                          | Outcome | ms  | Result or exact emulator error                                                                                                                                                  |
| --- | ------------------------------------------------------------------ | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ensureAppCredsParameter (new)                                      | ok      | 72  | `true`                                                                                                                                                                          |
| 2   | ensureAppCredsParameter (exists: ParameterAlreadyExists branch)    | ok      | 46  | `false`                                                                                                                                                                         |
| 3   | read-back: type and tags of the app-creds parameter (spike client) | ok      | 59  | `{"type":"SecureString","plaintextWithoutDecryption":false,"tags":{"starkeep:appId":"spike-photos","starkeep:managed":"true"}}`                                                 |
| 4   | getAppCredsParameter                                               | ok      | 47  | `{"appId":"spike-photos","hmacSecret":"<64 hex chars>"}`                                                                                                                        |
| 5   | getAppCredsParameter (missing: ParameterNotFound branch)           | ok      | 51  | `null`                                                                                                                                                                          |
| 6   | loadAppCredentials (cloud mode, parameter present)                 | ok      | 62  | `{"appId":"spike-photos","hmacSecret":"<64 hex chars>","dataServerUrl":"https://cloud.spike.invalid/apps/spike-photos"}`                                                        |
| 7   | loadAppCredentials (cloud mode, parameter missing: must be null)   | ok      | 67  | `null`                                                                                                                                                                          |
| 8   | deleteAppCredsParameter                                            | ok      | 54  |                                                                                                                                                                                 |
| 9   | getAppCredsParameter (after delete)                                | ok      | 56  | `null`                                                                                                                                                                          |
| 10  | deleteAppCredsParameter (missing: ParameterNotFound swallowed)     | ok      | 56  |                                                                                                                                                                                 |
| 11  | getDeploymentSettingsParameter (absent)                            | ok      | 57  | `null`                                                                                                                                                                          |
| 12  | putDeploymentSettingsParameter (onlyIfAbsent, absent)              | ok      | 54  | `true`                                                                                                                                                                          |
| 13  | putDeploymentSettingsParameter (onlyIfAbsent, present)             | ok      | 55  | `false`                                                                                                                                                                         |
| 14  | getDeploymentSettingsParameter (present)                           | ok      | 54  | `{"trash":{"retentionDays":30}}`                                                                                                                                                |
| 15  | changeDeploymentSettingsParameter                                  | ok      | 163 | `{"change":{"ok":true,"settings":{"trash":{"retentionDays":14}}},"after":{"trash":{"retentionDays":14}}}`                                                                       |
| 16  | putCloudFrontSigningParameter (create with tags)                   | ok      | 63  | `{"name":"/<prefix>/app-creds/_cloudfront-signing","stored":{"type":"SecureString","domain":"a.spike.invalid"}}`                                                                |
| 17  | putCloudFrontSigningParameter (exists: overwrite branch)           | ok      | 66  | `{"name":"/<prefix>/app-creds/_cloudfront-signing","stored":{"type":"SecureString","domain":"b.spike.invalid"}}`                                                                |
| 18  | ensurePulumiPassphrase (first)                                     | ok      | 55  | `created`                                                                                                                                                                       |
| 19  | ensurePulumiPassphrase (second)                                    | ok      | 45  | `already-exists`                                                                                                                                                                |
| 20  | error class: GetParameter on a missing name                        | ok      | 3   | `ParameterNotFound: UnknownError; HTTP 400 (instanceof ParameterNotFound)`                                                                                                      |
| 21  | error class: DeleteParameter on a missing name                     | ok      | 2   | `ParameterNotFound: UnknownError; HTTP 400 (instanceof ParameterNotFound)`                                                                                                      |
| 22  | error class: PutParameter without Overwrite on an existing name    | ok      | 2   | `ParameterAlreadyExists: The parameter already exists. To overwrite this value, set the overwrite option in the request to true.; HTTP 400 (instanceof ParameterAlreadyExists)` |
| 23  | PutParameter with Tags and Overwrite together                      | ok      | 2   | `ValidationException: Tags and Overwrite can't be used together; use AddTagsToResource to tag an existing parameter; HTTP 400`                                                  |

The S3 driver's stderr has one line, `An error was encountered in a non-retryable streaming request.`: the SDK's
retry middleware logs it for any failed request with a streaming body, here the deliberate `BadDigest` refusal in
S3 row 11. It would appear against AWS too.

## Fidelity notes

**Presigned URL acceptance.** GET (`SignedHeaders=host`), PUT (`host;x-amz-checksum-sha256;x-amz-storage-class;x-amz-tagging`)
and UploadPart (`host;x-amz-checksum-sha256`) were all accepted when fetched with Node `fetch`
(`NODE_EXTRA_CA_CERTS` set to the emulator's CA) sending exactly the signed headers. Refusals match AWS's class and
status: wrong body 400 `BadDigest` (`The SHA256 you specified did not match the calculated checksum.`), dropped or
altered signed header 403 `SignatureDoesNotMatch`, expired 403 `AccessDenied` `Request has expired`. The gap is
the hoisted-header case (finding 3): the emulator does not reject `x-amz-*` request headers outside `SignedHeaders`.

**`CompleteMultipartUpload` `Location`.** `https://<bucket>.s3.us-east-1.amazonaws.com/spike-prefix/objects/multipart.bin`,
a host the emulator does not serve ([G-s3-urls], cause 2). Observed with a pass-through middleware the spike adds
to the adapter's own client after `healthCheck` creates it; the adapter returns `void` and never reads it.

**UploadPart checksum header.** Each presigned part PUT returned `ETag` and `x-amz-checksum-sha256` equal to the
part's SHA-256. A 5 MiB first part and a 1 KiB last part completed; the stored checksum is
`base64(sha256(digest1 || digest2))-2`, equal to `compositeSha256Checksum`. Not tried: `EntityTooSmall` for a
non-final part under 5 MiB, and part sizes of 16 MiB (`MULTIPART_PART_BYTES`).

**SSM error classes.** Raised through each package's own `@aws-sdk/client-ssm` copy, so the readers'
`instanceof` checks compare against the class that client deserialises into. The spike also caught them with its
own copy to record the wire form:

| Case                                                | Emulator                                                                                                                              | Matches AWS?                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GetParameter`, missing name                        | 400 `ParameterNotFound`, no message (SDK shows `UnknownError`); `instanceof ParameterNotFound`                                        | Class and status yes. No message is not among the 10 causes of [G-ssm-err], whose AWS-recorded corpus includes a missing-parameter error matrix; not compared to AWS by this spike. |
| `DeleteParameter`, missing name                     | same as above                                                                                                                         | same                                                                                                                                                                                |
| `PutParameter` without `Overwrite`, existing name   | 400 `ParameterAlreadyExists: The parameter already exists. To overwrite this value, set the overwrite option in the request to true.` | Yes, verbatim the AWS sentence [G-ssm-err] quotes (its cause 1 no longer reproduces).                                                                                               |
| `PutParameter` with `Tags` and `Overwrite` together | 400 `ValidationException: Tags and Overwrite can't be used together; use AddTagsToResource to tag an existing parameter`              | Class and status as `putCloudFrontSigningParameter` expects; the wording is the emulator's and was not compared to AWS. Our code does not match on it.                              |

SecureString: the app-creds parameter reads back as `Type: SecureString` with tags `starkeep:appId` and
`starkeep:managed`, and `GetParameter` without `WithDecryption` does not return the plaintext JSON.

**Archive tier and restore.** A presigned PUT with `x-amz-storage-class: DEEP_ARCHIVE` is stored as
`DEEP_ARCHIVE`; `stat` reports `archived` (12 h); `get` returns `null` (the adapter maps 403 and 404 to `null`, so
this is consistent with AWS's 403 `InvalidObjectState` but the spike cannot tell which status the emulator sent);
`restoreObject` returns `started`, then `already-in-progress` (the `RestoreAlreadyInProgress` name branch), and
`stat` moves to `restoring`. Restoring a `STANDARD` object is refused with 403 `InvalidObjectState`, as on AWS.
Not tried: whether the emulator ever completes a restore (`ongoing-request="false"`).

**Plain `DeleteObject` of a missing key** succeeded (2xx), so cause 2 of [G-s3-del] (object-lock teardown
deletes answering 404) did not affect our unversioned case.

## Timings

| Step                                                 | Sandbox (Debian 12 container, x86_64, no root), 2026-11-12                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Whole `run.sh`                                       | 37.6 s (49.2 s and 33.1 s on other runs; the spread is download speed)                     |
| Emulator install (download + `gpgv` + `dpkg-deb -x`) | 25.7 s (20.6 to 37.3 s across five runs; 7.6 s in AI-679)                                  |
| Emulator startup to health `ok`                      | 0.25 s                                                                                     |
| Build of storage-s3 + protocol-primitives (turbo)    | 0.44 s cached; 22.9 s cold (`--force`, 3 tasks)                                            |
| S3 driver (node process start to exit)               | 3.62 s, of which 2.1 s is the deliberate wait for URL expiry; 791 ms in calls              |
| SSM driver (tsx process start to exit)               | 1.82 s; 1191 ms in calls (about 45 to 60 ms per SSM call, each reader builds a new client) |
| storage-s3 vitest, twice                             | a few seconds each                                                                         |

Per-call times are in the table above. The first S3 call (`CreateBucket`, about 100 ms) and the first adapter call
(`healthCheck`, about 90 ms) include the TLS handshake and credential load; most S3 calls after that take 2 to 10 ms.
Not measured: the same run on GitHub Actions (no workflow is added by this issue; see below).

## Gaps found

1. Presigned requests carrying `x-amz-*` headers that are not in `SignedHeaders` are accepted (AWS: 403
   `AccessDenied`). Hides the hoisting bug documented in `adapter.ts`. No file name under
   `issues/things-that-do-not-work/` at v1.0.322 mentions it (searched by name; GitHub truncated the tree listing,
   so not exhaustive); worth reporting upstream.
2. `CompleteMultipartUpload` `Location` names the real AWS host ([G-s3-urls]). No effect on our code.
3. SSM `ValidationException` wording for `Tags` + `Overwrite` is emulator-authored (unverified against AWS); class and
   status are right.
4. Not exercised: restore completion, `EntityTooSmall`, 16 MiB parts, `ListObjectsV2` with a delimiter
   ([G-s3-list]), IAM scoping (out of scope; not enforced by the emulator).

## Seams

None needed. The adapter, the readers and `loadAppCredentials` reached the emulator with no code change because
none of them sets `endpoint`, and the SDK reads `AWS_ENDPOINT_URL` when the client resolves its config. Keep the
endpoint `https://127.0.0.1:<port>`: with `localhost` the SDK uses virtual-hosted addressing and fails TLS
([01-runtime.md](01-runtime.md), finding 5), and the adapter has no `forcePathStyle` option. An `endpoint` /
`forcePathStyle` adapter option is therefore not proposed; it would only be needed to run against a hostname
endpoint, which nothing here requires.

## What a real-S3 test would need

The storage-s3 suite as written can never reach S3 (finding 7), and this issue does not change it. A test that
does would need:

- an emulator process for the test run: a vitest `globalSetup` (or a CI step before vitest) that installs, starts
  and stops it, as `run.sh` does;
- `NODE_EXTRA_CA_CERTS` set in the environment that **starts** vitest (Node reads it only at process start), plus
  `AWS_ENDPOINT_URL`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE` and `AWS_REGION`, with every other AWS
  credential variable unset, and a guard that refuses any endpoint other than `https://127.0.0.1:<port>`;
- a bucket created per test file (the adapter has no create-bucket method);
- adapters constructed without `credentials` and without replacing `client`, i.e. new test files, separate from
  the stubbed ones, in their own vitest project so `pnpm test` stays offline.

## What this means for starkeep-core

- The S3 adapter and the SSM credential paths can be tested against the emulator **as they are**; the rows above
  are the test list.
- The highest-value checks an emulator job adds are end-to-end: presigned PUT/UploadPart with signed checksum,
  storage class and tags; checksum and signature refusals; whole-object and composite SHA-256 in `stat`; the SSM
  create-only and not-found branches. None is covered by a real request in CI today.
- It does not replace `presign-signed-headers.test.ts` (gap 1) and says nothing about IAM boundaries.
- For the epic's synthesis: presigned GET/PUT/UploadPart accepted; SSM `instanceof ParameterNotFound` /
  `ParameterAlreadyExists` work; full run about 35 to 50 s in the sandbox, about 6 s of it actual test work;
  no seam proposed.

## Reproduce

```bash
pnpm install                                    # root workspace, once
bash spikes/aws-emulator/s3-ssm/run.sh          # EMULATOR_VERSION=latest to try the newest build
```

In a git worktree whose main checkout is not writable (the agent sandbox), turbo cannot create its shared cache:
export `TURBO_CACHE_DIR=$PWD/.turbo/cache` first.

[G-ssm-err]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261103T173026Z-ssm-parameter-store-error-classes-and-messages-are-emulator.md
[G-s3-del]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261031T220739Z-s3-successful-deletes-answer-a-4xx-error-instead.md
[G-s3-list]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261102T111455Z-s3-listings-percent-encode-the-key-delimiter-under.md
[G-s3-crc64]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T072224Z-s3-uploadpart-does-not-return-x-amz-checksum.md
[G-s3-urls]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261110T134656Z-s3-publishes-response-urls-on-the-real-aws.md
