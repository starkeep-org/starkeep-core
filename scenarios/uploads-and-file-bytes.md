# Uploads and file bytes

This file specifies how file bytes move between a member's devices and the cloud. A member sees new files reach the cloud and the member's other devices in a useful order, keeps uploading through failures, outages, and restarts, and gets large videos to the cloud. A local operator frees space on a computer only once the cloud's copy of a large video is proved. An app developer uploads files through the platform's upload routes, uploads the app's private files, puts back a file the cloud lost, and learns from the cloud when a file is still awaiting upload. A cloud operator reads the cloud's upload log. The upload queue, its order, its retries, and the cloud's record of which files it holds have no scenarios of their own. Each one appears only through what a user observes.

Related files:

- [sync.md](sync.md): records and rows reaching other devices, files listed before their bytes download, a phone's video shown while its original uploads, failed downloads, and "Check sync integrity", including the count of files still to upload.
- [residency-and-stand-ins.md](residency-and-stand-ins.md): which file bytes each device keeps, stand-ins, raising a ceiling, "Keep originals here", and "Free up space".
- [shared-data.md](shared-data.md): registering a record after its upload, duplicates, file URLs, the batch answer that names files awaiting upload, public links to files not uploaded yet, and damaged or truncated downloads.
- [users-and-access.md](users-and-access.md): which categories an app may upload, keys under another member, and a device writing the platform's own files.
- [app-data.md](app-data.md): listing, deleting, and confining an app's private files.
- [cloud-runtime.md](cloud-runtime.md): the cloud's logs, load, and limits in general.

## Upload order

Photos makes previews of each photo and video: stand-ins at 320, 640, 1280, and 2560 pixels, and poster frames for videos. A preview of at most 1 MiB uploads ahead of every original, so the member's other devices can show a new photo before its original arrives.

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-001] A member's other device shows the previews of newly added photos before their originals finish uploading
  Given a member's computer and phone are signed in and online
  When the member adds 20 photos of several megabytes each with Photos on the computer
  Then Photos on the phone shows the previews of all 20 photos while their originals are still uploading from the computer
```

- **Notes:** The same order applies to a phone's uploads, so the computer shows a phone's new photos first through their previews. A canonical stand-in larger than 1 MiB uploads in the originals' turn.

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-002] A member's new photo's previews upload ahead of a backlog of originals still waiting
  Given a member's computer and phone are signed in and online
  And the computer is still uploading the originals of 500 earlier photos
  When the member adds one more photo with Photos on the computer
  Then Photos on the member's phone shows the new photo's preview while the earlier originals are still uploading
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-003] A member sees the newest photos' previews arrive first in Photos in the cloud
  Given a member's computer holds 300 photos whose previews have not reached the cloud yet
  When the member opens Photos in the cloud while the computer uploads
  Then the member sees the previews of the most recently added photos appear before the previews of older photos
```

```gherkin
@local @mobile
@intent:unclear
Scenario: [BYTES-004] A member's originals reach the cloud oldest first
  Given a member's computer holds the originals of 300 photos that have not reached the cloud yet, and their previews have all uploaded
  When the member opens the photos at full size in Photos in the cloud while the computer uploads
  Then the member finds the originals of the oldest photos available first
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-005] A member's library already on the computer reaches the cloud after the first sign-in without the member doing anything
  Given a member's computer holds 5,000 photos and documents that were added before the computer was ever signed in
  When the member signs the computer in and leaves it running
  Then Drive in the cloud eventually lists every one of the files
  And each file opens in Drive in the cloud
```

- **Notes:** The computer reads its library in pages of 1,000 files, so a large library starts uploading at once rather than after a full scan.

## Uploads that fail or stop

A file stays owed until the cloud holds it. A failure, a skip, or an interruption never drops a file from the upload queue. Only the file's deletion, or the cloud holding the file already, takes it off.

```gherkin
@local
@intent:confirmed
Scenario: [BYTES-006] A member sees a new document on the other computer while its upload keeps failing, and the document opens there once uploads work
  Given a member's two computers are signed in and online
  And the cloud refuses every upload from the first computer for a while
  When the member adds a document on the first computer
  Then Drive on the second computer lists the document while its upload is still failing
  And the document opens on the second computer once the first computer's uploads work again
```

