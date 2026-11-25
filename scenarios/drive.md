# Drive

This file specifies Starkeep Drive, the built-in app that shows a member every file in the member's library, whichever app added it. Drive runs only on a member's computer, and it reads the cloud through that computer's sign-in. The local operator starts and stops Drive from its card on admin-web's Dashboard. The member uses the Drive page itself: the library, the Trash, the share dialog, and the Links view. The cloud operator uses the "Enable sharing" switch on Drive's card, which runs with the cloud operator's AWS credentials, and sees what the deployment holds for Drive in the cloud. Scenarios that need the cloud carry both `@local` and `@cloud`, because the Drive page runs on the computer while its answers come from the cloud.

Related files:

- [cloud-setup.md](cloud-setup.md): the deploy's Drive pass, and removing Drive at teardown
- [users-and-access.md](users-and-access.md): Drive's reach over every type, the computer's read of the cloud's records, and the rule that local surfaces stay on this computer
- [local-data-server.md](local-data-server.md): the data server Drive reads through, watched folders, and running a second instance
- [shared-data.md](shared-data.md): records and types, deletion, the trash window and restore, and what a public link serves a visitor
- [residency-and-stand-ins.md](residency-and-stand-ins.md): which file bytes a computer keeps after a file is opened
- [sync.md](sync.md): what travels on Drive's channel between a member's devices and the cloud
- [app-lifecycle.md](app-lifecycle.md): installed apps' start, stop, and ports, and records that outlive an uninstall
- [app-data.md](app-data.md): an app's own rows, which Drive never reads

## Drive's card in admin-web

Drive's card sits on admin-web's Dashboard beside the Data Server card. The card is named "Starkeep Drive", says "File browser and shared-data UI, installed with the core.", and carries the badge "Built-in".

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-001] A local operator starts Drive from its card and opens it in a new tab
  Given Drive's card shows "Stopped" and the button "Start Drive"
  When the local operator presses "Start Drive"
  Then the button reads "Starting Drive…" with a spinner while Drive starts
  And the card shows "Running" and the button "Open Drive ↗" once Drive answers
  And pressing "Open Drive ↗" opens the Drive page, headed "Starkeep Drive", in a new browser tab
```

- **Notes:** the card checks Drive's address once a second for up to 20 seconds after Start.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-002] A local operator sees on Drive's card whether Drive is running
  Given Drive is running on the local operator's computer
  When the local operator opens admin-web's Dashboard
  Then Drive's card shows "Running" beside "Built-in"
  And after Drive stops, the card shows "Stopped" on the local operator's next visit to the Dashboard
```

- **Notes:** the card checks Drive's address when the Dashboard loads and after the local operator's own Start or Stop. A Drive stopped from a terminal shows "Stopped" only after the Dashboard reloads.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-003] A local operator stops Drive from its card
  Given Drive's card shows "Running"
  When the local operator chooses "Stop" from the card's menu, "More actions for Starkeep Drive"
  Then the menu item reads "Stopping…" while Drive stops
  And the card shows "Stopped" and the button "Start Drive"
  And the Drive tab no longer loads
```

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-004] A local operator whose Drive exits during startup sees why on the card
  Given Drive exits during startup on the local operator's computer
  When the local operator presses "Start Drive"
  Then Drive's card says "'drive' exited during startup."
  And the card shows the last lines of Drive's log and names the log file
  And the card stops showing a spinner
```

- **Notes:** Implementation gap: the card ignores Start's answer, so the local operator sees "Starting Drive…" for 20 seconds and then "Stopped" with no message. LDS-015 in [local-data-server.md](local-data-server.md) states the same outcome for the Data Server card.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-072] A local operator whose Drive port is taken by another program learns which program holds it
  Given another program on the local operator's computer listens on Drive's port, 9830 by default
  When the local operator presses "Start Drive"
  Then Drive's card says "Port 9830 is already in use by pid <pid> (<command>), which does not look like a Starkeep daemon. Stop that process, then start 'drive' again."
  And the card stops showing a spinner
```

- **Notes:** Implementation gap: the card ignores Start's answer, so the local operator sees "Starting Drive…" for 20 seconds and then "Stopped" with no message. The port in the message follows `STARKEEP_DRIVE_PORT`.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-005] A local operator opens Drive after the first Start although Drive was never built
  Given the local operator's Starkeep checkout has never built Drive's page
  When the local operator presses "Start Drive"
  Then Drive's card shows "Running" once Drive has built its page and started
  And "Open Drive ↗" opens a working Drive page
```

- **Notes:** Drive's log shows "drive: dist/ is missing, running `vite build`…" before it starts listening. A build that takes longer than the card's 20-second check leaves the card at "Stopped" until the Dashboard reloads.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-006] A local operator running a second Starkeep instance opens that instance's own Drive and library
  Given the local operator runs a second instance with its own `STARKEEP_DIR`, `STARKEEP_PORT`, and `STARKEEP_DRIVE_PORT`
  And each instance's library holds different files
  When the local operator presses "Open Drive ↗" on the second instance's admin-web
  Then Drive opens on the second instance's Drive port
  And Drive lists the second instance's files and none of the first instance's
