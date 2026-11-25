# Sync

This file specifies how a member's library stays the same across the member's computers, phones, and the cloud. A member sees changes from one device appear on the others, keeps working through outages and restarts, and gets the library back from the cloud after clearing a computer. An app developer sees what an app receives on another device: records, metadata, labels, the app's own rows, and the platform's protocol version. A local operator clears a computer's local data and checks the computer's sync against the cloud with "Check sync integrity" on the admin-web Storage page. A local operator updates a computer and a cloud operator updates the cloud at different times, and the cloud operator reads the cloud's sync log. The scenarios state only what a user observes, so the clock, the watermarks, and the exchange rounds behind sync have no scenarios of their own.

Related files:

- [shared-data.md](shared-data.md): deletions, restores, and label retractions reaching other devices, and the answers an app receives for file URLs.
- [residency-and-stand-ins.md](residency-and-stand-ins.md): which file bytes each device keeps, and stand-ins.
- [uploads-and-file-bytes.md](uploads-and-file-bytes.md): uploads, upload order, large files, and files still awaiting upload.
- [users-and-access.md](users-and-access.md): signing a computer or phone in, the library belonging to one member, what each device's sign-in reaches, and a phone receiving only its app's types.
- [local-data-server.md](local-data-server.md): the events stream, watched folders, and the Clear local data dialog.
- [app-data.md](app-data.md): an app's own tables and rows, and the row and query APIs.
- [app-lifecycle.md](app-lifecycle.md): installing and updating apps, the update dialog's version-skew warning, and protocol-version refusals.

## Changes reaching other devices

### Records and files

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-001] A member's photo added on one computer appears on the member's other computer
  Given a member signed two computers in to the same deployment
  When the member adds a photo with Photos on the first computer
  Then Drive on the second computer lists the photo after the next sync
  And the photo opens on the second computer
```

```gherkin
@mobile @local @cloud
@intent:confirmed
Scenario: [SYNC-002] A member's photo taken on a phone appears on the member's computer
  Given a member signed Photos in on a phone and signed a computer in to the same deployment
  When the member takes a photo with the phone's camera
  Then Photos on the computer shows the photo after the phone and then the computer sync
```

- **Notes:** The phone receives only the types its app may read, which [users-and-access.md](users-and-access.md) owns (ACCESS-096). What the phone app adds to its own sync belongs to the Photos files in starkeep-apps.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-003] A member's record reaches the cloud and other devices even when the app that wrote it is not installed in the cloud
  Given a member has two signed-in computers, and Photos is installed on the first computer but not in the cloud
  When the member imports a photo with Photos on the first computer
  Then the member finds the photo in Drive in the cloud after the next sync
  And Drive on the member's second computer lists the photo after that computer's next sync
```

- **Notes:** Shared records always travel on Drive's channel, which every signed-in device runs whatever apps the cloud holds. The app's own rows are different: see SYNC-023 and SYNC-024.

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-004] A member sees on another computer, in a different app, a photo imported with Photos
  Given a member's first computer runs Photos
  And the member's second computer has no Photos, but runs another app that may read images
  When the member imports a photo with Photos on the first computer
  Then the other app on the second computer lists the photo after the next sync
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-005] A member who imports the same photo on two computers sees it once everywhere, and later changes keep syncing
  Given a member imported "beach.jpg" from one memory card on each of two computers while both were offline
  When the member brings both computers back online
  Then Drive on each computer lists "beach.jpg" once
  And a photo the member adds afterwards still reaches the other computer
