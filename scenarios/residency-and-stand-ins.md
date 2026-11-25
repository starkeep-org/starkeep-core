# Residency and stand-ins

This file specifies which file bytes each of a member's devices keeps, how apps make and read stand-ins, when the cloud archives an original, and the library's quality settings. A member keeps a library on a computer, on a phone, and in the cloud, and each device holds only some of the bytes. An app developer writes stand-ins, reports an original's size, reads a photo at a chosen size, and lists the stand-in backlog through the data servers. The local operator sets a computer's sync-down ceilings, "Keep originals here", and "Free up space" on that computer's admin-web Storage page, and sets the library's quality there when the computer has no cloud. The cloud operator sets the library's quality on a computer with a cloud, which needs a sign-in with cloud operator rights. The cloud operator also deploys the cloud, which seeds the library's settings, and finds the archive tags on the cloud's files. The phone's own Storage section belongs to Photos for phones, and the `@mobile` scenarios here state only the core behavior that the phone shares with a computer.

Related files:

- [shared-data.md](shared-data.md): deleting records and their stand-ins, the Trash and its window, reclaiming deleted files, reading archived records and thawing them, and the answers an app receives for file URLs.
- [local-data-server.md](local-data-server.md): watched folders, and what happens when a file leaves a watched folder.
- [uploads-and-file-bytes.md](uploads-and-file-bytes.md): uploads, the cloud refusing bytes it must not hold, moving queued files down to a device, and files still awaiting upload.
- [sync.md](sync.md): the exchange that carries records between devices, sync robustness, and "Check sync integrity".
- [app-lifecycle.md](app-lifecycle.md): the install consent dialog, including its archive-quality step.
- [cloud-setup.md](cloud-setup.md): deploying the cloud.
- [users-and-access.md](users-and-access.md): the sign-in with cloud operator rights, and type grants.

## What each device keeps

### Files every device keeps

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-001] A member opens documents, audio, and every other file no stand-in can replace on every device, offline
  Given a member's library holds a Markdown document, an MP3 recording, and a PDF
  And the member's phone keeps photo previews only up to 1280 pixels
  And the member's phone finished syncing
  When the member opens the three files on the phone with no network connection
  Then all three files open
  And the three files still open offline after every later sync
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-002] A member sees a video's poster frame on every device, offline, whatever the device's ceiling
  Given a member's library holds a video with a poster frame that an app made
  And the device's video ceiling is none
  And the member's device finished syncing
  When the member browses the library on the device with no network connection
  Then the member sees the video's poster frame
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-003] An app opens its own private files on every computer it syncs to, offline
  Given an app keeps a file among its own rows, such as an attachment
  And the app runs on two of a member's computers
  When the app on the second computer opens the attachment with no network connection, after the computer synced the app's rows
  Then the attachment opens
```

### Stand-ins and originals against the ceiling

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-004] A member views every photo at up to 2560 pixels on a computer, offline, by default
  Given a member's library holds photos with stand-ins at 320, 640, 1280, and 2560 pixels
  And nobody changed the computer's ceilings
  And the member's computer finished syncing
  When the member views the photos on the computer with no network connection
  Then every photo shows at up to 2560 pixels
```

```gherkin
@mobile
@intent:confirmed
Scenario: [RESIDENCY-005] A member views every photo at up to 1280 pixels on a phone, offline, by default
  Given a member's library holds photos with stand-ins at 320, 640, 1280, and 2560 pixels
  And nobody changed the phone's ceilings
  And the member's phone finished syncing
  When the member views the photos on the phone with no network connection
  Then every photo shows at up to 1280 pixels
  And viewing a photo at 2560 pixels needs a network connection
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-006] A member sees every video's poster frame offline by default, and playing a video needs the network
  Given a member's library holds videos with poster frames and 2000 kbps stand-ins
  And nobody changed the device's ceilings
  And the member's device finished syncing
  When the member browses the videos on the device with no network connection
  Then the member sees every video's poster frame
  And playing a video needs a network connection
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-007] A member views a large photo at full size only with a network connection
  Given a member's library holds a 6000-pixel photo with a 2560-pixel stand-in and a 4272-pixel canonical stand-in
  And the member's device keeps photo stand-ins up to 2560 pixels
  And the member's device finished syncing
  When the member opens the photo on the device with no network connection
  Then the photo shows at 2560 pixels
  And viewing the photo at full size needs a network connection
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-008] A member views a small photo at full size offline when the photo fits the device's ceiling
  Given a member's library holds a 1600-pixel photo of 800 KB, which serves as its own canonical stand-in
  And the member's device keeps photo stand-ins up to 2560 pixels
  And the member's device finished syncing
  When the member opens the photo at full size on the device with no network connection
  Then the photo shows at full size
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-009] A member views a photo whose pixel size no app has reported only with a network connection
  Given a member's library holds a small photo whose pixel size no app has reported
  And the member's device keeps photo stand-ins up to 2560 pixels
  And the member's device finished syncing
  When the member browses the library on the device
  Then the member sees the photo listed
  And viewing the photo needs a network connection
```

```gherkin
@local @mobile
@intent:unclear
Scenario: [RESIDENCY-142] A member views a photo that still awaits the library's quality threshold only with a network connection
  Given a member's library holds a 3 MB photo of 2000 pixels that no device has yet judged against the library's quality threshold
  And the member's device keeps photo stand-ins up to 2560 pixels
  And the member's device finished syncing
  When the member browses the library on the device
  Then the member sees the photo listed
  And viewing the photo needs a network connection
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-010] A member sees a photo listed with its previews on a device that skipped its original
  Given a member's library holds a 6000-pixel photo above the device's ceiling
  And the member's device synced several times
  When the member browses the library on the device
  Then the member sees the photo listed with its details and its previews
  And after every later sync, viewing the photo at full size still needs a network connection
```

```gherkin
@local @mobile
@intent:unclear
Scenario: [RESIDENCY-011] A member keeps a photo marked to stay out of the cloud on the computer that holds it
  Given a photo on a member's computer carries the platform's mark that keeps its bytes out of the cloud
  And the member's computer finished syncing
  When the member opens the photo on that computer
  Then the photo opens
  And the member's other devices list the photo but cannot open its file
```