```

- **Notes:** admin-web passes its environment to Drive, so Drive listens on `STARKEEP_DRIVE_PORT` and reads the data server on `STARKEEP_PORT`. LDS-082 in [local-data-server.md](local-data-server.md) owns the second instance's own data server.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-007] A local operator who updates Drive sees the new version after a restart without clearing the browser's cache
  Given the local operator opened Drive in a browser
  And the local operator then pulled a Starkeep update and ran `pnpm install`, as the upgrade steps say
  When the local operator restarts Drive and reloads the Drive tab
  Then the Drive tab shows the updated Drive page
```

- **Notes:** the page itself always revalidates, and only Drive's content-named build files are cached for good. `pnpm install` rebuilds Drive's page. Drive builds its page at start only when no build exists, so a pull without the install leaves the old page in place.

Drive answers only on this computer's loopback address and refuses a write that another site's page sent. ACCESS-168, ACCESS-170, and ACCESS-171 in [users-and-access.md](users-and-access.md) own those rules for every local surface. Drive's refusals read "Drive answers on its loopback address only" and "Drive refuses requests from other sites".

## Drive's sharing switch

Drive's card carries the "Enable sharing" switch that decides whether Drive may create public links. SHARED-140, SHARED-141, and SHARED-142 in [shared-data.md](shared-data.md) own what the switch permits. This section owns how the switch appears on the card. The switch reads and writes a setting in the cloud with the cloud operator's AWS credentials, so the cloud operator uses it.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-008] A cloud operator sees Drive's "Enable sharing" switch only once the cloud is deployed
  Given the cloud operator deployed the cloud from this computer
  When the cloud operator opens admin-web's Dashboard
  Then Drive's card shows an "Enable sharing" checkbox
  And on a computer with no cloud, Drive's card shows no such checkbox
```

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-009] A cloud operator who signs in with cloud operator rights sees whether sharing is on and can change it
  Given the cloud operator deployed the cloud from this computer and is not signed in with cloud operator rights
  When the cloud operator signs in on admin-web's Dashboard with an account that has cloud operator rights
  Then Drive's "Enable sharing" checkbox shows whether sharing is on and can be changed
  And hovering over the checkbox shows "Lets Drive create public links to any file, including photo and video originals. Turning it off stops Drive's existing links."
```

- **Notes:** the checkbox stays greyed out until the cloud has answered. The checkbox is also greyed out while a change is saving. DRIVE-076 states what the checkbox looks like before the sign-in.

```gherkin
@local
@intent:unclear
Scenario: [DRIVE-076] A cloud operator who has not signed in with cloud operator rights sees the sharing switch unchecked and greyed out
  Given the cloud operator deployed the cloud from this computer and is not signed in with cloud operator rights
  When the cloud operator opens admin-web's Dashboard
  Then Drive's "Enable sharing" checkbox is unchecked and greyed out
```

- **Notes:** Drive's card does not read the setting until the sign-in with cloud operator rights, so the unchecked box says nothing about whether sharing is on.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-010] A cloud operator sees why the switch could not be read or changed
  Given the cloud operator is signed in with cloud operator rights on the computer that deployed the cloud
  And the cloud cannot be reached
  When the cloud operator opens admin-web's Dashboard
  Then Drive's card shows the reason in red under the "Enable sharing" checkbox
  And the checkbox stays greyed out
```

- **Notes:** the reason is the failing step's own message, such as "Not signed in. Sign in from the dashboard first." when the sign-in with cloud operator rights has ended. A failed change leaves the checkbox at the state the cloud last confirmed.

```gherkin
@local
@intent:unclear
Scenario: [DRIVE-011] A local operator on a joined computer learns where Drive's sharing switch can be changed
  Given the local operator's computer joined a cloud that another computer deployed
  When the local operator opens admin-web's Dashboard
  Then Drive's card shows the "Enable sharing" checkbox greyed out
  And the card says that only the computer that deployed the cloud can change it
```

- **Notes:** Implementation gap: the card shows the greyed-out checkbox with no explanation. A joined computer offers no sign-in with cloud operator rights, so the checkbox can never be used there.

## The library

The Drive page opens on its Library view, under the heading "Starkeep Drive" and the line "Everything you own across all your apps — including data from apps that aren't cloud-installed. Each row shows whether it lives only on this device, only in the cloud, or is synced to both. The Trash lists what you have deleted, when each item goes for good, and lets you put one back. Links lists the files you have shared with a public link." Three buttons switch between the "Library", "Trash", and "Links" views. Drive shows every type, including files no other app can see (SHARED-004 in [shared-data.md](shared-data.md)), and never shows an app's own rows (APP-DATA-005 in [app-data.md](app-data.md)).

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-012] A member sees each file in the library with its sync state, category, type, name, origin app, size, and last change
  Given the member imported a 2.4 MB photo named "beach.jpg" with Photos on this computer
  When the member opens Drive
  Then the library table has the columns "Sync", "Category", "Type", "Name", "From (origin app)", "Size", and "Updated"
  And the photo's row shows its sync state, "image", "image/jpeg", "beach.jpg", "photos", "2.4 MB", and the time of its last change in the browser's local format
  And the row ends with a "Share link…" button
```