```

- **Notes:** Two devices that capture the same bytes under the same name mint the same record. Two names for the same bytes are two records sharing one stored copy, which [shared-data.md](shared-data.md) owns (SHARED-184).

Behaviors owned elsewhere:

- A deletion reaching the member's other devices: SHARED-110 in [shared-data.md](shared-data.md).
- A restore winning over the earlier deletion: SHARED-122 in [shared-data.md](shared-data.md).
- A label retraction reaching the member's other devices: SHARED-082 in [shared-data.md](shared-data.md).
- A deletion or restore of a watched file made on another device: LDS-068 and LDS-069 in [local-data-server.md](local-data-server.md).
- An open app refreshing when a synced change arrives: LDS-087 in [local-data-server.md](local-data-server.md).
- Which file bytes each device downloads: RESIDENCY-001 to RESIDENCY-008 in [residency-and-stand-ins.md](residency-and-stand-ins.md).

### Metadata and labels

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-006] An app on another computer reads the metadata recorded with a photo
  Given an app developer's app runs on two of a member's computers
  When the app creates a photo on the first computer with a width of 4032 and a height of 3024
  Then the app on the second computer reads the width 4032 and the height 3024 for the photo after the next sync
  And the app reads the same metadata from the cloud
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-007] An app on another computer reads metadata written after the photo had already synced
  Given an app developer's app created a photo on a member's first computer without metadata
  And the photo already reached the cloud and the member's second computer
  When the app writes the photo's width and height on the first computer
  Then the app on the second computer reads the width and height after the next sync
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-008] An app keeps metadata that two computers recorded in different fields of one photo
  Given an app developer's app runs on two of a member's computers that hold the same photo
  When the app records the photo's width and height on the first computer, and its capture time on the second computer, before either syncs
  Then after both computers sync, the app reads the width, the height, and the capture time on both computers and in the cloud
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-009] An app on another computer reads a label set on the first computer
  Given an app developer's app declares the label key "reviewed" and runs on two of a member's computers
  When the app labels a photo "reviewed" on the first computer
  Then the app on the second computer finds the photo by the label "reviewed" after the next sync
```

- **Notes:** Label rules, including retractions and a label leaving the record's last-changed time alone (SHARED-061), belong to [shared-data.md](shared-data.md).

### How soon changes arrive

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-010] A member's change on one computer shows on the member's other computer within about half a minute
  Given a member's two computers are signed in, online, and idle
  When the member adds a document with an app on the first computer
  Then Drive on the second computer lists the document within about 30 seconds
```

- **Notes:** A local write nudges the computer's sync half a second later. An idle computer asks the cloud for changes every 30 seconds. A local operator can change both intervals with `pushDebounceMs` and `pullIntervalMs` in the computer's `config.json`. A large file adds its transfer time.

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-011] A member sees new files listed on a computer before their bytes finish downloading
  Given a member's two computers are signed in and online
  When the member adds 200 documents on the first computer
  Then Drive on the second computer lists all 200 documents before the last of their files finishes downloading
  And each document opens once its file arrives
```

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-012] A member sees small previews arrive while a large file is still downloading
  Given a member's two computers are signed in and online
  When the member adds a 2 GB document and 50 photos with previews on the first computer
  Then Photos on the second computer shows the 50 previews while the large document is still downloading
```

```gherkin
@mobile @local
@intent:confirmed
Scenario: [SYNC-013] A member sees a phone's new video, with its thumbnail, on the computer while the original is still uploading
  Given a member's phone runs Photos, and the member's computer is signed in
  When the member records a long video with Photos on the phone
  Then Photos on the member's computer shows the video's tile and thumbnail while the video's original is still uploading from the phone
```

- **Notes:** The upload order belongs to [uploads-and-file-bytes.md](uploads-and-file-bytes.md).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-014] A member's large library reaches a new computer completely without the member doing anything
  Given a member's cloud library holds 50,000 records
  When the member signs a new computer in and leaves the data server running
  Then Drive on the new computer eventually lists all 50,000 records
  And the member never has to start a sync by hand
```

- **Notes:** One sync round carries at most 1000 items and 25 MB of files, and the computer runs rounds back to back until nothing is left.

## Conflicting changes

Shared records change in place only through deletions and restores, which [shared-data.md](shared-data.md) owns, and through metadata (SYNC-008). The scenarios below use an app's own rows, where an app changes a row in place. [app-data.md](app-data.md) owns what an app's row write answers on one device, such as a write that loses to a newer stamp (APP-DATA-014) and a write that brings back a deleted row (APP-DATA-007).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-015] An app's row changed on two computers while both were offline settles on the later change everywhere
  Given an app developer's app runs on two of a member's computers and in the cloud
  And both computers are offline, and their clocks agree
  When the app sets a row's title to "Draft" on the first computer, and a minute later to "Final" on the second computer
  Then after both computers reconnect and sync, the app reads "Final" on both computers and in the cloud