- **Notes:** The cloud's refusal of the bytes belongs to [uploads-and-file-bytes.md](uploads-and-file-bytes.md). No app and no page can set the platform's mark today, because only the platform writes into its own label namespace.

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-012] A member opens on another device a photo that an app labelled "no-cloud" in its own namespace
  Given a member uses an app that labels a photo with a "no-cloud" key in the app's own label namespace
  And the member's computer finished syncing
  When the member opens the photo on another device
  Then the photo opens
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-013] A member still receives every file when the computer fails once to decide about one of them
  Given a member's computer failed once, during a sync, while deciding whether to keep one file's bytes
  When the member looks on the computer for the files from that sync
  Then the member finds every other file from the same sync on the computer
  And the member finds the file itself on the computer after a later sync
```

- **Notes:** Other sync robustness cases belong to [sync.md](sync.md).

### Opening a file that is not on the device

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-014] A member who opens an original once opens it offline from then on
  Given the member's computer lists a 6000-pixel photo whose original sits only in the cloud
  When the member opens the photo's original in an app
  Then the original opens
  And the original opens again later with no network connection
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-144] A local operator finds an original that a member opened once counted among the originals here
  Given the computer listed a 6000-pixel photo whose original sat only in the cloud
  And a member opened the photo's original in an app
  When the local operator opens the Storage page
  Then the Storage page counts the original among the originals here
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-015] An app that asks for a photo at the canonical size can load it offline afterwards
  Given an app runs on a member's computer that lacks a photo's canonical stand-in
  When the app asks for the photo at the canonical size
  Then the app receives a URL that loads the canonical stand-in
  And the same request later returns a working URL with no network connection
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-016] An app that asks for many file URLs at once can load every one of them offline afterwards
  Given an app runs on a member's computer that lacks three photos' originals
  When the app asks for the three originals' file URLs in one request
  Then the app receives a URL for each original
  And the same request later returns three working URLs with no network connection
```

- **Notes:** The shape of the URL answers belongs to [shared-data.md](shared-data.md), SHARED-088 and SHARED-093.

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-017] A member whose original could not come from the cloud opens it once the cloud recovers
  Given a member's computer lists a photo whose original sits only in the cloud
  And the cloud cannot hand over the original's bytes
  When the member opens the photo's original in an app
  Then the original does not open
  And opening it again after the cloud recovers shows the original
```

- **Notes:** The gateway error the app receives belongs to [shared-data.md](shared-data.md), SHARED-092.

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-018] An app learns that a stand-in is not on the computer when the cloud cannot hand it over
  Given an app runs on a member's computer that lacks a photo's canonical stand-in
  And the cloud cannot hand over the stand-in's bytes
  When the app asks for the photo at the canonical size
  Then the app receives the canonical stand-in's record id with no URL
  And the answer says the stand-in is not available on this device
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-019] An app still gets the other URLs in a batch when the cloud cannot hand over one file
  Given an app runs on a member's computer that holds a photo's 1280-pixel stand-in but lacks the photo's original
  And the cloud cannot hand over the original's bytes
  When the app asks for the stand-in's and the original's file URLs in one request
  Then the app receives a URL for the stand-in
  And the answer leaves out the original
```

- A computer with no cloud answers not found for a file it does not hold: see SHARED-091 in [shared-data.md](shared-data.md) (formerly RESIDENCY-020).

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-021] An app sees where each size of a photo sits: on this computer, in the cloud, or not made yet
  Given an app runs on a member's computer that keeps photo stand-ins up to 2560 pixels
  And the member's library holds a 6000-pixel photo with stand-ins at 1280 and 2560 pixels and a canonical stand-in
  When the app lists the photo
  Then the app receives a size description that marks 1280 and 2560 as here
  And the description marks the canonical size as in the cloud
  And the description marks 320 and 640 as not made yet
```

- **Notes:** A size whose bytes have not reached the cloud yet belongs to [uploads-and-file-bytes.md](uploads-and-file-bytes.md).

### Changing what a device keeps

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-022] A member views the newly covered sizes offline after a computer's ceiling goes up and the data server restarts
  Given a member's computer kept photo stand-ins up to 1280 pixels
  And the library holds 2560-pixel stand-ins that the computer skipped
  And the computer's photo ceiling then went up to 2560 px on the Storage page, and the data server restarted to apply it
  When the member views the photos on the computer with no network connection
  Then the photos show at 2560 pixels
```

```gherkin
@mobile
@intent:confirmed
Scenario: [RESIDENCY-023] A member who raises a phone's ceiling views the newly covered sizes offline without restarting Photos
  Given a member's phone keeps photo stand-ins up to 1280 pixels
  And the library holds 2560-pixel stand-ins that the phone skipped
  When the member raises the phone's photo ceiling to 2560 pixels
  Then the member views the photos at 2560 pixels with no network connection once the downloads finish, without restarting Photos
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-024] A member keeps every file after a device's ceiling goes down, until "Free up space" runs
  Given a member's device holds 2560-pixel stand-ins under a 2560-pixel ceiling
  And the device's photo ceiling then went down to 1280 pixels
  When the member views the photos with no network connection
  Then the photos still show at 2560 pixels
  And after "Free up space" frees enough space from originals and sizes above the ceiling, viewing the photos at 2560 pixels needs a network connection
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-025] A member opens every original offline on a computer that keeps originals, while larger stand-ins still wait
  Given "Keep originals here" is on for a member's computer that keeps photo stand-ins up to 2560 pixels
  And the member's computer finished syncing
  When the member opens the photo and video originals on the computer with no network connection
  Then every original opens
  And viewing a photo at its 4272-pixel canonical size needs a network connection
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-026] A member never loses a file from a device except through "Free up space", however full the device gets
  Given a member's device holds originals that the member opened, and its disk is nearly full
  When the member keeps using the device for a week
  Then every original the member opened still opens on the device with no network connection
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-027] A member finds a freed original off the device until opening it again
  Given "Free up space" freed one of a member's originals from the device
  When the member keeps using the device for a week
  Then opening the original offline does not work
  And opening it with a network connection shows the original
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-028] A member gets back previews that went missing from a computer without the member asking
  Given a member's computer held 2560-pixel stand-ins within its ceiling
  And some of those stand-ins' bytes disappeared from the computer's data folder
  And the computer's data server then started again
  When the member views those photos with no network connection after the downloads finish
  Then the photos show at 2560 pixels
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-139] A member finds a photo that left a watched folder off the computer until opening it, even when the computer keeps originals
  Given a member deleted a photo from a watched folder after its cloud copy was proved
  And "Keep originals here" is on for the member's computer
  When the member keeps using the computer for a week
  Then opening the photo offline does not work
  And opening it with a network connection shows the photo
```

- **Notes:** What the library shows for the departed file belongs to [local-data-server.md](local-data-server.md), LDS-053.

## Freeing up space