- **Notes:** a file with no name shows its record id in the Name column. A missing size, category, or type shows "—".

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-013] A member sees the most recently changed files first
  Given the member added "old.txt" last week and "new.txt" today
  When the member opens Drive
  Then "new.txt" appears above "old.txt" in the library table
```

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-014] A member filters the library by type, and All shows every file again
  Given the member's library holds 12 JPEG photos and 3 PDF documents
  When the member presses the "image/jpeg (12)" button above the table
  Then the table lists only the 12 photos
  And pressing "All" lists all 15 files again
  And the type buttons appear in order of their counts, largest first
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-015] A member sees a type button for a type that only the cloud holds
  Given the member's computer is signed in to the member's cloud
  And the member's cloud holds 4 PDF documents that have not reached this computer yet
  And this computer holds no PDF documents
  When the member opens Drive on this computer
  Then Drive offers a "document/pdf (4)" button
  And pressing it lists the 4 documents
```

- **Notes:** when this computer and the cloud both hold a type, the button shows the larger of the two counts.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-016] A member with no files reads "No shared records yet."
  Given the member's library holds no files
  When the member opens Drive
  Then the Library view says "No shared records yet."
```

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-017] A member with more than 500 files can reach every file in Drive
  Given the member's library holds 800 files
  When the member opens Drive
  Then the member can reach every one of the 800 files in the Library view
  And the most recently changed files are among the first the member sees
```

- **Notes:** Implementation gap: Drive asks for one page of 1,000 records, the data server caps a page at 500, and Drive never asks for the next page. The 500 rows follow record ids, not dates, so recent files can be missing while the type buttons still count all 800. The same cut applies to the cloud's list, so a file beyond one side's cut can show the wrong sync state.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-018] A member sees a file added in another app appear in Drive without reloading
  Given the member has Drive open on the Library view
  When the member imports a photo with Photos
  Then the photo's row appears in Drive within a few seconds
  And the table does not flash "Loading…" while it updates
```

- **Notes:** any change to the library refreshes the view on screen: a file added to a watched folder, a file that arrives from another device, or a restore.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-019] A member sees a file deleted in another app leave the library without reloading
  Given the member has Drive open on the Library view, listing "notes.txt"
  When the member deletes "notes.txt" in another app
  Then the row for "notes.txt" leaves Drive's table within a few seconds
  And the file appears in Drive's Trash view
```

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-020] A member sees an open Drive keep updating after the data server restarts
  Given the member has Drive open on the Library view
  And the local operator restarted the data server from admin-web
  When the member imports a photo with Photos after the data server is running again
  Then the photo's row appears in Drive without a reload
```

- **Notes:** Implementation gap: when the data server is still down at the browser's reconnect, Drive answers the reconnect with an error, and the browser then closes the live connection for good. New files appear only after the member reloads the page.

## When the data server is not running

Drive reads the library through the computer's data server, so Drive shows nothing without it.

```gherkin
@local
@intent:unclear
Scenario Outline: [DRIVE-021] A member whose data server is stopped or has never run learns from Drive that the data server must be started
  Given Drive is running on the member's computer
  And the computer's data server <state>
  When the member opens Drive
  Then Drive says that the data server is not running and names admin-web's Data Server card as the place to start it
  And Drive shows no library table

  Examples:
    | state                             |
    | is stopped                        |
    | has never run on this computer    |
```

- **Notes:** Implementation gap: Drive shows "Couldn't load records: fetch failed" for a stopped data server, and "Couldn't load records: Starkeep Drive is not installed locally (no hmac_secret in the local-data-server registry). Is the local-data-server running?" when the data server has never run. A member reaches the second state by starting Drive before the data server on a new computer.

## Where each file lives

Each library row's Sync column compares this computer's copy of the file with the cloud's. A computer that is signed in reads the cloud's list for Drive (ACCESS-067 in [users-and-access.md](users-and-access.md)). What travels between devices belongs to [sync.md](sync.md), for example SYNC-001 and SYNC-003.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-023] A member sees "Local only" on a file the cloud does not hold yet
  Given the member's computer is signed in to the member's cloud
  And the member added "report.pdf" on this computer, and the file has not reached the cloud yet
  When the member opens Drive
  Then the row for "report.pdf" shows "Local only"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-024] A member sees "Synced" on a file that this computer and the cloud both hold
  Given the member's computer is signed in to the member's cloud
  And "report.pdf" has reached the cloud since the member added it on this computer
  When the member opens Drive
  Then the row for "report.pdf" shows "Synced"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-025] A member sees "Modified locally" on a file whose latest change has not reached the cloud
  Given the member's computer is signed in to the member's cloud
  And a photo had reached the cloud before Photos made a new preview of it on this computer
  And that change has not reached the cloud yet
  When the member opens Drive
  Then the photo's row shows "Modified locally"
  And after the change reaches the cloud, the member's next visit to Drive shows "Synced" on the photo's row
```