```

- **Notes:** The change with the later stamp wins. A stamp follows the device's clock, so between two changes made without either device seeing the other, the device whose clock reads later wins. On an exact tie the device with the larger node id wins, so every device still settles on the same row.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-016] An app's change made after it received another device's change wins, even when this computer's clock runs behind
  Given an app developer's app runs on two of a member's computers
  And the first computer's clock runs ten minutes behind the second computer's clock
  And the first computer received the second computer's change to a row
  When the app changes the same row on the first computer
  Then after the next sync, the app reads the first computer's change on both computers and in the cloud
```

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-017] An app's change made right after the data server restarts still wins over the change it received before the stop
  Given an app developer's app runs on two of a member's computers
  And the second computer's clock runs ten minutes ahead of the first computer's clock
  And the first computer received the second computer's change to a row
  And the member then stopped and started the data server on the first computer
  When the app changes the same row on the first computer
  Then after the next sync, the app reads the first computer's change on both computers
```

- **Notes:** The data server writes its clock to disk at least every five seconds and again when it stops.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-018] An app's row edited on one computer after another computer deleted it comes back everywhere
  Given an app developer's app runs on two of a member's computers that have not synced for a while
  When the app deletes a row on the first computer, and later edits the same row on the second computer
  Then after both computers sync, the app reads the edited row on both computers and in the cloud
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-019] An app's row deleted on one computer after another computer edited it stays deleted everywhere
  Given an app developer's app runs on two of a member's computers that have not synced for a while
  When the app edits a row on the first computer, and later deletes the same row on the second computer
  Then after both computers sync, the row is gone from the app's reads on both computers and in the cloud
```

```gherkin
@local @cloud
@intent:confirmed @suboptimal
Scenario: [SYNC-020] An app's row edited in different columns on two computers keeps only the later row
  Given an app developer's app runs on two of a member's computers that have not synced for a while
  When the app renames a workout on the first computer, and later marks the same workout archived on the second computer
  Then after both computers sync, the app reads the workout archived under its old name on both computers and in the cloud
```

- **Suboptimal:** the earlier edit to a different column is lost on every device. Revisit keeping each column's latest edit. Until then, an app developer keeps fields that change independently in separate rows.
- **Notes:** A row travels whole, so the later row replaces every column of the earlier one, even columns the later change did not touch.

## An app's own data across devices

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-021] An app's rows written on one computer appear on the member's other computer that runs the app
  Given an app developer's app is installed on two of a member's computers and in the cloud
  When the app writes a row on the first computer
  Then the app on the second computer reads the row after the next sync
  And the app's cloud surface reads the row too
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-022] A member finds an app's data on a second computer once the app is installed there
  Given a member uses the example app on one computer, and the app is installed in the cloud
  And the local operator then installed the example app on the member's second computer, which did not have it
  When the member opens the example app on the second computer after the next sync
  Then the example app shows the member's notes
```

- **Notes:** An app's own rows reach only the devices where the app is installed. Rows written while the app was missing wait in the cloud.

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-023] A local operator's log names an app that is not installed in the cloud once, rather than on every retry
  Given the local operator installed the example app on a signed-in computer, and the app is not installed in the cloud
  When the local operator leaves the data server running for an hour
  Then the local operator finds in the data server's log, once, the line "[sync] app=example-app has no cloud half yet — the data server does not know it. Install it in the cloud to start syncing; retrying meanwhile with backoff."
  And the log shows no error stack for the example app
```

- **Notes:** [users-and-access.md](users-and-access.md) owns the cloud's refusal itself (ACCESS-081). Another kind of failure for the same app still logs in full each time.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-024] A member finds an app's rows from the computer in the cloud after the cloud operator installs the app there, without a restart
  Given a member's computer holds notes written with the example app, which the cloud did not have
  And the cloud operator then installs the example app in the cloud
  When the member opens the example app's cloud surface six minutes later
  Then the app shows the notes written on the computer
  And nobody restarted the computer's data server
```

- **Notes:** While the cloud refuses an app, the computer retries with a delay that doubles up to five minutes.

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-025] A member still receives photos on a computer where the local operator uninstalled an app
  Given the local operator uninstalled Photos on the second of a member's two computers, and the second computer runs Drive
  When the member adds a photo with Photos on the first computer
  Then Drive on the second computer lists the photo after the next sync
```

- **Notes:** Uninstalling stops only the app's own channel on that computer. Drive's channel, which carries every shared record, keeps running.

Behaviors owned elsewhere:

- A computer acting for an app installed in the cloud, and refused for one that is not: ACCESS-080 and ACCESS-081 in [users-and-access.md](users-and-access.md).
- A phone's private rows on its app's own channel: ACCESS-099 in [users-and-access.md](users-and-access.md).
- An app's private files opening offline on every computer it syncs to: RESIDENCY-003 in [residency-and-stand-ins.md](residency-and-stand-ins.md).
- Reinstalling an app after Delete data: APP-LIFE-148 in [app-lifecycle.md](app-lifecycle.md).

## When sync is interrupted

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-026] A member's changes made while the computer was offline reach the member's other computer after the network returns
  Given a member's computer lost its network connection
  And the member added documents with an app on the computer while it was offline
  When the member reconnects the computer to the network
  Then Drive on the member's other computer lists the documents after the next sync
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-027] A member's computer resumes syncing within five minutes after the cloud comes back, without a restart
  Given a member's computer kept running through an hour in which the cloud did not answer
  And the cloud now answers again
  When the member adds a document on another device
  Then the document reaches the computer within about five minutes
  And nobody restarted the computer's data server
```

- **Notes:** While sync fails, the computer retries with a delay that doubles up to five minutes, and the first success returns it to the usual 30-second rhythm.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-028] A member's sync cut off midway loses no change, and the next sync completes it
  Given a member labelled 20 photos with an app on a computer
  And the computer's network dropped while the computer was sending the labels
  When the member reconnects the computer to the network
  Then after the next sync, the app on the member's other computer shows all 20 photos labelled
```

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-029] A member whose computer restarts mid-sync gets the rest of the library without downloading the earlier part again
  Given a member's new computer is partway through its first sync of a large library
  When the member stops and starts the data server
  Then Drive on the computer goes on to list the whole library
  And the files that arrived before the restart are not downloaded again
```

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-030] A member still receives every other file when one file fails to download, and the file arrives on a later sync
  Given a member added ten documents on one computer
  And the first download of one document to the member's second computer failed
  When the member opens the documents in Drive on the second computer
  Then the other nine documents open
  And the tenth document opens after a later sync
```

Behaviors owned elsewhere:

- Signing a computer out and back in: ACCESS-068 and ACCESS-078 in [users-and-access.md](users-and-access.md).
- A member removed from the data group and added back: ACCESS-008 and ACCESS-009 in [users-and-access.md](users-and-access.md).
- A computer failing once to decide about one file's bytes: RESIDENCY-013 in [residency-and-stand-ins.md](residency-and-stand-ins.md).

## Getting the library back

[local-data-server.md](local-data-server.md) owns the Clear local data dialog and what the clear removes from the computer (LDS-091 to LDS-094, LDS-098). The clear keeps the computer's sign-in, and the library binds to the same member again (ACCESS-077, ACCESS-078 in [users-and-access.md](users-and-access.md)).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-031] A member who clears local data on a signed-in computer gets the library back from the cloud after starting the data server
  Given a member's signed-in computer synced the member's photos and documents to the cloud
  And the member cleared local data on the computer
  When the member starts the data server again
  Then Drive on the computer lists every photo and document again after the sync finishes
  And the member did not have to sign in again
```

- **Notes:** Which bytes come back with the records follows the computer's ceilings, as [residency-and-stand-ins.md](residency-and-stand-ins.md) states. Photo originals, for example, stay in the cloud until opened.

```gherkin
@local @cloud @mobile
@intent:confirmed
Scenario: [SYNC-032] A member keeps every photo in the cloud and on the phone after a local operator clears one computer
  Given a member's computer and phone both show the member's photos
  And a local operator cleared local data on the computer and started the data server again
  When the member opens Photos on the phone after its next sync, and Drive in the cloud
  Then Photos on the phone still shows every photo
  And Drive in the cloud still lists every photo
```

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-033] A local operator who clears local data with changes not yet in the cloud is warned first
  Given the local operator's computer is offline
  And a member added a document with an app on the computer while it was offline
  When the local operator chooses "Clear local data"
  Then the confirmation says that 1 change has not reached the cloud and that clearing loses it
  And the local operator can cancel and keep the document
```

- **Notes:** A local operator who confirms anyway loses the document on every device.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-034] A member finds an app's data again once the app is reinstalled after a clear
  Given a member used the example app on a computer, and the app is installed in the cloud
  And the local operator cleared local data on the computer, which also removed the app there
  And the local operator then installed the example app on the computer again
  When the member opens the example app on the computer after the next sync
  Then the example app shows the member's notes