"Free up space" is the one path that removes a file from a device. On a computer the local operator runs it from the Storage page, and on a phone the member runs it from Photos. The admin-web controls themselves sit under "The admin-web Storage page" below.

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-030] A local operator who frees space loses the largest originals first, and no more than the amount asked for needs
  Given a member's device holds photo originals of 4 GB, 2 GB, 1 GB, and 500 MB, each with a proved cloud copy
  When the local operator frees 5 GB from originals
  Then the 4 GB and 2 GB originals no longer open offline
  And the 1 GB and 500 MB originals still open offline
  And the report says 6 GB were freed
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-031] A member keeps every stand-in when space is freed from originals
  Given a member's device holds photo originals and canonical stand-ins above its ceiling, all with proved cloud copies
  And a "Free up space" run then freed more space from originals than the originals hold
  When the member opens the photos on the device with no network connection
  Then no original opens
  And every photo still shows at its canonical size
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-032] A member loses stand-ins above the ceiling, the canonical one included, but none within it, when space is freed in the wider scope
  Given a member's device keeps photo stand-ins up to 1280 pixels
  And the device holds a photo's 640-pixel, 2560-pixel, and canonical stand-ins, all with proved cloud copies
  And a "Free up space" run then freed space from originals and sizes above the ceiling
  When the member opens the photo on the device with no network connection
  Then the photo no longer shows at 2560 pixels or at its canonical size
  And the photo still shows at 640 pixels
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-033] A member keeps documents, derived files, and small photos that stand in for themselves when space is freed
  Given a member's device holds a PDF, a video's poster frame, and an 800 KB photo that stands in for itself
  And a "Free up space" run then freed space in the wider scope
  When the member opens the three files on the device with no network connection
  Then all three files still open
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-034] A local operator frees a photo that stands in for itself above the ceiling once its own cloud copy is proved
  Given the computer keeps photo stand-ins up to 1280 pixels
  And the computer holds a 3000-pixel photo that stands in for itself, with a proved cloud copy
  When the local operator frees space from originals
  Then the report counts the photo among the files freed
  And the photo opens again with a network connection
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-035] A local operator keeps a file whose original or canonical stand-in the cloud cannot yet be shown to hold
  Given a member's device holds a 6000-pixel original whose canonical stand-in has not finished uploading
  When the local operator frees space from originals
  Then the original still opens on the device with no network connection
  And the report counts it among the files kept because the cloud could not yet be shown to hold them
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-036] A local operator keeps an original that has no canonical stand-in yet, however safe its own cloud copy is
  Given the computer holds a 6000-pixel original that no app has made a canonical stand-in for
  And the cloud holds a verified copy of the original
  When the local operator frees space from originals
  Then the original still opens on the computer with no network connection
  And the report counts it among the files kept
```

- **Notes:** Implementation gap: admin-web's report line counts this file under "Kept 1 that the cloud could not yet be shown to hold.", which misstates the reason, because the cloud does hold the original.

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-038] A local operator who asks for an estimate learns what freeing space would remove, and loses nothing
  Given a member's device holds originals with proved cloud copies
  When the local operator asks for an estimate of freeing 5 GB
  Then the estimate names how much it would free and from how many files
  And every original still opens on the device with no network connection
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-039] A local operator frees an original that a member imported on the device
  Given a member imported a 6000-pixel photo on the device, and the photo uploaded with its canonical stand-in
  When the local operator frees space from originals
  Then the report counts the imported original among the files freed
  And the original opens again with a network connection
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-040] A local operator never loses files in a watched folder or the camera roll to freeing space
  Given a member's device lists a large photo whose bytes live in a watched folder on a computer or in a phone's camera roll
  When the local operator frees space from originals
  Then the photo's file stays where a member put it
  And the report does not count the photo among the files freed
```

- **Notes:** What the library does when the local operator deletes a file from a watched folder belongs to [local-data-server.md](local-data-server.md), LDS-053 and LDS-054.

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-041] A local operator who keeps originals on a computer frees no original
  Given the local operator turned on "Keep originals here" for the computer, which holds originals with proved cloud copies
  When the local operator frees space from originals
  Then every original still opens on the computer with no network connection
  And the page shows "Freed 0 B from 0 file(s) of 0 B eligible."
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-042] A member opens a freed original again from the cloud, intact
  Given "Free up space" freed a photo original from a member's computer after the cloud's copies were proved
  When the member opens the original in an app
  Then the original shows with the same bytes that were imported
  And the original opens again later with no network connection