- **Notes:** a file whose copy on this computer is behind the cloud's shows "Synced", because nothing on this computer waits to go up.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-026] A member sees "Cloud only" on a file that is not on this computer
  Given the member's computer is signed in to the member's cloud
  And the member added "plan.md" on another computer, and the file has reached the cloud but not this computer
  When the member opens Drive on this computer
  Then the row for "plan.md" shows "Cloud only"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [DRIVE-027] A member sees "Archived" or "Restoring" beside a file whose cloud original is archived or coming back from the archive
  Given the member's computer is signed in to the member's cloud
  And the cloud's original of a large photo <archive state>
  When the member opens Drive
  Then the photo's row shows its sync state and the badge "<badge>" beside it

  Examples:
    | archive state                    | badge     |
    | sits in the archive              | Archived  |
    | is coming back from the archive  | Restoring |
```

- **Notes:** [residency-and-stand-ins.md](residency-and-stand-ins.md) owns when an original archives, and SHARED-133 and SHARED-134 in [shared-data.md](shared-data.md) own bringing one back.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-028] A member whose computer is not signed in reads why Drive shows local data only
  Given the member's computer has a cloud but is signed out of it
  When the member opens Drive
  Then Drive shows "Showing local data only — cloud view unavailable: This machine is not signed in to the cloud yet — sign in from admin-web"
  And the library still lists the files on this computer
```

```gherkin
@local
@intent:unclear
Scenario: [DRIVE-029] A member with no cloud sees no warning about the cloud
  Given the member uses Starkeep on this computer without any cloud
  When the member opens Drive
  Then Drive shows the library with no warning about a cloud
```

- **Notes:** Implementation gap: Drive shows "Showing local data only — cloud view unavailable: Cloud is not configured (no apiGatewayUrl / STARKEEP_CLOUD_URL)" on every visit.

```gherkin
@local @cloud
@intent:unclear
Scenario: [DRIVE-030] A member whose cloud cannot be reached sees that each file's cloud state is unknown
  Given the member's computer is signed in to the member's cloud
  And "report.pdf" reached the cloud last week
  And the cloud cannot be reached right now
  When the member opens Drive
  Then Drive shows "Showing local data only — cloud view unavailable:" followed by the reason
  And the row for "report.pdf" says that its cloud state is unknown rather than "Local only"
```

- **Notes:** Implementation gap: every row shows "Local only" while the cloud cannot be reached, including files the cloud holds. The same happens on a signed-out computer (DRIVE-028).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-031] A member opens a file of a type no app recognizes on the member's other computer
  Given the member signed two computers in to the member's cloud
  And the member added "notes.xyz" to a watched folder on the first computer
  And both computers have synced since
  When the member opens Drive on the second computer
  Then the row for "notes.xyz" shows "Synced" with the type "other/other"
  And opening "notes.xyz" from its name downloads the file's own bytes under that name
```

- **Notes:** Implementation gap: Drive syncs image and markdown files, but a file of a type no app recognizes does not reach the cloud. The maintainer tracks this as a known limitation to fix. SHARED-004 in [shared-data.md](shared-data.md) owns the type itself.

## Opening a file

A file's name in the library is a link when Drive can fetch the file's bytes through this computer. The link opens the file in a new browser tab. What stays on the computer afterwards belongs to [residency-and-stand-ins.md](residency-and-stand-ins.md), and what an app receives for the same read is SHARED-091 in [shared-data.md](shared-data.md).

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-032] A member opens a file on this computer from its name in Drive
  Given the member's library holds "beach.jpg" on this computer
  When the member presses "beach.jpg" in Drive's Name column
  Then the photo opens in a new browser tab
```

- **Notes:** a record with no attached file shows its name as plain text.

```gherkin
@local
@intent:confirmed
Scenario Outline: [DRIVE-033] A member sees a photo, PDF, or text file opened in the browser as its own kind
  Given the member's library holds "<file>" of type <type> on this computer
  When the member presses "<file>" in Drive's Name column
  Then the browser shows <shown>

  Examples:
    | file         | type         | shown                       |
    | beach.jpg    | image/jpeg   | the photo                   |
    | paper.pdf    | document/pdf | the PDF in its viewer       |
    | notes.txt    | text/txt     | the text                    |
    | config.yaml  | text/yaml    | the text                    |
```