```

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-035] A member sees each photo once after a local operator watches the same folder again following a clear
  Given a member's computer watched a photo folder whose photos synced to the cloud
  And a local operator cleared local data on the computer, started the data server again, and added the same folder as a watched folder again
  When the member opens Drive on the computer and on the member's other devices
  Then Drive on the computer lists each photo in the folder once
  And Drive on the member's other devices lists each photo once
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-036] A member's changes made after a clear reach the member's other devices
  Given the local operator cleared local data on a signed-in computer and started the data server again
  When the member adds a document with an app on the computer
  Then Drive on the member's other computer lists the document after the next sync
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-037] A member's cloud library refills from the computer after a cloud operator deleted it and added the member back
  Given a cloud operator took a member out of the data group and deleted the member's cloud data with the clear-user-cloud-data script
  And the cloud operator then added the member back to the data group
  And the member's computer, which still holds the library, stayed signed in and running
  When the member opens Photos in the cloud after the computer's next sync
  Then Photos shows the member's photos again, with their files
```

- **Notes:** The producing path is the cloud operator's `packages/admin-installer/scripts/clear-user-cloud-data.ts`, which [users-and-access.md](users-and-access.md) owns.

## Different versions on different devices

[app-lifecycle.md](app-lifecycle.md) owns the update dialog's warning, "Running different app versions might affect syncing behavior." (APP-LIFE-071, APP-LIFE-080), and the refusals of an app that needs a newer protocol (APP-LIFE-005, APP-LIFE-038, APP-LIFE-115, APP-LIFE-184). This section states what the skew does to sync.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-038] A local operator who updates a computer before the cloud sees the computer receive changes but send none until the cloud is redeployed
  Given the local operator updated a member's computer to a Starkeep build whose sync sends rows ahead of their files
  And the cloud still runs an older build that does not say which files it holds
  When the local operator starts the computer's data server
  Then the local operator finds in the computer's data server log the line "[sync] peer does not report a bytes watermark; pushing nothing until it does. Deploy the current cloud data server."
  And documents added on the member's other devices still reach the computer
  And documents added on the computer stay off the cloud until the cloud operator redeploys the cloud
```

- **Notes:** The producing path is a local operator running a newer build on a computer than the cloud runs. The computer asks once per cloud and keeps the answer, so it sends again after the redeploy.

```gherkin
@local @cloud
@intent:unclear
Scenario: [SYNC-040] An app's changes on a computer that runs a newer version wait for the cloud's update, while other devices' changes still arrive
  Given a member's computer runs a newer version of the example app than the cloud, and the new version adds a table
  When the member uses the new version's feature that fills the new table, and then edits a note on the computer
  Then the new rows and the note edit stay off the cloud and the member's other computers
  And the member finds in the data server's log the line "[sync] peer halted 1 author(s) this round:" followed by this computer's id
  And notes edited on the member's other computers still reach this computer
```

- **Notes:** The producing path is the update dialog with "Update Example App in the cloud" unchecked (APP-LIFE-080). Rows the app wrote on the computer before the first row of the new table still reach the cloud.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-041] An app's changes held back by an older cloud reach the cloud once the cloud operator updates the cloud's app, without a restart
  Given a member's computer holds example app changes that the cloud's older version of the app could not store
  And the cloud operator then updates the example app in the cloud
  When the member opens the example app's cloud surface a minute later
  Then the app shows every change made on the computer
  And nobody restarted the computer's data server
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-042] An app on a computer that runs an older version still receives the app's other rows from the cloud
  Given the cloud runs a newer version of the example app that adds a table, and a member's computer runs the older version
  When the member edits notes and fills the new table on another device
  Then the example app on the older computer shows the edited notes after the next sync
```

- **Notes:** The rows of the table the older computer does not know arrive once the computer runs the newer version.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-043] An app developer reads the platform's protocol version from either data server
  Given an app developer's app talks to a member's local data server and to the cloud data server
  When the app asks each data server for its health
  Then the app receives status "ok" and the protocol version "1.1.0" from each