```

## Stand-ins

A stand-in is a smaller copy of a photo or a video that an app makes and the platform checks. A photo takes smaller stand-ins at 320, 640, 1280, and 2560 pixels, and a canonical stand-in at the library's threshold, 4272 pixels by default. A video takes a smaller stand-in at 2000 kbps and a canonical stand-in at 4800 kbps by default. Stand-ins are AVIF for photos and WebM for videos. The app developer is the actor in this section.

### Making a stand-in

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-044] An app makes a smaller photo stand-in at a standard size, and the stand-in carries its role and size
  Given an app holds a readwrite grant on photos
  And the library holds a 6000-pixel JPEG original
  When the app registers a 640-pixel AVIF as a smaller stand-in for the original
  Then the app receives the new record with the role "smaller" and the size 640
  And the original's size description lists the 640-pixel stand-in
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-045] An app makes the canonical stand-in at the library's threshold
  Given an app holds a readwrite grant on photos
  And the library holds a 6000-pixel JPEG original under the default threshold of 4272 pixels
  When the app registers a 4272-pixel AVIF as the original's canonical stand-in
  Then the app receives the new record with the role "canonical" and the size 4272
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-046] An app makes a canonical stand-in for a video below the threshold at the video's own bitrate
  Given an app holds a readwrite grant on videos
  And the library holds a 3000 kbps video original larger than 1 MiB, under the default threshold of 4800 kbps
  When the app registers a 3000 kbps WebM as the video's canonical stand-in
  Then the app receives the new record with the role "canonical" and the size 3000
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-047] An app records an original's reported size with the first stand-in
  Given an app holds a readwrite grant on photos
  And the library holds a JPEG original whose pixel size nobody has reported
  When the app registers a 320-pixel stand-in and reports the original's size as 5000 pixels with it
  Then the app reads the original back with the size 5000
  And the app's later stand-ins for the original need no size report
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [RESIDENCY-048] An app whose stand-in breaks the standards is refused, and nothing is written
  Given an app holds a readwrite grant on photos and on documents
  And the library holds a 6000-pixel JPEG original with a 4272-pixel canonical stand-in
  When the app registers <stand-in>
  Then the app's write fails with the refusal code "<code>"
  And no new record appears in the library

  Examples:
    | stand-in                                                         | code                         |
    | a JPEG as a smaller stand-in for the original                    | type-not-allowed             |
    | an AVIF smaller stand-in at 500 pixels                           | not-a-standard-size          |
    | an AVIF canonical stand-in at 4000 pixels                        | canonical-fidelity-wrong     |
    | an AVIF smaller stand-in that names the canonical stand-in as its original | parent-is-stand-in |
    | an AVIF smaller stand-in that names a derived record as its original | parent-is-derived        |
    | an AVIF smaller stand-in that names a PDF as its original        | parent-not-stand-in-category |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [RESIDENCY-049] An app cannot give a photo that stands in for itself a canonical stand-in or a stand-in at or above its own size
  Given an app holds a readwrite grant on photos
  And the library holds a 2000-pixel JPEG original, which stands in for itself
  When the app registers <stand-in> for the original
  Then the app's write fails with the refusal code "<code>"

  Examples:
    | stand-in                                    | code                        |
    | a 2000-pixel AVIF canonical stand-in        | original-takes-no-canonical |
    | a 2560-pixel AVIF smaller stand-in          | exceeds-canonical           |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-050] An app cannot register a stand-in for an original with no reported size until the app reports one
  Given an app holds a readwrite grant on photos
  And the library holds a JPEG original whose pixel size nobody has reported
  When the app registers a 640-pixel stand-in without reporting the original's size
  Then the app's write fails with the refusal code "parent-fidelity-unknown"
  And the message reads "the original has no reported fidelity; report it as parentFidelity with the first stand-in"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-051] An app that reports an original's size differently from the recorded size is refused as a conflict
  Given an app holds a readwrite grant on photos
  And the library holds a JPEG original recorded at 6000 pixels
  When the app registers a 640-pixel stand-in and reports the original's size as 5000 pixels
  Then the app's write fails as a conflict with the refusal code "parent-fidelity-mismatch"
  And the message reads "the original's fidelity is recorded as 6000; this write reports 5000"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [RESIDENCY-052] An app that registers a stand-in for an original it cannot see gets not found
  Given an app holds a readwrite grant on photos only
  When the app registers a 640-pixel stand-in for <original>
  Then the app's write fails as not found

  Examples:
    | original                            |
    | an id that names no record          |
    | a deleted photo                     |
    | a video, which the app cannot read  |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-053] An app whose canonical stand-in is no smaller than its original gets no new record, and the original then stands in for itself
  Given an app holds a readwrite grant on videos
  And the library holds a 3000 kbps video original
  When the app registers a 3000 kbps WebM canonical stand-in whose file is as large as the original
  Then the app receives an answer that says the original now stands in for itself, with no new record
  And a later canonical stand-in for the original fails with the refusal code "original-takes-no-canonical"
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [RESIDENCY-054] An app cannot write per-category metadata on a stand-in
  Given an app holds a readwrite grant on photos
  And the library holds a photo original with a 640-pixel stand-in
  When the app writes metadata on the stand-in <path>
  Then the app's write fails with the error "StandInMetadata"

  Examples:
    | path                                     |
    | in the request that registers it         |
    | through the metadata route afterwards    |
```

### One stand-in per slot

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-055] An app whose second stand-in takes a filled slot is refused, and learns which stand-in holds the slot
  Given an app holds a readwrite grant on photos
  And the library holds a photo original with a 640-pixel stand-in
  When the app registers a different 640-pixel stand-in for the same original
  Then the app's write fails as a conflict with the error "StandInExists"
  And the answer names the existing stand-in's record id
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-056] An app that sends the same stand-in again gets the existing one back rather than a conflict
  Given an app registered a 640-pixel stand-in for a photo original
  When the app registers the same bytes as the same stand-in again
  Then the app receives the existing stand-in, marked as a duplicate
```

- Deleting a smaller stand-in alone frees its slot: see SHARED-195 in [shared-data.md](shared-data.md) (formerly RESIDENCY-057).

### An original's own size and quality stamp

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-058] An app reports a photo or video original's own size when it registers the original
  Given an app holds a readwrite grant on photos
  When the app registers a JPEG original and reports its size as 6000 pixels
  Then the app reads the original back with the size 6000
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [RESIDENCY-138] An app cannot report a size on a derived record or on a file outside photos and videos
  Given an app holds readwrite grants on photos and on documents
  When the app registers <record> and reports a size for it
  Then the app's write fails with the refusal code "<code>"

  Examples:
    | record                              | code                               |
    | a derived record of a photo         | fidelity-on-derived-record         |
    | a PDF                               | fidelity-outside-stand-in-category |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-059] An app reports an original's size after the fact, once
  Given an app holds a readwrite grant on photos
  And the library holds a JPEG original whose pixel size nobody has reported
  When the app reports the original's size as 300 pixels
  Then the app receives the original with the size 300, marked as recorded
  And the same report again is accepted but records nothing new
  And a report of 301 pixels fails as a conflict
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-060] An app that reports a size late lets a small photo from a watched folder stand in for itself
  Given the library holds a small 200-pixel photo that a member added through a watched folder, with no size
  When an app reports the photo's size as 200 pixels
  Then the app reads the photo's size description with the status "self-canonical" and the top size 200
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-061] An app that registers a second copy of the same bytes with a different size is refused as a conflict
  Given an app registered a JPEG original reported at 6000 pixels
  When the app registers the same bytes under the same name and reports 5000 pixels
  Then the app's write fails as a conflict
  And the app reads the original back with the size 6000
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-062] An app finds that an original takes the library's threshold when the original's size is first recorded
  Given the library's photo threshold is the default of 4272 pixels
  And an app registers a JPEG original without a size
  When the app later reports the original's size as 5000 pixels
  Then the app reads the original's size description with 4272 as the canonical size
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-063] An app waits one sync to register stand-ins on a computer that has never read the library's settings
  Given an app runs on a computer that syncs with a cloud but has never read the library's settings
  And the app registers a 6000-pixel JPEG original
  When the app registers a 640-pixel stand-in for the original before the computer syncs
  Then the app's write fails as a conflict with the refusal code "parent-awaits-stamp"
  And after the computer syncs, the app reads the original with the cloud's threshold
  And the same stand-in then registers
```