- **Notes:** [sync.md](sync.md) SYNC-013 owns the same outcome while an upload is merely slow.

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-007] A member's other files keep uploading while one file's upload keeps failing
  Given a member's computer is uploading 50 new documents
  And the cloud rejects every upload of one of the documents
  When the member opens Drive in the cloud
  Then the member opens the other 49 documents in Drive in the cloud
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-008] A member's failed upload is tried again automatically, never more than 30 minutes after the last try
  Given a member's computer has just failed to upload a document for the fourth time in a row
  And the cause of the failure has since gone away
  When the member leaves the computer running
  Then the document opens in Drive in the cloud within 35 minutes of the fourth failure
```

- **Notes:** The waits after the first, second, third, and later failures are 30 seconds, 2 minutes, 10 minutes, and 30 minutes.

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-009] A member's uploads resume within a minute after the network returns, however long the outage lasted
  Given a member's computer lost its network connection for six hours while documents waited to upload
  And the connection has just come back
  When the member opens Drive in the cloud
  Then the member sees the waiting documents start to arrive within a minute
```

- **Notes:** An outage pauses the uploads for 30 seconds at a time and counts against no file, so an outage never pushes a file to the 30-minute wait. A phone resumes at once when it notices the connection change.

```gherkin
@local
@intent:confirmed
Scenario: [BYTES-010] A member's file that was missing from the computer when its turn came uploads once the file is back
  Given the bytes of a member's new document disappeared from the computer's data folder before the document uploaded
  When the member puts the bytes back into the data folder from a backup
  Then the document opens in Drive in the cloud within a few minutes
```

- **Notes:** The computer looks again for missing files once a minute. The same outcome holds when the bytes turn up after the computer first passed over the document.

```gherkin
@mobile
@intent:unclear
Scenario: [BYTES-011] A member whose phone lost a photo's original before uploading it learns that the original is gone
  Given a member took a photo with the phone, and Photos on the phone listed it
  And the member deleted the photo from the phone's camera roll before its original uploaded
  When the member opens the photo in Photos on the computer
  Then Photos on the computer shows that the photo's original is not available anywhere
  And Photos does not show the original as still uploading
```

- **Notes:** Implementation gap: the phone keeps the original in its upload queue as missing, and the member's other devices treat the original as still uploading for good.

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-012] A member's queued uploads finish after the computer restarts
  Given a member's computer was uploading 200 new documents
  And the computer restarted before the uploads finished
  When the member starts the data server again
  Then every one of the 200 documents opens in Drive in the cloud after the uploads finish
```

- **Notes:** The upload queue lives in the computer's database, so a restart resumes it rather than starting over.

```gherkin
@local @cloud
@intent:unclear
Scenario: [BYTES-013] A member whose cloud lost a file's bytes gets them put back from the device that holds them
  Given a member's photo had uploaded from the computer, and the computer still holds the photo's original
  And the cloud's storage later lost the original's bytes
  When the member leaves the computer running
  Then the photo's original opens in Photos in the cloud again after the computer's next sync
```

- **Notes:** Implementation gap: nothing on the computer notices a loss behind what the cloud already recorded as held. Only an app's explicit request, BYTES-044, puts the bytes back. A loss together with the cloud's records, such as SYNC-037 in [sync.md](sync.md), is put back automatically.

## Large files

A phone uploads a file larger than 64 MiB in parts of 16 MiB and keeps every finished part when an upload stops. A computer uploads every file whole.

```gherkin
@mobile
@intent:confirmed
Scenario: [BYTES-014] A member's long video finishes uploading from the phone even though no single background stretch is long enough
  Given a member recorded a 400 MB video with Photos on the phone
  And the phone uploads only during short stretches while Photos is in the background, each too short to send the whole video
  When the member leaves the phone alone for the evening
  Then the video opens in Drive in the cloud once enough stretches have passed
```

- **Notes:** When the phone uploads, and how its Settings show progress, belong to the Photos mobile files in starkeep-apps.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [BYTES-015] A cloud operator finds a large file's interrupted upload resumed, not restarted, in the cloud's logs
  Given a member's phone was uploading a 400 MB video in parts, and the upload stopped after four parts
  When the cloud operator reads the cloud data server's logs after the phone's next upload attempt
  Then the cloud operator finds the line "[multipart] presign <key>: upload <id> (resumed), parts 5,6,7,…", which names only the parts not yet sent
  And the cloud operator finds the line "[multipart] complete <key>: upload <id> assembled from <n> parts" once the video finishes
```