- **Notes:** Drive picks how the browser shows the file from the file's Starkeep type, so a file added from a watched folder, which carries no declared media type, still opens as its own kind.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-073] A member gets a file that the browser cannot show as a download under its own name
  Given the member's library holds "backup.xyz" on this computer
  When the member presses "backup.xyz" in Drive's Name column
  Then the browser saves the file as "backup.xyz"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-034] A member opens a synced file whose bytes are only in the cloud
  Given the member freed up space on this computer, so the original of "beach.jpg" is only in the cloud
  When the member presses "beach.jpg" in Drive's Name column
  Then the photo opens in a new browser tab
```

- **Notes:** RESIDENCY-027 in [residency-and-stand-ins.md](residency-and-stand-ins.md) owns the original staying on the computer after this read.

```gherkin
@local @cloud
@intent:unclear
Scenario: [DRIVE-035] A member learns why a "Cloud only" file cannot be opened from Drive yet
  Given the member's computer is signed in to the member's cloud
  And "plan.md" shows "Cloud only" in Drive
  When the member hovers over "plan.md" in Drive's Name column
  Then the name is not a link
  And Drive says that the file has not reached this computer yet
```

- **Notes:** Implementation gap: the name is plain text with no explanation.

```gherkin
@local
@intent:unclear
Scenario: [DRIVE-036] A member who opens an HTML or SVG file from Drive gets a download, so the file's script never runs inside Drive
  Given the member's library holds "page.html" and "drawing.svg" on this computer
  When the member presses either name in Drive's Name column
  Then the browser saves the file under its own name instead of opening it
```

- **Notes:** Implementation gap: Drive serves an HTML file as a web page and an SVG file as an image, both on Drive's own address. A script inside such a file can then read the library and create public links through Drive. SHARED-168 in [shared-data.md](shared-data.md) states the download rule for public links.

```gherkin
@local
@intent:unclear
Scenario: [DRIVE-037] A member whose file's bytes cannot be fetched reads why in plain words
  Given the member removed a file from a watched folder before the file finished uploading to the cloud
  And the file's row still shows in Drive's library
  When the member presses the file's name
  Then the new tab says that the file's bytes are not on this computer and could not be fetched from the cloud
```

- **Notes:** Implementation gap: the new tab shows raw text such as `local-data-server /data/records/<id>/file-url → 502 Bad Gateway {"error":"File not on this node, and the fetch from the cloud failed"}`.

## The Trash

The "Trash" button switches Drive to the files the member deleted. The trash window, the restore itself, and reclaiming belong to [shared-data.md](shared-data.md): SHARED-107, SHARED-110, SHARED-114 to SHARED-117, SHARED-120, SHARED-122, SHARED-124, SHARED-199, and SHARED-200.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-038] A member sees deleted files, the most recent deletion first, with when each goes for good
  Given the member deleted "draft.txt" last week and "photo.jpg" an hour ago
  When the member opens Drive's Trash view
  Then the Trash table has the columns "Category", "Type", "Name", "Size", "Deleted", and "Goes for good"
  And "photo.jpg" appears above "draft.txt"
  And each row shows when the file was deleted, when it goes for good, and a "Restore" button
  And hovering over a "Goes for good" value shows its exact date and time
```

- **Notes:** the Trash has no column for where a file sat, because a file's folder is known only to the computer that watched it.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-039] A member reads how long a deleted file is kept
  Given the trash window is 30 days
  When the member opens Drive's Trash view
  Then the Trash says "A deleted item is kept for 30 days, then it is permanently deleted. Restoring it before then brings it back whole."
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [DRIVE-040] A member sees "in 12 days", "tomorrow", or "any time now" as a deleted file's time runs out
  Given the trash window is 30 days
  And the member deleted "notes.txt" <when>
  When the member opens Drive's Trash view
  Then the row for "notes.txt" shows "<goes for good>" under "Goes for good"

  Examples:
    | when            | goes for good |
    | 18 days ago     | in 12 days    |
    | 29 days ago     | tomorrow      |
    | 31 days ago     | any time now  |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-041] A member whose computer cannot read the deployment's settings sees "unknown" and why
  Given the member's computer cannot read the deployment's settings
  And the member deleted "notes.txt"
  When the member opens Drive's Trash view
  Then the Trash says "This machine cannot read the deployment's settings, so it does not know how long a deleted item is kept. Nothing will be permanently deleted until it can."
  And the row for "notes.txt" shows "unknown" under "Goes for good"
```

- **Notes:** SHARED-115 and SHARED-126 in [shared-data.md](shared-data.md) own the unknown window itself.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-042] A member with nothing deleted reads "Nothing deleted."
  Given the member has deleted nothing
  When the member opens Drive's Trash view
  Then the Trash says "Nothing deleted."
```

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-043] A member restores a deleted file and finds it in the library again
  Given the member deleted "notes.txt" inside the trash window
  When the member presses "Restore" on the row for "notes.txt" in Drive's Trash view
  Then the button reads "Restoring…" and every other "Restore" button is greyed out until the restore finishes
  And "notes.txt" leaves the Trash
  And the Library view lists "notes.txt" again