### Reading stand-ins

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-064] An app lists one item per original, with the original's stand-ins folded in
  Given the library holds a photo original with 640-pixel and canonical stand-ins
  When an app lists the library's photos
  Then the app receives one item for the photo
  And the item describes the photo's stand-ins
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [RESIDENCY-065] An app that asks for stand-ins sees them as their own rows
  Given the library holds a photo original with 640-pixel and canonical stand-ins
  When an app lists the library's photos <asking>
  Then the app receives the original and both stand-ins as separate items

  Examples:
    | asking                              |
    | with stand-ins included             |
    | with a filter on the stand-in role  |
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-066] An app still sees derived records that are not stand-ins in its listing
  Given the library holds a photo original with a 640-pixel stand-in and an app's own thumbnail as a derived record
  When an app lists the library's photos
  Then the app receives the original and the thumbnail
  And the app does not receive the stand-in as its own item
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-067] An app counts one item per original unless it asks to count stand-ins
  Given the library holds two photo originals, each with two stand-ins
  When an app counts the library's photos
  Then the app receives a count of 2
  And a count that includes stand-ins answers 6
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-068] An app sees every standard size and the canonical stand-in in each original's size description
  Given the library holds a 6000-pixel photo original with only a 640-pixel stand-in
  When an app lists the photo
  Then the app receives a size description with 320, 640, 1280, 2560, and the canonical size 4272
  And the description marks every size except 640 as not made yet
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-069] An app sees a photo that stands in for itself answer its own top size
  Given the library holds a 2000-pixel photo original, which stands in for itself
  When an app lists the photo
  Then the app receives a size description whose top size is 2000, served by the original itself
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-070] An app sees only the existing stand-ins for an original with no reported size
  Given the library holds a photo original with no reported size and one 320-pixel stand-in from an older import
  When an app lists the photo
  Then the app receives a size description that lists only the 320-pixel stand-in
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-071] An app that asks for URLs gets one for each size it can load now
  Given the library holds a photo original with 640-pixel and 2560-pixel stand-ins
  When an app lists the photo and asks for stand-in URLs
  Then the app receives a URL on each size the app can load now
  And the app receives no URL on a size that is not made yet
```

- **Notes:** A size whose bytes have not reached the cloud yet belongs to [uploads-and-file-bytes.md](uploads-and-file-bytes.md).

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-072] An app reads the same size description on a single photo as on a listing
  Given the library holds a photo original with 640-pixel and canonical stand-ins
  When an app reads the photo by id
  Then the app receives the same size description the listing carries
```

### Reading at a chosen size

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-073] An app reads a photo at a standard size and learns which stand-in it got
  Given the library holds a 6000-pixel photo original with a 1280-pixel stand-in
  When an app asks for the photo at 1280 pixels
  Then the app receives a URL that loads the 1280-pixel stand-in
  And the answer names the stand-in's record id
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [RESIDENCY-074] An app that asks for the canonical size, or any larger size, gets the canonical stand-in
  Given the library holds a 6000-pixel photo original with a 4272-pixel canonical stand-in
  When an app asks for the photo at <size>
  Then the app receives a URL that loads the canonical stand-in

  Examples:
    | size      |
    | canonical |
    | 4272      |
    | 8000      |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-075] An app that asks for the canonical size of a photo that stands in for itself gets the photo itself
  Given the library holds a 2000-pixel photo original, which stands in for itself
  When an app asks for the photo at the canonical size
  Then the app receives a URL that loads the original
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-076] An app that asks for a size nobody made yet gets not found, with the size description
  Given the library holds a 6000-pixel photo original with no 640-pixel stand-in
  When an app asks for the photo at 640 pixels
  Then the app receives a not-found answer with the error "SizeNotProduced"
  And the answer carries the photo's size description
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [RESIDENCY-077] An app that asks for a size the standards do not have, or asks a stand-in for a size, is refused
  Given the library holds a 6000-pixel photo original with a 640-pixel stand-in
  When an app asks <request>
  Then the app's request fails as a bad request with the error "<error>"

  Examples:
    | request                                    | error            |
    | for the original at 1000 pixels            | NotAStandardSize |
    | for the original at the size "large"       | InvalidSize      |
    | for the 640-pixel stand-in at 320 pixels   | NotAnOriginal    |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-078] An app that asks for a size of an original with no reported size gets not found
  Given the library holds a photo original with no reported size
  When an app asks for the photo at 640 pixels
  Then the app receives a not-found answer with the error "FidelityUnknown"
```

- A size read of archived bytes is refused like any archived read: see SHARED-131 in [shared-data.md](shared-data.md) (formerly RESIDENCY-079).

### Stand-ins across devices

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-080] An app on another computer reads a stand-in with its role, its size, and the original's size
  Given an app on a member's first computer registered a 640-pixel stand-in and reported the original's size as 6000 pixels
  When the app on the second computer reads the photo after both computers synced
  Then the app receives the stand-in with the role "smaller" and the size 640
  And the app receives the original with the size 6000
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-081] An app sees one canonical stand-in everywhere after two offline computers each made one
  Given an app on each of a member's two computers made a canonical stand-in for the same photo while offline
  When the app on each computer and in the cloud lists the photo's stand-ins after both computers synced
  Then every listing holds the same single canonical stand-in, the one the cloud received first
  And the app's later changes on either computer still reach the other
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-082] An app sees one smaller stand-in at a size everywhere after two offline computers each made one
  Given an app on each of a member's two computers made a 640-pixel stand-in for the same photo while offline
  When the app on each computer and in the cloud lists the photo's stand-ins after both computers synced
  Then every listing holds the same single 640-pixel stand-in, the one the cloud received first
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-083] An app never sees a losing stand-in from a computer that received the winner first
  Given an app on a member's second computer made a canonical stand-in for a photo while offline
  And the cloud already holds another canonical stand-in for the photo
  When the app lists the photo's stand-ins on the second computer and on the member's other devices after the second computer synced
  Then every listing holds only the cloud's canonical stand-in
  And the app on the member's other devices never lists the second computer's own stand-in
```

- **Notes:** RESIDENCY-084 (later syncs send nothing more after two computers converge) is folded into RESIDENCY-081 and RESIDENCY-082, because nobody observes a quiet sync except as everything staying the same.

## Archiving originals

The cloud marks an original for deep archive by tagging its file with `starkeep:intent=archive` and `starkeep:ladder=complete`. A lifecycle rule on the files bucket then moves a tagged file to Deep Archive after a seven-day hold. The cloud operator sees the tags and the storage class in the AWS console. Reading and thawing archived records belong to [shared-data.md](shared-data.md), SHARED-130 to SHARED-137.

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-085] A cloud operator finds a large original tagged for deep archive once its canonical stand-in reaches the cloud
  Given a member's library in the cloud operator's deployment holds a 6000-pixel photo original of 8 MB
  And the photo's canonical stand-in has reached the cloud
  When the cloud operator inspects the original's file in the files bucket
  Then the cloud operator finds both archive tags on it