- **Notes:** `<key>`, `<id>`, and `<n>` stand for the video's storage key, the upload's id, and the number of 16 MiB parts.

```gherkin
@mobile
@intent:confirmed
Scenario: [BYTES-016] A member's large video still uploads after the cloud discarded the interrupted upload
  Given a member's phone stopped partway through uploading a 400 MB video
  And the phone then stayed off for more than seven days, so the cloud discarded the unfinished upload
  When the member uses the phone again
  Then the video opens in Drive in the cloud after the phone's next uploads
```

- **Notes:** The phone starts the upload over from the first part.

```gherkin
@local
@intent:unclear
Scenario: [BYTES-017] A member's video larger than 5 GB uploads from the computer
  Given a member's computer is signed in and online
  When the member adds a 6 GB video to a watched folder on the computer
  Then the video opens in Drive in the cloud after the upload finishes
```

- **Notes:** Implementation gap: a computer sends every file as one upload, and the cloud's storage refuses a single upload larger than 5 GB, so the video fails every retry. A computer's upload between 64 MiB and 5 GB also starts over from the beginning after an interruption.

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-018] A member's other devices never receive a file whose bytes on the uploading device no longer match it
  Given a member's computer recorded a document, and the document's bytes in the computer's data folder later changed before the document uploaded
  When the member opens the document in Drive in the cloud
  Then the document does not open with the changed bytes
```

- **Notes:** The cloud's storage checks every whole upload against the file's content hash and stores nothing that differs. [shared-data.md](shared-data.md) SHARED-182 owns the same guarantee for downloads.

```gherkin
@mobile
@intent:confirmed @suboptimal
Scenario: [BYTES-019] A member's other devices never receive a large video whose bytes on the phone no longer match it
  Given a member's phone recorded a 400 MB video, and the video's bytes on the phone later changed before the video uploaded
  When the member opens the video in Drive in the cloud
  Then the video does not open with the changed bytes
```

- **Suboptimal:** Only the phone checks a video uploaded in parts against its content hash before sending. The cloud checks each part, but nothing in the cloud checks the assembled video against its content hash, so an uploader with a hashing defect could store wrong bytes under the video's key until someone deletes them. An optional cloud check after each large upload would close the gap.
## Freeing space after a large upload

The cloud's storage cannot report a whole-file hash for a file uploaded in parts. Before "Free up space" lets such a file go, the computer hashes its own copy whole and in parts and compares the result with what the cloud's storage reports.

```gherkin
@local
@intent:confirmed
Scenario: [BYTES-021] A local operator frees space from a video that a phone uploaded in parts, once the computer proves the cloud's copy matches its own
  Given the local operator's computer holds the original of a 400 MB video that a member's phone uploaded in parts
  And the cloud holds the video's canonical stand-in and an intact copy of the original
  When the local operator frees space from originals on the Storage page
  Then the report counts the video among the files freed
  And the video's original opens on the computer again with a network connection
```

- **Notes:** [residency-and-stand-ins.md](residency-and-stand-ins.md) owns the general rules for what "Free up space" removes and keeps (RESIDENCY-030 to RESIDENCY-042). A computer uploads every file whole, so only a file a phone uploaded needs this proof.

```gherkin
@local
@intent:unclear
Scenario: [BYTES-022] A local operator keeps a video whose cloud copy does not match the computer's copy, and learns that the cloud's copy looks damaged
  Given the local operator's computer holds the original of a 400 MB video that a member's phone uploaded in parts
  And the cloud's copy of the original differs from the computer's copy
  When the local operator frees space from originals on the Storage page
  Then the video's original still opens on the computer with no network connection
  And the Storage page tells the local operator that the cloud's copy of the video looks damaged