```

- **Notes:** The version changes with the platform. A minor bump adds something an app can depend on, and a major bump breaks apps written for an earlier major version.

```gherkin
@cloud
@intent:confirmed
Scenario: [SYNC-044] A cloud operator's upgrade of an older deployment leaves devices syncing without sending their libraries again
  Given a deployment from before the cloud kept a per-device record of what it holds, with members' libraries already synced
  When the cloud operator redeploys the cloud with the current build
  Then members' devices go on syncing their new changes
  And the cloud's sync log shows no device sending its whole library again
```

- **Notes:** The deploy fills the cloud's per-device record from the rows it already holds, once per synced table.

## Check sync integrity

The local operator opens the Storage page from the Data Server card's menu in admin-web. The "Check sync integrity" section says "Compares what this machine holds against what the cloud holds, per app, and arms a repair the next sync carries out. Run it when something looks missing." and offers a "Check now" button. The check lists one line per sync channel this computer runs: `starkeep-drive` for Drive's channel, which carries every shared record and label, and one line per app installed on this computer.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-045] A local operator sees each sync channel's row counts here and in the cloud, and "agreed" when they match
  Given a local operator's computer and the cloud hold the same 120 shared records and labels and the same 40 example app rows
  When the local operator clicks "Check now" in "Check sync integrity"
  Then the section lists "starkeep-drive — 120 rows here, 120 in the cloud — agreed"
  And the section lists "example-app — 40 rows here, 40 in the cloud — agreed"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-046] A local operator learns that the cloud is missing records this computer holds
  Given the cloud lost one of the 120 records that a local operator's computer had synced
  And the computer has nothing left to send
  When the local operator clicks "Check now" in "Check sync integrity"
  Then the section lists "starkeep-drive — 120 rows here, 119 in the cloud — 1 the cloud is missing" in red
```

- **Notes:** No product path deletes rows from the cloud's database behind sync's back. The check exists for losses from defects or a cloud operator's direct database edits. What the "1" counts is SYNC-052.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-047] A local operator who checked again after the next sync sees the cloud's missing records put back
  Given a local operator's check reported "1 the cloud is missing" for Drive's channel
  When the local operator clicks "Check now" again after the computer's next sync
  Then the section lists "starkeep-drive — 120 rows here, 120 in the cloud — agreed"
```

- **Notes:** The check arms the repair, and the computer's ordinary sync carries it out, files included.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-048] A local operator learns that this computer is missing records the cloud holds
  Given a local operator's computer lost one of the 120 records it had received from the cloud
  And the cloud has nothing left to send the computer
  When the local operator clicks "Check now" in "Check sync integrity"
  Then the section lists "starkeep-drive — 119 rows here, 120 in the cloud — 1 missing here" in red
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-049] A local operator who checked again after the next sync sees this computer's missing records brought back
  Given a local operator's check reported "1 missing here" for Drive's channel
  When the local operator clicks "Check now" again after the computer's next sync
  Then the section lists "starkeep-drive — 120 rows here, 120 in the cloud — agreed"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-050] A local operator checking during a first sync sees work still to upload and download, not losses
  Given a local operator's computer is partway through syncing in both directions
  When the local operator clicks "Check now" in "Check sync integrity"
  Then Drive's line names the counts "still to upload" and "still to download"
  And the line is not red
  And the line does not say "the cloud is missing" or "missing here"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-051] A local operator sees how many files are still to upload even when the row counts match
  Given a local operator's computer has sent all 12,000 of its rows to the cloud, and more than 10,000 of their files are still uploading
  When the local operator clicks "Check now" in "Check sync integrity"
  Then the section lists "starkeep-drive — 12000 rows here, 12000 in the cloud — 10000+ files still to upload"
  And the line does not say "agreed"
```

- **Notes:** The count stops at 10,000 and then carries a "+". One file reads "1 file still to upload".

```gherkin
@local @cloud
@intent:unclear
Scenario: [SYNC-052] A local operator whose cloud lost 30 records from one day sees "1 the cloud is missing"
  Given the cloud lost 30 records that a local operator's computer had synced, all written on the same day
  When the local operator clicks "Check now" in "Check sync integrity"
  Then Drive's line says "1 the cloud is missing"
```