```

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-086] A cloud operator finds an original tagged when its canonical stand-in's file arrives after the stand-in's record
  Given a member's library holds a 6000-pixel photo original whose canonical stand-in was recorded before its file uploaded
  And the cloud operator found no archive tags on the original's file while the stand-in's file was still uploading
  When the cloud operator inspects the original's file after the stand-in's file reaches the cloud
  Then the cloud operator finds both archive tags on it
```

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-087] A cloud operator finds no archive tags on an original that has only smaller stand-ins
  Given a member's library holds a 6000-pixel photo original with 640-pixel and 2560-pixel stand-ins in the cloud
  When the cloud operator inspects the original's file in the files bucket
  Then the cloud operator finds no archive tags on it
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-088] An app with only a read grant labels a photo do-not-archive without declaring the label
  Given an app holds a read grant on photos
  And the app's manifest declares no label keys
  When the app labels a photo original "do-not-archive" in its own namespace
  Then the app's label write succeeds
  And any app that reads the photo's labels sees the do-not-archive label
```

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-089] A cloud operator finds the archive tags gone once an app labels a waiting original do-not-archive
  Given a member's photo original carried both archive tags and had not moved to Deep Archive yet
  And an app then labelled the original "do-not-archive"
  When the cloud operator inspects the original's file in the files bucket
  Then the cloud operator finds no archive tags on it
```

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-140] A cloud operator finds an original already in Deep Archive left there when an app labels it do-not-archive
  Given a member's photo original has moved to Deep Archive
  And an app then labelled the original "do-not-archive"
  When the cloud operator inspects the original's file in the files bucket
  Then the cloud operator finds the file still in the Deep Archive storage class
```

- **Notes:** Bringing the file back is the member's thaw: see SHARED-133 and SHARED-134 in [shared-data.md](shared-data.md). While deep archiving stays paused (RESIDENCY-136), only a file that moved before the pause can be in this state.

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [RESIDENCY-090] A cloud operator finds the archive tags gone when a member deletes an original, and back when the member restores it
  Given a member's photo original carried both archive tags and had not moved to Deep Archive yet
  And the member then <action>
  When the cloud operator inspects the original's file in the files bucket
  Then the cloud operator finds <tags> on it

  Examples:
    | action                                         | tags              |
    | deleted the photo                              | no archive tags   |
    | deleted the photo and restored it from the Trash | both archive tags |
```

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-091] A cloud operator finds a shared file untagged unless every live record on it is ready to archive
  Given a member's library holds the same bytes as two photo originals under two names
  And only one of the two originals has a canonical stand-in in the cloud
  When the cloud operator inspects the shared file in the files bucket
  Then the cloud operator finds no archive tags on it
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [RESIDENCY-092] A cloud operator never finds archive tags on a file that stands in for itself or sits under the size floor
  Given a member's library holds <original> with a canonical stand-in in the cloud where one applies
  When the cloud operator inspects the original's file in the files bucket
  Then the cloud operator finds no archive tags on it

  Examples:
    | original                                                   |
    | a 2000-pixel photo, which stands in for itself              |
    | a 6000-pixel photo of 900 KB                                |
    | a video of 900 KB                                           |
    | a video whose canonical stand-in came out no smaller than it |
```

```gherkin
@cloud
@intent:confirmed @suboptimal
Scenario: [RESIDENCY-136] A cloud operator finds tagged originals still in instant storage while deep archiving is paused
  Given a member's photo original has carried both archive tags for more than seven days
  When the cloud operator inspects the original's file in the files bucket
  Then the cloud operator finds the file still in the Intelligent-Tiering storage class
  And the cloud operator finds the bucket's archive lifecycle rule disabled
```

- **Suboptimal:** Deep archiving is paused while the platform's data layout settles. Re-enable the lifecycle rule, and then every tagged original older than the hold moves to Deep Archive at the next evaluation.

## The stand-in backlog

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-093] An app lists the originals waiting for a canonical stand-in, and each drops off once one exists
  Given an app holds a read grant on photos
  And the library holds two 6000-pixel photo originals with no canonical stand-in
  When the app lists the backlog of originals missing a canonical stand-in
  Then the app receives both originals
  And after the app registers a canonical stand-in for one of them, the backlog lists only the other
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-094] An app lists the originals nobody has reported a size for
  Given an app holds a read grant on photos
  And the library holds a photo original with no reported size and another with a reported size
  When the app lists the backlog of originals missing a size
  Then the app receives only the original with no reported size
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-141] An app sees only backlog originals of types it can read
  Given an app holds a read grant on photos only
  And the library holds a photo original and a video original, neither with a canonical stand-in
  When the app lists the backlog of originals missing a canonical stand-in
  Then the app receives the photo original
  And the answer leaves out the video original
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-095] An app that asks for an unknown backlog kind is refused
  Given an app holds a read grant on photos
  When the app lists the backlog of kind "missing-thumbnail"
  Then the app's request fails as a bad request saying "kind must be one of missing-canonical, missing-fidelity"
```

## Library standards and deployment settings

The deployment's settings hold the library's quality thresholds, the video resolutions, and the trash window. With a cloud, the settings live in the cloud and every device reads them. Without a cloud, they live on the computer. The trash window's own behavior belongs to [shared-data.md](shared-data.md), SHARED-114, SHARED-115, and SHARED-199.

### Reading the library's settings

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-096] An app gets the platform defaults for new originals at once while nobody has set the library's settings
  Given nobody has set the library's settings
  And an app runs on a computer that has just joined the cloud
  When the app registers a 6000-pixel JPEG original before the computer's first sync
  Then the app reads 4272 as the original's canonical size
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-097] An app on every device takes a changed threshold for new originals within two minutes
  Given the cloud operator changed the library's photo threshold from 4272 to 6000 pixels
  And an app runs on another computer on the same cloud
  When the app registers a 7000-pixel JPEG original two minutes later
  Then the app reads 6000 as the original's canonical size
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-098] An app keeps the last threshold the device read when a later read fails
  Given the library's photo threshold is 6000 pixels, and the device read it once
  And the device's later reads of the library's settings fail
  When an app on the device registers a 7000-pixel JPEG original
  Then the app reads 6000 as the original's canonical size