```

- **Notes:** Implementation gap: the report says only "Kept 1 that the cloud could not yet be shown to hold.", the same words it uses for an upload that has not finished, and only the data server's log names the mismatch.

## Files awaiting upload, as an app sees them

A device sends a file's record ahead of the file's bytes, so the cloud can list a photo whose bytes are still on the member's phone. Before the cloud hands an app a link for such a file, it checks that its storage holds the bytes. The app developer is the actor in this section.

```gherkin
@cloud
@intent:confirmed
Scenario: [BYTES-024] An app's request for a link to a file still on the member's phone fails as awaiting upload
  Given a member's phone has sent a new photo's record to the cloud, and the photo's original is still on the phone
  When an app asks the cloud for a link to the photo's original
  Then the app's request fails as a conflict with the error "AwaitingUpload"
  And the answer's detail says "The device that wrote these bytes has not uploaded them yet."
```

- **Notes:** A read of the photo's content at a chosen size gets the same answer. The answer for a batch of links is SHARED-096 in [shared-data.md](shared-data.md), and the availability field in a listing is SHARED-130.

```gherkin
@cloud
@intent:confirmed
Scenario: [BYTES-025] An app sees which sizes of a photo still await upload, and gets links only for the sizes the cloud holds
  Given a member's phone has uploaded a photo's 640-pixel stand-in, and the photo's original is still on the phone
  When an app lists the photo in the cloud and asks for stand-in links
  Then the app receives a link for the 640-pixel stand-in, and the link loads the stand-in
  And the app receives the original's size marked as awaiting upload, with no link
```

```gherkin
@cloud
@intent:confirmed
Scenario: [BYTES-026] An app gets a working link for a file as soon as the file reaches the cloud, before the next sync
  Given a member's phone finished uploading a photo's original moments ago, and the phone has not synced since
  When an app asks the cloud for a link to the photo's original
  Then the app receives a link, and the link loads the original
```

```gherkin
@cloud
@intent:unclear
Scenario: [BYTES-027] An app that asks about more than 512 files awaiting upload at once gets unchecked links for the rest
  Given a member's phone has sent the records of 200 photos, each with four stand-ins, and the cloud has not yet seen most of their files arrive
  When an app lists the 200 photos in one request and asks for stand-in links
  Then the app receives a link for every size whose file the cloud did not check
  And a link for a file still on the phone fails to load until the file arrives
```

- **Notes:** The cloud checks at most 512 files per request, so a page of photos stays fast. Past that number the cloud hands out links as it did before it checked at all.

## Uploading through an app's own calls

An app puts a file's bytes into the member's library before it registers a record for them. The app developer is the actor in this section.

### Shared files

```gherkin
@local @cloud
@intent:confirmed
Scenario: [BYTES-028] An app uploads a file's bytes through a presigned link, naming only the type and the content hash
  Given an app holds a readwrite grant on image/jpeg
  When the app asks for an upload link naming the type image/jpeg and the photo's content hash, and sends the photo's bytes to the link with the checksum the answer names
  Then the upload succeeds
  And the app can then register a record for the photo by its content hash
```

- **Notes:** The app never needs to know which member's library it writes to. The cloud's answer also names the storage class and any tags, and the upload must carry them. Registering the record is SHARED-007 in [shared-data.md](shared-data.md). Which categories an app may upload is ACCESS-122 and ACCESS-123 in [users-and-access.md](users-and-access.md).

```gherkin
@local
@intent:confirmed
Scenario: [BYTES-029] An app's local upload of bytes that do not match the content hash is refused
  Given an app on a member's computer received an upload link for a photo's content hash
  When the app sends different bytes to the link
  Then the upload fails as a bad request with the error "Upload body hash does not match the key"
  And the answer names the expected hash and the hash of the bytes the app sent
```

```gherkin
@cloud
@intent:confirmed
Scenario: [BYTES-030] An app's cloud upload of bytes that do not match the content hash stores nothing
  Given a cloud app received an upload link for a photo's content hash
  When the app sends different bytes to the link
  Then the upload fails
  And the app's later registration of a record by that content hash fails because the bytes are missing
```

- **Notes:** The cloud's storage refuses the bytes itself, because the link carries the content hash. The registration's refusal is SHARED-008 in [shared-data.md](shared-data.md).

```gherkin
@local
@intent:confirmed
Scenario: [BYTES-031] An app's local upload link stops working after it expires
  Given an app on a member's computer asked for an upload link that lasts 60 seconds
  When the app sends the bytes to the link two minutes later
  Then the upload fails as forbidden with the error "Invalid or expired upload token"