```

- **Notes:** SHARED-116 owns what the restore brings back with the file, such as its stand-ins and labels.

```gherkin
@local
@intent:unclear
Scenario: [DRIVE-044] A member whose restore is refused reads why, and the Trash stays on screen
  Given the member has Drive's Trash view open, listing "notes.txt"
  And the member restored "notes.txt" in another app a moment before Drive's Trash could refresh
  When the member presses "Restore" on the row for "notes.txt"
  Then Drive says that "notes.txt" could not be restored, and why
  And the Trash table stays on screen
```

- **Notes:** Implementation gap: Drive shows "Couldn't load records:" followed by the refusal and hides the Trash table until the member switches views. SHARED-117 owns the refusal of a restore of a live record.

```gherkin
@local
@intent:confirmed
Scenario: [DRIVE-045] A member with more than 500 deleted files can reach every one in the Trash
  Given the member deleted 800 files within the trash window
  When the member opens Drive's Trash view
  Then the member can reach every one of the 800 files in the Trash
  And the most recent deletions are among the first the member sees
```

- **Notes:** Implementation gap: Drive asks for one page of deleted records, the data server caps a page at 500 in record-id order, and Drive never asks for the next page. DRIVE-017 states the same limit for the library.

## Sharing a file with a public link

Each library row's "Share link…" button opens Drive's share dialog, headed "Share link". A Drive link is a direct link to one file: anyone holding it gets the file with no page around it. What a link serves a visitor belongs to [shared-data.md](shared-data.md): SHARED-163 to SHARED-168 and SHARED-173 to SHARED-176. Whether Drive may make links at all is the switch in SHARED-140 to SHARED-142.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-046] A member can share a file that the cloud holds
  Given the member's computer is signed in to the member's cloud, and Drive's sharing switch is on
  And "report.pdf" shows "Synced" or "Cloud only" in Drive
  When the member presses "Share link…" on the row for "report.pdf"
  Then the "Share link" dialog opens
  And its "Title" field holds "report.pdf" and its "Link expires" choice reads "30 days"
  And the dialog offers "Cancel" and "Create link"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [DRIVE-047] A member sees why a file not yet in the cloud cannot be shared
  Given the member's computer is signed in to the member's cloud
  And a file's row shows "<sync state>" in Drive
  When the member hovers over the row's "Share link…" button
  Then the button is greyed out
  And Drive shows "<reason>"

  Examples:
    | sync state       | reason                                                 |
    | Local only       | This file is not in the cloud yet.                     |
    | Modified locally | This file has changes that are not in the cloud yet.   |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-048] A member whose computer cannot reach the cloud's links sees why no file can be shared
  Given the member's computer has a cloud but is signed out of it
  When the member hovers over any row's "Share link…" button in Drive
  Then the button is greyed out
  And Drive shows "This machine is not signed in to the cloud yet — sign in from admin-web"
```

- **Notes:** any reason the links cannot be listed greys out every row's button, with that reason on hover.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-049] A member shares a photo's largest stand-in by default and reads what a visitor sees
  Given the member's photo "beach.jpg" shows "Synced", and the cloud holds a stand-in for it
  When the member opens the photo's "Share link" dialog
  Then the dialog offers a "Share" choice between "Largest stand-in" and "Original"
  And "Largest stand-in" is chosen, with the text "Anyone with the link can see this at display size, with no location or camera details."
  And after the member presses "Create link", Drive's Links view lists the new link with "Stand-in" under "Shares"
```

- **Notes:** SHARED-163 in [shared-data.md](shared-data.md) owns what the visitor receives.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-050] A member chooses to share a photo's original and reads that its location and camera details go with it
  Given the member opened the "Share link" dialog for a photo that has a stand-in in the cloud
  When the member chooses "Original"
  Then the dialog shows "Anyone with the link can download the original, including its location and camera details."
  And after the member presses "Create link", Drive's Links view lists the new link with "Original" under "Shares"
```

- **Notes:** SHARED-164 in [shared-data.md](shared-data.md) owns what the visitor receives.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-051] A member shares a photo that has no stand-in in the cloud as its original, with no choice offered
  Given the member's photo "scan.jpg" shows "Synced", and the cloud holds no stand-in for it
  When the member opens the photo's "Share link" dialog
  Then the dialog offers no "Share" choice
  And the dialog shows "Anyone with the link can download the original, including its location and camera details."
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-052] A member shares a document and reads that any metadata inside it goes with it
  Given the member's document "report.pdf" shows "Synced"
  When the member opens the document's "Share link" dialog
  Then the dialog offers no "Share" choice
  And the dialog shows "Anyone with the link can download this file, including any metadata inside it."
```

- **Notes:** SHARED-166 in [shared-data.md](shared-data.md) owns what the visitor receives.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-053] A member cannot choose the original of a photo whose original is archived
  Given the member's photo shows "Synced" and "Archived" in Drive
  When the member opens the photo's "Share link" dialog
  Then the "Original" choice is greyed out, with the text "This original is archived, so it cannot be shared as itself."
  And "Largest stand-in" stays chosen, and "Create link" works
```