```

```gherkin
@local @mobile
@intent:confirmed
Scenario: [RESIDENCY-099] An app on a device that restarted offline still gets the last threshold the device read
  Given the library's photo threshold is 6000 pixels, and the device read it before it went offline
  And the device restarted with no network connection
  When an app on the device registers a 7000-pixel JPEG original
  Then the app reads 6000 as the original's canonical size
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-100] An app waits for the cloud to register stand-ins when the library's settings hold a value this computer rejects
  Given the library's settings in the cloud hold a photo threshold of 100 pixels, below the allowed range
  And an app runs on a computer that has never read a usable copy of the settings
  When the app registers a 6000-pixel JPEG original and then a 640-pixel stand-in for it
  Then the stand-in fails as a conflict with the refusal code "parent-awaits-stamp"
  And the app reads the original's size description with the status "awaiting-stamp" until the computer syncs
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-101] An app gets the chosen threshold from settings that a newer build wrote with fields this build does not know
  Given the library's settings hold a photo threshold of 6000 pixels and a field this build does not know
  When an app registers a 7000-pixel JPEG original
  Then the app reads 6000 as the original's canonical size
```

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-137] An app's new originals keep the cloud operator's threshold even when the cloud cannot read the library's settings
  Given the cloud operator set the library's photo threshold to 6000 pixels
  And the cloud cannot read the library's settings, and has not read them since it started
  When an app registers a 7000-pixel JPEG original in the cloud
  Then the app reads the original's size description with the status "awaiting-stamp"
  And the app reads 6000 as the canonical size once the cloud reads the settings again
```

### Changing the library's settings

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-103] A cloud operator on a computer with a cloud saves a quality change only while signed in
  Given the cloud operator's computer syncs with a cloud
  And the cloud operator is not signed in to admin-web
  When the cloud operator changes the photo threshold on the Storage page and clicks Save
  Then the section shows "This machine syncs with a cloud. Sign in to change the deployment's settings."
  And reloading the Storage page shows the old threshold
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-104] A cloud operator sees a saved quality change on the cloud operator's own computer at once
  Given the cloud operator's computer syncs with a cloud, and the cloud operator is signed in to admin-web
  When the cloud operator saves a photo threshold of 6000 px on the Storage page
  Then reloading the Storage page right away shows 6000 px
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-105] A local operator on a computer with no cloud saves a quality change on that computer
  Given the computer has no cloud
  When the local operator saves a photo threshold of 6000 px on the Storage page
  Then the section shows "Saved. Every device picks it up at its next sync."
  And reloading the Storage page shows 6000 px
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-106] A cloud operator who changes one setting finds every other setting as it was
  Given the library's photo threshold is 6000 pixels and its trash window is 90 days
  When the cloud operator sets "Keep deleted items for" to 14 days on the Storage page and saves
  Then reloading the Storage page shows the photo threshold still at 6000 px
  And the video threshold and resolutions still show their earlier values
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-109] A cloud operator sees why a quality change could not reach the cloud
  Given the cloud operator's computer syncs with a cloud, and the cloud operator is signed in to admin-web
  And the cloud operator's AWS credentials cannot take on the role that writes the library's settings
  When the cloud operator saves a photo threshold of 6000 px on the Storage page
  Then the section lists the reason the role could not be taken on
  And reloading the Storage page shows the old threshold
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [RESIDENCY-110] An app finds that existing originals keep their threshold after a change, while new originals take the new one
  Given an app registered a 7000-pixel JPEG original while the photo threshold was 4272 pixels
  And the cloud operator then changed the photo threshold to 6000 pixels
  When the app registers another 7000-pixel JPEG original
  Then the app reads 6000 as the new original's canonical size
  And the app still reads 4272 as the earlier original's canonical size
```

### Seeding the settings at the first deploy

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-134] A cloud operator finds the computer's own settings carried into the cloud after the first deploy
  Given the cloud operator's computer has no cloud yet, and its library's photo threshold is 6000 pixels
  When the cloud operator deploys the cloud from that computer
  Then the deploy output says "Seeded the deployment's settings from this machine's values."
  And the cloud operator finds the photo threshold at 6000 px on admin-web's Storage page
```

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-143] A cloud operator finds the deployment's settings left as a cloud operator saved them after a later deploy
  Given the cloud operator deployed the cloud from a computer whose library's photo threshold was 6000 pixels
  And a cloud operator later saved a photo threshold of 8192 px on the Storage page
  When the cloud operator deploys again from that computer
  Then the deploy output says "The deployment's settings already exist; leaving them as they are."
  And the cloud operator still finds the photo threshold at 8192 px on the Storage page
```

```gherkin
@cloud
@intent:confirmed
Scenario: [RESIDENCY-135] A cloud operator whose computer's settings do not check out sees the deploy skip the seeding and say why
  Given the cloud operator's computer holds library settings that do not check out
  When the cloud operator deploys the cloud from that computer
  Then the deploy output says "Not seeding the deployment's settings:" followed by the problems
  And the deploy finishes
  And the cloud operator finds the photo threshold at the default 4272 px on admin-web's Storage page
```

## The admin-web Storage page

A local operator opens the Storage page from the Data Server card's menu in admin-web. The quality section's saves on a computer with a cloud need a sign-in with cloud operator rights, so those scenarios belong to the cloud operator. The page's "Photos & videos" panel holds "Quality kept when originals archive", "Sync-down ceilings", "Keep originals here", "Backlog", "Free up space", "Reclaim deleted files", and "Check sync integrity". "Reclaim deleted files" belongs to [shared-data.md](shared-data.md), and "Check sync integrity" belongs to [sync.md](sync.md).

### Quality kept when originals archive

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-111] A cloud operator sees the photo and video thresholds, with the default marked and a custom value offered
  Given the cloud operator opens the Storage page
  When the cloud operator opens the threshold menus in "Quality kept when originals archive"
  Then the Photos menu offers 2560, 3200, 4272, 5120, 6000, and 8192 px, with "4272 px (default)", and "Custom…"
  And the Videos menu offers 3000, 4800, 8000, and 12000 kbps, with "4800 kbps (default)", and "Custom…"
  And the Videos row offers an archived-quality resolution and a resolution for the 2000 kbps size, from 720p to 2160p
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [RESIDENCY-112] A cloud operator cannot save a custom threshold out of range
  Given the cloud operator chose "Custom…" for <category> on the Storage page
  When the cloud operator types <value>
  Then the section shows "<message>"
  And the Save button stays disabled

  Examples:
    | category | value | message                                                 |
    | Photos   | 1000  | Photos: choose a whole number from 1280 to 16384 px.    |
    | Photos   | 20000 | Photos: choose a whole number from 1280 to 16384 px.    |
    | Videos   | 500   | Videos: choose a whole number from 1000 to 50000 kbps.  |
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [RESIDENCY-113] A cloud operator sees how many originals of each kind the library holds and how much they weigh
  Given the library holds <holding>
  When the cloud operator opens the Storage page
  Then the section shows "<line>" under Photos

  Examples:
    | holding                             | line                                               |
    | no photo originals                  | The library holds no photos yet.                   |
    | 3 photo originals of 12 MiB in all  | The library holds 3 photos, 12 MiB of originals.   |
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-114] A cloud operator saves a threshold change at once while the library holds no originals of that kind
  Given the library holds no photo originals
  When the cloud operator chooses 6000 px for Photos and clicks Save
  Then the section shows "Saved. Every device picks it up at its next sync."
  And no confirmation dialog appears
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-115] A cloud operator who changes a threshold over existing originals first learns that those originals keep their current copies
  Given the library holds photo originals
  When the cloud operator chooses 6000 px for Photos and clicks Save
  Then a dialog titled "Change the quality kept when originals archive?" says "Photos already in the library keep their current archived-quality copies. The new value applies to originals added from now on."
  And the change saves only after the cloud operator clicks Save in the dialog
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-116] A cloud operator saves a video resolution change without that explanation, because it changes no original
  Given the library holds video originals
  When the cloud operator changes the archived-quality resolution for Videos to 1440p and clicks Save
  Then the section shows "Saved. Every device picks it up at its next sync."
  And no confirmation dialog appears
```