```

- **Notes:** A link lasts one hour unless the app asks for another time. An altered link fails the same way.

```gherkin
@local
@intent:confirmed
Scenario Outline: [BYTES-032] An app's local presign request that names no file, a malformed content hash, or a key outside the shared files is refused
  Given an app on a member's computer holds a readwrite grant on image/jpeg
  When the app asks the computer for an upload link with <request>
  Then the app's request fails as a bad request with the error "<error>"

  Examples:
    | request                                        | error                                                                         |
    | neither a key nor a type and a content hash    | key, or type and contentHash, is required                                     |
    | the type and an uppercase content hash         | contentHash must be a 64-char lowercase hex sha256                            |
    | the key of one of the app's private files      | presign currently only supports shared/<userId>/<category>/<shard>/<hash> keys |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [BYTES-033] An app's cloud presign request that names no file, or whose content hash is malformed or disagrees with the key, is refused
  Given a cloud app holds a readwrite grant on image/jpeg
  When the app asks the cloud for an upload link with <request>
  Then the app's request fails as a bad request with the error "<error>"

  Examples:
    | request                                              | error                                               |
    | neither a key nor a type and a content hash          | key, or type and contentHash, is required           |
    | the type and an uppercase content hash               | contentHash must be a lowercase hex SHA-256         |
    | a photo's key and a content hash that names another file | contentHash disagrees with the hash <key> names |
```

- **Notes:** `<key>` stands for the storage key the request named.

```gherkin
@cloud
@intent:confirmed
Scenario: [BYTES-034] An app's cloud presign request with an unknown retrieval intent is refused
  Given a cloud app holds a readwrite grant on image/jpeg
  When the app asks for an upload link with the retrieval intent "archve"
  Then the app's request fails as a bad request with the error "intent must be one of instant, archive (got "archve")"
```

- **Notes:** The cloud refuses a misspelled intent rather than guessing, because a wrong guess either costs money quietly or puts the bytes behind a long thaw. What each intent does to the stored bytes belongs to [residency-and-stand-ins.md](residency-and-stand-ins.md).

### Small files in one request

```gherkin
@local @cloud
@intent:confirmed
Scenario: [BYTES-035] An app stores small bytes in one request and receives their key and content hash
  Given an app holds a readwrite grant on image/jpeg
  When the app sends a 200 kB thumbnail's bytes in one request, naming the type image/jpeg
  Then the app receives the storage key, the content hash, the content type, and the size of the bytes
  And the app can then register a record for the bytes by that content hash
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [BYTES-036] An app's one-request upload without a type, with an unknown type, or with no bytes is refused
  Given an app holds a readwrite grant on image/jpeg
  When the app sends a one-request upload with <request>
  Then the app's request fails as a bad request with the error "<error>"

  Examples:
    | request                         | error                            |
    | no type                         | type query param is required     |
    | the type "image/jpgg"           | Unknown type id: image/jpgg      |
    | the type image/jpeg and no bytes | Request body must not be empty  |
```

```gherkin
@local
@intent:unclear
Scenario: [BYTES-037] An app's one-request upload larger than 20 MB is refused
  Given an app on a member's computer holds a readwrite grant on video/mp4
  When the app sends 25 MB of bytes in one request, naming the type video/mp4
  Then the app's request fails as too large with the error "File too large (20 MB limit)"
```

- **Notes:** A larger file goes through a presigned link, BYTES-028. The computer's limit stands or falls with the cloud's limit in BYTES-038.

```gherkin
@cloud
@intent:unclear
Scenario: [BYTES-038] An app's one-request upload too large for the cloud is refused with a message that names the limit
  Given a cloud app holds a readwrite grant on image/jpeg
  When the app sends 10 MB of bytes in one request, naming the type image/jpeg
  Then the app's request fails as too large with an error that names the cloud's limit for one-request uploads
```

- **Notes:** Implementation gap: the cloud's route allows 20 MB, but the request reaches the route through a function whose request size limit is 6 MB, so a body above that limit fails with the hosting platform's own error before the route's check runs.

### An app's private files

```gherkin
@local @cloud
@intent:confirmed
Scenario: [BYTES-039] An app uploads a private file through a presigned link and registers it
  Given an app declares private files in its manifest
  When the app asks for an upload link for the sub-key "exports/notes-1.json" with the file's content hash, sends the bytes to the link, and registers the file with its content hash, type, and size
  Then the app reads the same bytes back through the file's link