- **Notes:** the same holds while the photo shows "Restoring". SHARED-173 in [shared-data.md](shared-data.md) owns the cloud's own refusal.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-055] A member chooses how long a link lasts, 30 days unless the member picks another
  Given the member opened the "Share link" dialog for a file
  When the member opens the "Link expires" choice
  Then the choice offers "1 day", "7 days", "30 days", "1 year", and "Never expires", with "30 days" chosen
  And a link created with "7 days" shows an expiry seven days away in Drive's Links view
```

- **Notes:** SHARED-144 in [shared-data.md](shared-data.md) owns when each lifetime ends.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-056] A member who retitles a link sees the file's extension kept
  Given the member opened the "Share link" dialog for "beach.jpg"
  When the member changes the title to "Holiday" and presses "Create link"
  Then Drive's Links view lists the link as "Holiday.jpg"
  And the link's address ends in "Holiday.jpg"
```

- **Notes:** a title that already ends in the file's extension keeps it once, so "Holiday.JPG" stays "Holiday.JPG".

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-057] A member cannot create a link with an empty title
  Given the member opened the "Share link" dialog for a file
  When the member clears the "Title" field, or leaves only spaces in it
  Then "Create link" is greyed out
```

- **Notes:** the field takes at most 200 characters, so a member cannot type a title the cloud refuses for its length.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-058] A member confirms before sharing a file or an original over 100 MB, and declining creates nothing
  Given the member opened the "Share link" dialog for a 150 MB video and chose "Original"
  When the member presses "Create link"
  Then the browser asks "This file is 150 MB. Every download of this file counts against your cloud's transfer allowance. Share it anyway?"
  And declining leaves the dialog open with no link created
  And accepting creates the link
```

- **Notes:** the same question comes for any file over 100 MB that has no stand-in choice, such as a large PDF.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-059] A member sharing a large photo's stand-in is not asked to confirm
  Given the member opened the "Share link" dialog for a 150 MB photo with "Largest stand-in" chosen
  When the member presses "Create link"
  Then the link is created with no question about the file's size
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-060] A member receives the new link's address and copies it
  Given the member filled in the "Share link" dialog for a file
  When the member presses "Create link"
  Then the button reads "Creating…" until the link exists
  And the dialog says "Anyone with this link can open the file." above the link's address
  And pressing "Copy link" copies the address and the button reads "Copied"
  And pressing "Done" closes the dialog
```

- **Notes:** the address is the cloud's address followed by `/public-shares/<token>/file/<title>`, so a recipient sees the title in the address.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-061] A member whose photo's original was archived after Drive listed it reads why the link was refused
  Given the member opened the "Share link" dialog for a photo and chose "Original"
  And the photo's original moved to the archive after Drive listed it
  When the member presses "Create link"
  Then the dialog shows "This original is archived. Share the largest stand-in instead." in red
  And the dialog stays open, so the member can choose "Largest stand-in" and try again
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-062] A member whose Drive may not make links is pointed to admin-web
  Given Drive's sharing switch is off
  And "report.pdf" shows "Synced" in Drive
  When the member opens the "Share link" dialog for "report.pdf"
  Then the dialog shows "Drive cannot create public links. Turn on “Enable sharing” on the Drive card in admin-web."
  And "Create link" is greyed out
```

## Drive's Links view

The "Links" button at the top of Drive opens the Links view, which lists the public links Drive made. Links made in other apps, such as a Photos album link, do not appear here. What a change, a replacement, and a stop do for a visitor belongs to [shared-data.md](shared-data.md): SHARED-146, SHARED-147, SHARED-148, and SHARED-177.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-063] A member sees Drive's links with each one's title, file, what it shares, and expiry
  Given the member made a link titled "Holiday.jpg" to the largest stand-in of "beach.jpg" with "30 days" on 24 November 2026
  And the member made a link titled "report.pdf" to "report.pdf" with "Never expires"
  When the member presses "Links" in Drive
  Then Drive shows a table with the columns "Title", "File", "Shares", and "Expires"
  And the row for "Holiday.jpg" shows the file "beach.jpg", "Stand-in", and "Expires Dec 24, 2026"
  And the row for "report.pdf" shows the file "report.pdf", "Original", and "Never expires"
  And each row offers "Copy link" and "Stop sharing"
```

- **Notes:** the expiry date follows the browser's language; the example shows a US-English browser. A link whose time has run out stays in the list and reads "Expired". Links appear in the order the member made them, oldest first.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-064] A member with no links reads how to make one
  Given the member's computer is signed in to the member's cloud
  And the member has made no link in Drive
  When the member presses "Links" in Drive
  Then Drive shows "No public links. Use “Share link…” on a file to make one."
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-065] A member changes a link's expiry from the Links view
  Given Drive's sharing switch is on
  And the member's link "Holiday.jpg" reads "Expires Dec 24, 2026" in the Links view on 24 November 2026
  When the member opens the link's expiry choice and picks "7 days from now"
  Then the row for "Holiday.jpg" reads "Expires Dec 1, 2026"
  And the link's address stays the same
```