### The install flow's quality step

- The consent dialog's quality step, including when it appears and for which apps: see APP-LIFE-023 in [app-lifecycle.md](app-lifecycle.md) (formerly RESIDENCY-117 and RESIDENCY-118).

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-119] A local operator who accepts the quality step's defaults leaves the library on the platform defaults
  Given the computer has no cloud
  And the local operator installs a photo app while the library holds no photo originals and nobody set the quality
  When the local operator clicks Approve & Install without changing the quality step
  Then the app installs
  And the Storage page shows the photo threshold at "4272 px (default)"
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-120] A cloud operator who sets the quality in the install step finds it the library's quality on every computer
  Given the cloud operator's computer syncs with a cloud, and the cloud operator is signed in to admin-web
  And the cloud operator installs a photo app while the library holds no photo originals and nobody set the quality
  When the cloud operator chooses 6000 px in the quality step and clicks Approve & Install
  Then the Storage page shows the photo threshold at 6000 px
  And the Storage page on the cloud operator's other computers on the same cloud shows 6000 px too
```

### Sync-down ceilings and Keep originals here

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-121] A local operator sees this computer's ceilings, what it holds against them, and the backlog
  Given the computer holds 2 GiB of photo originals and 500 MiB of photo stand-ins
  And the library holds 40 originals waiting for a canonical stand-in and 3 with no reported size
  When the local operator opens the Storage page
  Then the "Sync-down ceilings" table shows Photos with its ceiling, "2 GiB" originals here, and "500 MiB" stand-ins here
  And the "Backlog" list shows "40 waiting for a canonical stand-in" and "3 with no reported fidelity"
```

- **Notes:** A backlog count that stopped at its scanning limit reads "at least" before the number.

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-122] A local operator chooses a ceiling of none, a standard size, or the canonical size, for photos and videos only
  Given the local operator opens the Storage page
  When the local operator opens the ceiling menus
  Then the Photos menu offers "none — on demand only", 320, 640, 1280, 2560 px, and "4272 px (canonical)"
  And the Videos menu offers "none — on demand only", 2000 kbps, and "4800 kbps (canonical)"
  And the table has no other category
```

```gherkin
@local
@intent:confirmed @suboptimal
Scenario: [RESIDENCY-123] A local operator who saves ceilings sees the data server restart to apply them
  Given the local operator changed the Photos ceiling on the Storage page
  When the local operator clicks "Save ceilings"
  Then the section shows "Saved. The data server restarts to apply them."
  And the apps on the computer pause for a few seconds while the data server restarts
```

- **Suboptimal:** Apply new ceilings and "Keep originals here" without restarting the data server, by rebuilding the residency rules in place and rescanning.

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-125] A local operator who turns on "Keep originals here" sees roughly how much will download, and saves only that setting
  Given the library's photo and video originals weigh 3 GiB more than the computer holds
  When the local operator ticks "Keep every original on this machine"
  Then the section shows "About 3 GiB of originals to download."
  And after the local operator clicks Save, the ceilings on the page stay as they were
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-126] A local operator whose data server is not running sees why the Storage page shows no settings
  Given the local data server is not running
  When the local operator opens the Storage page
  Then the quality section shows "The local data server isn't running, so the library's settings can't be shown yet."
  And the ceilings section shows "The local data server isn't running, so there are no ceilings to show yet."
```

### Free up space

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-127] A local operator frees space only from an estimate, and the page reports what each step freed and kept
  Given the computer syncs with a cloud
  When the local operator opens "Free up space"
  Then the "Free up space" button is disabled
  And after the local operator clicks Estimate, the page shows a line such as "Would free 6 GiB from 2 file(s) of 7 GiB eligible. Kept 1 that the cloud could not yet be shown to hold." and the button turns on
  And after the local operator clicks "Free up space", the page shows a line that starts with "Freed" and the button turns off again
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [RESIDENCY-128] A local operator who changes the amount or the scope must estimate again
  Given the local operator estimated freeing 10 GiB from originals
  When the local operator changes <field>
  Then the estimate line disappears
  And the "Free up space" button is disabled until the local operator clicks Estimate again

  Examples:
    | field                                                       |
    | the GiB amount to 5                                         |
    | the scope to "originals and sizes above the ceiling"        |
```

```gherkin
@local
@intent:confirmed
Scenario: [RESIDENCY-129] A local operator on a computer with no cloud learns that nothing can be shown safe to remove
  Given the computer has no cloud
  When the local operator clicks Estimate in "Free up space"
  Then the page shows "This machine is not connected to a cloud, so nothing can be shown to be safe to remove."
  And every original still opens on the computer
```

### Reclaim deleted files

- The local operator permanently deletes items only from an estimate: see SHARED-196 in [shared-data.md](shared-data.md) (formerly RESIDENCY-130).
- The page says the computer does not know the trash window rather than reporting a clean run: see SHARED-197 (formerly RESIDENCY-131).
- The page names deleted files held in deep archive: see SHARED-198 (formerly RESIDENCY-132).
- The cloud operator changes how long deleted items are kept: see SHARED-199 (formerly RESIDENCY-133).