```

- **Notes:** Listing, deleting, and confining an app's private files belong to [app-data.md](app-data.md) (APP-DATA-069 to APP-DATA-075).

```gherkin
@cloud
@intent:confirmed
Scenario: [BYTES-040] An app's cloud presign for a private file without a content hash is refused
  Given a cloud app declares private files in its manifest
  When the app asks for an upload link for the sub-key "exports/notes-1.json" without a content hash
  Then the app's request fails as a bad request with the error "contentHash (a lowercase hex SHA-256 of the bytes) is required"
```

```gherkin
@local
@intent:unclear
Scenario: [BYTES-041] An app's local private file whose bytes do not match the content hash is refused
  Given an app on a member's computer declares private files in its manifest
  And the app asked for an upload link for the sub-key "exports/notes-1.json" with a content hash
  When the app sends bytes that do not match the content hash
  Then the upload fails as a bad request, as it does in the cloud
```

- **Notes:** Implementation gap: the computer's upload link for a private file takes no content hash and checks none, so the computer stores the bytes. The file then never reaches the cloud, because the cloud's storage refuses bytes that do not match the hash the app registered.

```gherkin
@local
@intent:confirmed
Scenario: [BYTES-042] An app on another computer opens a private file that was registered before its bytes were uploaded, once the upload finishes
  Given an app runs on a member's two computers and declares private files
  And on the first computer the app registered a private file before uploading its bytes
  When the app on the first computer uploads the file's bytes through a presigned link
  Then the app on the second computer opens the file after the next sync
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [BYTES-043] An app's private-file registration without a content hash, type, or size is refused
  Given an app declares private files in its manifest
  When the app registers the sub-key "exports/notes-1.json" without a size
  Then the app's request fails as a bad request with the error "contentHash, mimeType, and sizeBytes are required"
```

### Putting back a file the cloud lost

```gherkin
@local
@intent:confirmed
Scenario: [BYTES-044] An app puts back a file the cloud lost, from the computer that holds it
  Given a member's computer holds a photo's original, and the cloud's storage lost the original's bytes
  And an app on the computer may read the photo
  When the app asks the computer to upload the photo's file again
  Then the app receives an answer that the file uploaded, naming the file's storage key
  And a link to the photo's original that an app receives from the cloud afterward loads the original
```

- **Notes:** A second request for a file the cloud already holds succeeds without sending the bytes again. No app calls this route today. Whether the computer should notice the loss on its own is BYTES-013.

```gherkin
@local
@intent:confirmed
Scenario Outline: [BYTES-045] An app's request to put back a file is refused when the computer cannot send it
  Given an app on a member's computer may read photos
  When the app asks the computer to upload again <record>
  Then the app's request fails as <failure> with the error "<error>" and the detail "<detail>"

  Examples:
    | record                                             | failure       | error        | detail                                                                                      |
    | a record that has no file                          | a conflict    | NoFile       | this record has no file to upload                                                           |
    | a photo whose bytes this computer does not hold    | a conflict    | NotHere      | this machine does not hold these bytes, so it has nothing to send; try the node that does   |
    | a photo, on a computer that has no cloud           | a conflict    | NoCloud      | no cloud is configured on this machine                                                      |
    | a photo whose upload fails                         | a bad gateway | UploadFailed | the upload did not complete; the log names the reason                                       |
```

- **Notes:** A record the app may not read, or that does not exist, answers not found with the error "Record not found".

## Files moving down to a device

```gherkin
@local
@intent:confirmed
Scenario: [BYTES-046] A member's newly wanted previews that failed to download arrive after a later sync
  Given the local operator raised the computer's photo ceiling to 2560 pixels on the Storage page
  And some of the 2560-pixel previews failed to download the first time the computer fetched them
  And the computer has synced again since, with a working network connection
  When the member opens those photos with no network connection
  Then every one of the photos shows at 2560 pixels