- **Notes:** The check compares counts per device and per span of about three days, and the number in "the cloud is missing" and "missing here" counts the spans that disagree.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-053] A local operator whose cloud cannot answer the check is told so, not told that everything agrees
  Given the cloud runs an older build that cannot answer the integrity check
  When the local operator clicks "Check now" in "Check sync integrity"
  Then each channel's line says "the cloud did not answer the check"
  And no line says "agreed"
```

- **Notes:** The producing path is a cloud operator running an older build in the cloud than the computer runs.

```gherkin
@local @cloud
@intent:unclear
Scenario: [SYNC-054] A local operator whose app differs in version between this computer and the cloud sees the check skipped for that app
  Given the example app on a local operator's computer declares a table that the cloud's version of the app does not
  When the local operator clicks "Check now" in "Check sync integrity"
  Then the example app's line says "the cloud did not answer the check"
  And Drive's line still reports its counts
```

- **Notes:** The producing path is the update dialog with "Update Example App in the cloud" unchecked (APP-LIFE-080).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-055] A local operator still finds a lost record when the cloud runs an older build
  Given the cloud runs an older build that answers the check without naming its tables
  And the cloud lost a record that the local operator's computer had synced
  When the local operator clicks "Check now" in "Check sync integrity"
  Then Drive's line says "1 the cloud is missing" in red
```

- **Notes:** Against such a cloud the check cannot tell apart a record lost in one table and an extra row gained in another table of the same channel.

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-056] A local operator on a signed-out computer learns that no sync channels are running
  Given a local operator's computer joined a cloud but is signed out
  When the local operator clicks "Check now" in "Check sync integrity"
  Then the section says "No sync channels are running on this machine."
```

```gherkin
@local
@intent:unclear
Scenario: [SYNC-057] A local operator on a computer with no cloud sees "sync not configured"
  Given a local operator's computer has no cloud
  When the local operator clicks "Check now" in "Check sync integrity"
  Then the section says "sync not configured" in red
```

```gherkin
@local @cloud
@intent:unclear
Scenario: [SYNC-058] A local operator sees one channel's error while the other channels still report
  Given a local operator installed the example app on the computer but not in the cloud
  When the local operator clicks "Check now" in "Check sync integrity"
  Then the example app's line shows, in red, the cloud's refusal, starting "/sync/exchange failed: 401"
  And Drive's line still reports its counts
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-059] A local operator who checks during a running sync gets the answer after that sync finishes
  Given a local operator's computer is in the middle of a sync that is bringing down 500 records
  When the local operator clicks "Check now" in "Check sync integrity"
  Then the button reads "Checking…" and is disabled until the answer arrives
  And the answer counts the 500 records as already here
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-060] A local operator's repair still happens after the data server restarts before the next sync
  Given a local operator's check reported "1 missing here" for Drive's channel
  And the local operator stopped and started the data server before the computer synced again
  When the local operator clicks "Check now" again after the computer's next sync
  Then Drive's line says "agreed"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [SYNC-061] A local operator who checks again during a long repair does not restart it
  Given a local operator's check found this computer missing records across many months of the library
  And the computer's sync is partway through bringing them back
  When the local operator clicks "Check now" again
  Then Drive's line reports the rest as "still to download", not as "missing here"
  And a later check says "agreed" once the computer has finished
```

## What the logs show

```gherkin
@local
@intent:confirmed
Scenario: [SYNC-062] A member reads in the data server's log when each sync round moved something, in local time
  Given a member's computer is signed in and syncing
  When the member adds a photo on another device and reads the computer's data server log after the next sync
  Then the log holds a line such as "2026-11-23T14:05:03.123+01:00 [sync] app=starkeep-drive round=1 elapsedMs=812 applied=1 landed=1 landedBytes=48211 elided=0 shipped=0 blocked=0 hasMore=false outboundHasMore=false bytesHasMore=false"
  And the log holds no such line for the idle rounds every 30 seconds
```

- **Notes:** Every line the data server writes starts with the computer's local time and its offset from UTC.

```gherkin
@cloud
@intent:confirmed
Scenario: [SYNC-063] A cloud operator finds one log line per sync exchange in the cloud's logs, naming the device and the counts
  Given a member's signed-in computer syncs with the deployment
  When the cloud operator opens the cloud data server's logs in CloudWatch
  Then each exchange appears as one JSON line with "event" set to "sync-exchange"
  And the line names the channel's app, the caller as a device or a phone app, the records, labels, and app rows in each direction, and how long the exchange took
```