- **Notes:** the choice offers "1 day from now", "7 days from now", "30 days from now", "1 year from now", and "Never expires". Each new expiry counts from the moment of the change (SHARED-146).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-066] A member replaces a link after confirming, and copies the new address
  Given Drive's sharing switch is on
  And the member's link "Holiday.jpg" is listed in the Links view
  When the member presses "Replace link" on its row and accepts "Replace this link? The old link stops working."
  Then the row stays in the list with the same title, file, and expiry
  And pressing "Copy link" on the row copies a new address that ends in "Holiday.jpg"
```

- **Notes:** declining the question leaves the link as it was. SHARED-147 owns what a visitor with the old address gets.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-067] A member stops sharing a link after confirming, and the link leaves the list
  Given the member's link "Holiday.jpg" is listed in the Links view
  When the member presses "Stop sharing" on its row and accepts the question Stop sharing "Holiday.jpg"?
  Then the row for "Holiday.jpg" leaves the Links view
```

- **Notes:** declining the question leaves the link as it was. SHARED-148 and SHARED-177 own what a visitor gets after the stop.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-068] A member whose Drive may no longer make links can still stop the links it made, but not change them
  Given the member made the link "Holiday.jpg" in Drive
  And the cloud operator has since turned Drive's sharing switch off
  When the member presses "Links" in Drive
  Then the Links view shows "Drive cannot create public links. Turn on “Enable sharing” on the Drive card in admin-web."
  And the row for "Holiday.jpg" shows its expiry as plain text, with no expiry choice and no "Replace link"
  And pressing "Stop sharing" and accepting removes the row
```

- **Notes:** SHARED-142 owns what a visitor gets while the switch is off.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-069] A member whose computer cannot reach the cloud's links reads why
  Given the member's computer has a cloud but is signed out of it
  When the member presses "Links" in Drive
  Then Drive shows "Public links are unavailable: This machine is not signed in to the cloud yet — sign in from admin-web"
```

- **Notes:** the library keeps working, and DRIVE-048 covers the greyed-out "Share link…" buttons.

```gherkin
@local
@intent:unclear
Scenario: [DRIVE-075] A member with no cloud reads in the Links view that public links need a cloud
  Given the member uses Starkeep on this computer without any cloud
  When the member presses "Links" in Drive
  Then Drive says that public links need a cloud and that this computer has none
```

- **Notes:** Implementation gap: Drive shows "Public links are unavailable: Cloud is not configured (no apiGatewayUrl / STARKEEP_CLOUD_URL)", and every "Share link…" button shows the same reason on hover.

```gherkin
@local @cloud
@intent:unclear
Scenario: [DRIVE-074] A member whose link change is refused because sharing was turned off reads what to do
  Given the member opened the Links view while Drive's sharing switch was on
  And the cloud operator has since turned the switch off
  When the member presses "Replace link" on a row and accepts the question
  Then the Links view shows "Drive cannot create public links. Turn on “Enable sharing” on the Drive card in admin-web."
  And the rows no longer offer "Replace link" or an expiry choice
```

- **Notes:** Implementation gap: Drive shows the cloud's refusal "starkeep-drive was not approved to publish public links" in red and keeps offering "Replace link" and the expiry choice until the member reopens the Links view. The setup arises when the cloud operator turns the switch off on admin-web while the member's Drive tab stays open.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [DRIVE-070] A member who filtered the library by type still sees each link's file name
  Given the member made a link to "report.pdf" and a link to "beach.jpg"
  And the member pressed the "image/jpeg (1)" button in the library
  When the member presses "Links" in Drive
  Then the row for each link shows its file's name, "report.pdf" and "beach.jpg"
```

- **Notes:** Implementation gap: the File column names only files in the library's current list, so a link to a file of another type, or to a file past the library's first 500 (DRIVE-017), shows "—".

## Drive in the cloud

Drive has a cloud identity that receives the member's shared records, but no code of its own runs in the cloud. The deploy's Drive pass and its removal at teardown belong to [cloud-setup.md](cloud-setup.md): CLOUD-SETUP-040, CLOUD-SETUP-066, and CLOUD-SETUP-067. Drive's identity and its reach over every type belong to [users-and-access.md](users-and-access.md): ACCESS-036 and ACCESS-124.

```gherkin
@cloud
@intent:confirmed
Scenario: [DRIVE-071] A cloud operator finds no Drive code running in the cloud deployment
  Given the cloud operator deployed Starkeep cloud, and the log showed the Drive pass finishing
  When the cloud operator lists the deployment's Lambda functions in the AWS console
  Then the console lists no function for Drive
```

- **Notes:** Drive runs only on a member's computer, so nothing on the internet answers as Drive. A change that gives Drive cloud code needs the reachability pass in `docs/reachability-review-requirement.md`, because Drive can read every file the member owns.