```

- **Notes:** [residency-and-stand-ins.md](residency-and-stand-ins.md) owns raising a ceiling (RESIDENCY-022, RESIDENCY-023), "Keep originals here" (RESIDENCY-025), and previews that went missing (RESIDENCY-028). The computer tries the failed downloads again after each sync.

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-047] A member's file larger than one sync's transfer allowance still arrives on the other computer
  Given a member's two computers are signed in and online
  When the member adds a 2 GB document on the first computer
  Then the document opens on the second computer once its download finishes
```

- **Notes:** Each sync moves a bounded number of bytes, and the oldest file still owed always goes, however large. [sync.md](sync.md) SYNC-012 owns the small previews that arrive meanwhile.

```gherkin
@local @mobile
@intent:confirmed
Scenario: [BYTES-048] A member's files from one device keep arriving while another device's large backlog downloads
  Given a member's desktop is still downloading 300 large documents added earlier on the member's laptop
  When the member adds a document on a third computer
  Then the document opens on the desktop while the laptop's documents are still downloading
```

- **Notes:** Each sync shares its byte allowance between the devices that wrote the files, so one device's backlog never holds back another device's files.

## Upload logs

```gherkin
@local @mobile @cloud
@intent:confirmed
Scenario: [BYTES-049] A cloud operator finds one log line per upload batch in the cloud's logs, with the device's own account of its uploads
  Given a member's computer is uploading new photos
  When the cloud operator reads the cloud data server's logs
  Then the cloud operator finds one JSON line with "event": "upload-batch" for each batch of up to 32 files, naming the channel's app, the caller as a signed-in computer or a phone's app together with the member's id, how many files the cloud answered as present, absent, refused, error, and signed, the bytes signed, and the time the batch took
  And each line carries the device's report since its previous batch: the files and bytes sent, up to five failures with their errors, the files missing from the device, the queue's size, and whether the device's uploads were running, draining, or paused
```

- **Notes:** A report longer than 8,000 characters is dropped from the line, and the line says how long it was. The cloud's per-exchange line is SYNC-063 in [sync.md](sync.md).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [BYTES-050] A cloud operator finds in the cloud's logs that a phone's earlier upload batch never finished
  Given a member's phone was stopped by its system in the middle of an upload batch
  When the cloud operator reads the cloud data server's logs after the phone's next upload batch
  Then the cloud operator finds the earlier batch under "unfinishedBatches" in the next "upload-batch" line, with its id, its start time, and how many files it held
```

- **Notes:** The earlier batch's files stay queued and count no failed attempt.

```gherkin
@local
@intent:confirmed
Scenario Outline: [BYTES-051] A member reads in the data server's log why a file has not uploaded
  Given a member's computer is uploading files
  And <situation>
  When the member reads the data server's log
  Then the member finds the line "<line>"

  Examples:
    | situation                                                     | line                                                                        |
    | a document's bytes disappeared from the data folder           | [upload] <key> is no longer on this node; waiting for its bytes             |
    | the cloud's storage rejected a document's upload              | [upload] <key> failed: <message>                                            |
    | the cloud could not be reached to sign a batch of uploads     | [upload] presign batch failed; pausing: <message>                           |
    | every upload in a batch failed on the network                 | [upload] every transfer in batch <id> failed on the network; pausing: <message> |
```

- **Notes:** `<key>`, `<id>`, and `<message>` stand for the file's storage key, the batch's id, and the error. Each line starts with the local time, as SYNC-062 in [sync.md](sync.md) states.

## Files kept out of the cloud

The platform's `starkeep/no-cloud` mark keeps a record's bytes off the cloud's storage. Every device leaves such a file out of its uploads, and the cloud refuses the bytes on every upload route.

```gherkin
@local @mobile @cloud
@intent:unclear
Scenario: [BYTES-052] A cloud operator never finds in the cloud's storage the file of a photo marked to stay out of the cloud
  Given a member's computer holds a photo that carries the platform's mark that keeps its bytes out of the cloud
  When the cloud operator looks for the photo's file in the cloud's storage after the computer's next sync
  Then the cloud operator does not find the file
```

- **Notes:** An app that tries to upload such a photo's bytes anyway gets a forbidden answer with the error "This record is marked starkeep/no-cloud; its bytes may not be written to cloud storage." No app and no page can set the mark today. [residency-and-stand-ins.md](residency-and-stand-ins.md) RESIDENCY-011 owns the member keeping such a photo on the device.
