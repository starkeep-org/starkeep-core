# Local data server

This file specifies the local data server that runs on a member's computer. The local operator drives most scenarios from admin-web's local sections, from the computer's terminal, or in a folder the data server watches. Members appear where they act inside an app or on another device, or where they see the result in an app. The app developer appears where an app reads the data server's events stream or writes a file through it. The scope covers starting and stopping the data server from the Data Server card and from the `starkeep` command, start failures, the This Machine section's offline, join, and layout states, the library cutover script, watched folders and the Local folders dialog, the `data-server-ctl` command, local storage on disk, running several instances on one computer, the loopback-only listener, the events stream, and clearing local data, from admin-web, the reset script, or `starkeep reset-local`.

Related files:

- [cloud-setup.md](cloud-setup.md): deploying the cloud, the Join Existing Cloud button, and the restart after a deploy
- [app-lifecycle.md](app-lifecycle.md): installing, starting, and stopping installed apps, and their ports
- [users-and-access.md](users-and-access.md): signing a computer in, binding its library to one member, and the rule that local surfaces stay on this machine
- [shared-data.md](shared-data.md): records, deletion, trash, restore, and duplicate files
- [residency-and-stand-ins.md](residency-and-stand-ins.md): which bytes a computer keeps, and Free up space over a watched folder
- [sync.md](sync.md): what syncs, and a library coming back from the cloud after a clear
- [drive.md](drive.md): the Drive app and its own card

## Running the data server

### Starting it from admin-web

```gherkin
@local
@intent:confirmed
Scenario: [LDS-001] A local operator who presses Start Data Server sees the Data Server card come online
  Given the Data Server card shows "Offline"
  When the local operator presses "Start Data Server"
  Then the button shows a spinner during the start
  And the card's badge changes to "Running" once the start finishes
  And the card offers "Add Local Folder" in place of "Start Data Server"
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-002] A local operator who presses Start in a stale tab sees the running data server, and finds no second copy
  Given the data server runs
  And a second admin-web tab still shows the Data Server card as "Offline"
  When the local operator presses "Start Data Server" in the second tab
  Then the second tab's card changes to "Running"
  And the local operator finds one data server process serving the library, the one that ran before
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-003] A local operator who starts the data server from a terminal sees it running in admin-web within a few seconds
  Given the local operator has admin-web open, with the Data Server card showing "Offline"
  When the local operator starts the data server from a terminal
  Then the card's badge changes to "Running" within about five seconds, without a reload
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-004] On the first start, the local operator finds a new data folder and a dashboard with no cloud
  Given the computer has never run the data server
  When the local operator starts the data server
  Then the local operator finds the data folder, `~/.starkeep` by default, holding a new `config.json`
  And the Data Server card shows "Running"
  And the Cloud section offers "Deploy Starkeep Cloud" and "Join Existing Cloud"
```

- **Notes:** CLOUD-SETUP-001 in [cloud-setup.md](cloud-setup.md) owns the two Cloud buttons.

### Stopping it

```gherkin
@local
@intent:confirmed
Scenario: [LDS-005] A local operator who chooses Stop from the card's menu sees the card go offline
  Given the Data Server card shows "Running"
  When the local operator chooses "Stop" from the card's menu
  Then the card's badge changes to "Offline"
  And the card says "The local data server must be running for local features to work."
  And the card offers "Start Data Server"
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-006] A local operator who presses Start right after a Stop sees the data server running again, with no port-in-use message
  Given the data server runs
  When the local operator chooses "Stop" and presses "Start Data Server" as soon as the card shows "Offline"
  Then the card changes to "Running" again
  And no message says the data server's port is in use
```

- **Notes:** Stop answers only once the old process has exited and released its port. `apps/admin-web/__tests__/integration/daemon.test.ts` › "a start right after a stop gets the same port, not 'port in use'" drives the shared stop path with an installed app.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-007] A local operator who chooses Stop sees the data server offline within seconds, even when it ignores the stop request
  Given the data server runs and does not exit when asked to stop
  When the local operator chooses "Stop" from the card's menu
  Then the card shows "Offline" within about seven seconds of the choice
  And the local operator finds no data server process left running
```

- **Notes:** Stop waits five seconds after the polite stop signal, then forces the process to end and waits up to two more seconds.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-008] A local operator who chooses Stop in admin-web also ends a data server started from a terminal
  Given the local operator started the data server from a terminal
  And the Data Server card shows "Running"
  When the local operator chooses "Stop" from the card's menu
  Then the terminal shows the data server exiting
  And the card shows "Offline"
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-009] A local operator who presses Start while another program holds the data server's port finds that program still running
  Given a program that is not a Node, pnpm, or npm process listens on the data server's port
  When the local operator presses "Start Data Server"
  Then the other program keeps running
  And the Data Server card does not show "Running"
```

- **Notes:** Stop refuses the same way, with "Port 9820 is bound by pid <pid> (<command>) which does not look like an app daemon; refusing to signal." The card offers Stop only while the data server answers its health check, so a local operator reaches that refusal only when the other program answers the health check too. LDS-014 covers the message Start gives.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-010] After a stop and a start, the local operator finds the library, watched folders, and sign-in as before
  Given the library holds items from apps and from a watched folder
  And the computer joined a cloud and is signed in
  When the local operator stops the data server and starts it again
  Then the apps show the same items as before the stop
  And the Local folders dialog lists the same watched folders
  And the This Machine section names the same cloud and the same signed-in member as before the stop
```

### Port conflicts and orphaned processes

```gherkin
@local
@intent:confirmed
Scenario: [LDS-011] The local operator sees an orphaned data server as running and can stop it
  Given a data server still runs after admin-web lost its record of the process, for example after a crash
  When the local operator opens admin-web
  Then the Data Server card shows "Running"
  When the local operator chooses "Stop" from the card's menu
  Then the local operator finds no data server process left running
  And the card shows "Offline"
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-012] A local operator who presses Start while an orphaned data server runs sees it running, and finds no second copy
  Given a data server still runs after admin-web lost its record of the process
  And an admin-web tab still shows the Data Server card as "Offline"
  When the local operator presses "Start Data Server" in that tab
  Then the card changes to "Running"
  And the local operator finds one data server process, the orphaned one
  And after a later Stop, the local operator finds no data server process left running
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-013] The local operator sees a data server that restarted after a settings change as running, and can stop it
  Given the local operator changed this machine's settings, such as by joining a cloud, and the data server restarted itself to apply the change
  When the local operator opens admin-web
  Then the Data Server card shows "Running"
  When the local operator chooses "Stop" from the card's menu
  Then the local operator finds no data server process left running
  And the card shows "Offline"
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-014] A local operator who presses Start while another program holds the data server's port learns which program to stop
  Given a program that is not a Starkeep daemon listens on the data server's port
  When the local operator presses "Start Data Server"
  Then the Data Server card says "Port 9820 is already in use by pid <pid> (<command>), which does not look like a Starkeep daemon. Stop that process, then start 'local-data-server' again."
  And the card stops showing a spinner
```

- **Notes:** Implementation gap: the card ignores Start's answer. The button spins for 90 seconds and the card then shows "Offline" with no message. The port in the message follows `STARKEEP_PORT`.

### Start failures

```gherkin
@local
@intent:confirmed
Scenario: [LDS-015] The local operator sees the data server's last log lines on the card when it exits during startup
  Given the data server exits during startup, for example because its configuration cannot be read
  When the local operator presses "Start Data Server"
  Then the Data Server card says "'local-data-server' exited during startup."
  And the card shows the last lines of the data server's log and names the log file
  And the card stops showing a spinner
```

- **Notes:** Implementation gap: the card ignores Start's answer, so the local operator sees a 90-second spinner and then "Offline". `e2e/tests/daemon-start-failure.spec.ts` › "a daemon that dies at startup surfaces its log tail on the Dashboard" drives the same failure on an installed app's card, which APP-LIFE-056 in [app-lifecycle.md](app-lifecycle.md) owns.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-016] The local operator learns the missing packages and the install command when the checkout's dependencies are missing
  Given the checkout's dependencies are not installed
  When the local operator presses "Start Data Server"
  Then the Data Server card says "'local-data-server' cannot start: <count> dependencies are not installed (<names>). Run `pnpm install` in <checkout folder>. Then try again."
  And the local operator finds no data server process running
```

- **Notes:** Implementation gap: the card ignores Start's answer, so the message never appears. The message lists at most five package names.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-017] The local operator learns that the environment is at fault when Node cannot start processes
  Given admin-web runs on a Node that cannot start a child process, such as one confined by a sandbox
  When the local operator presses "Start Data Server"
  Then the Data Server card says "Environment check failed: this Node runtime could not spawn a child process that reads <checkout folder> and writes under <pids folder> (<detail>). No daemon can start until this is fixed."
  And the card names the sandbox when Node runs from a Snap package or inside a Flatpak
```

- **Notes:** Implementation gap: the card ignores Start's answer, so the message never appears.

### From the terminal

The `starkeep` command and admin-web share one record of what runs, so a service that one starts, the other shows as running. The command's own conventions belong to [command-line.md](command-line.md). Starting and stopping one app belongs to [app-lifecycle.md](app-lifecycle.md).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [LDS-105] A local operator who runs start with no names gets the data server, Drive, and every app marked to run
  Given the local operator started "dice" earlier, which marked it to run
  And nothing runs on the computer now
  When the local operator runs "starkeep start"
  Then the output says "Started data-server on http://localhost:<port>.", then the same for drive, then for dice
  And the Data Server card in admin-web shows the data server running
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "stops everything in reverse order and brings the same set back (LDS-107, LDS-105, APP-LIFE-227)" (integration, local). No test checks admin-web's Data Server card.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [LDS-106] A local operator who starts from the terminal a data server that admin-web started is told it already runs
  Given the local operator started the data server from admin-web's Data Server card
  When the local operator runs "starkeep start data-server"
  Then the output says "data-server was already running on http://localhost:<port>."
  And the Data Server card keeps showing the data server running, with no restart
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "says an app already runs when it does (LDS-106)" (integration, local). The data server in the test started from the terminal, not from admin-web.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [LDS-107] A local operator who stops everything from the terminal gets the same set back at the next start
  Given the data server, Drive, and "dice" run, and admin-web runs from "starkeep admin"
  When the local operator runs "starkeep stop"
  Then the output says admin-web, dice, drive, and data-server stopped, in that order
  When the local operator runs "starkeep start"
  Then the local operator finds the data server, Drive, and "dice" running again
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "stops everything in reverse order and brings the same set back (LDS-107, LDS-105, APP-LIFE-227)" (integration, local). admin-web does not run in the test.
- **Notes:** stopping everything keeps each app's mark to run. Stopping one named app clears its mark (APP-LIFE-227).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [LDS-108] A local operator who stops a service that is not running is told so, and the command succeeds
  Given Drive is not running
  When the local operator runs "starkeep stop drive"
  Then the output says "drive was not running."
  And the command exits with status 0
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "says a stopped service was not running, and succeeds (LDS-108)" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [LDS-109] A local operator restarts the data server from the terminal
  Given the data server runs
  When the local operator runs "starkeep restart data-server"
  Then the output says "Stopped data-server." and then "Started data-server on http://localhost:<port>."
  And the Data Server card in admin-web shows the data server running
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "restarts the data server (LDS-109)" (integration, local). No test checks admin-web's Data Server card.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [LDS-124] A local operator who restarts with no names restarts the data server, Drive, and every app marked to run
  Given the data server, Drive, and "dice" run, "dice" is marked to run, and admin-web runs
  When the local operator runs "starkeep restart"
  Then the output says each of data-server, drive, and dice stopped and started again
  And admin-web keeps running, untouched
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "restarts the platform and the marked apps with no names, and leaves admin-web alone" (integration, local). admin-web does not run in the test.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [LDS-110] A local operator whose service does not start sees why, how many failed, and a failing exit status
  Given another program holds Drive's port
  When the local operator runs "starkeep start"
  Then the output says "Could not start drive:" with the reason
  And the output ends with "1 of 2 services did not start."
  And the command exits with status 1
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "says which service did not start, how many failed, and fails (LDS-110)" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [LDS-111] A local operator sees what runs on the computer, at which address, and the computer's sync state
  Given the data server and Drive run, "dice" is marked to run but stopped, and the computer is signed in to sync
  When the local operator runs "starkeep status"
  Then the SERVICES list shows data-server and drive as running with their addresses
  And the list shows dice as "stopped  (marked to run)"
  And the list shows whether admin-web runs
  And the output shows the joined cloud's address after "CLOUD", and "SYNC      signed in as <email>"
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "shows the services, a marked app that is stopped, the cloud and sync (LDS-111)" (integration, local). The test computer is signed out and joined to no cloud.
- **Notes:** a computer that does not sync shows "SYNC signed out".

```gherkin
@local @cloud
@intent:confirmed @coverage:none
Scenario Outline: [LDS-125] A local operator sees from the terminal when sync is still connecting or the library belongs to another account
  Given the computer's sync state is <state>
  When the local operator runs "starkeep status"
  Then the output shows "<line>"

  Examples:
    | state                                       | line                                                          |
    | connecting for "ana@example.com"            | SYNC      connecting as ana@example.com                       |
    | bound to the library of "ana@example.com"   | SYNC      this library belongs to another account (ana@example.com) |
```

- **Coverage:** No test puts the sync state into "connecting" or "bound elsewhere".

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [LDS-112] A local operator whose data server is stopped sees the sync state as unknown
  Given the data server is stopped
  When the local operator runs "starkeep status"
  Then the output shows data-server as stopped
  And the output shows "SYNC      unknown (the data server is not answering)"
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "shows the data server stopped and the sync state unknown (LDS-112)" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [LDS-113] A local operator follows the data server's log from the terminal
  Given the data server was started on this computer
  When the local operator runs "starkeep logs data-server -f"
  Then the output shows the log's last 50 lines and then each new line as the data server writes it
  And "-n 200" shows the last 200 lines first
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "prints the last lines of a log, as many as -n asks (LDS-113)" (integration, local). No test follows the log with -f.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [LDS-114] A local operator who asks for the log of something never started here is told there is none
  Given "dice" was never started on this computer
  When the local operator runs "starkeep logs dice"
  Then the output says "No log for dice at <path>. It has not been started here."
  And the command exits with status 1
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "says when a name has no log here (LDS-114)" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [LDS-115] A local operator opens admin-web from the terminal
  Given admin-web is not running
  When the local operator runs "starkeep admin"
  Then the output says "Starting admin-web…" and "admin-web runs at http://localhost:3000"
  And the browser opens admin-web's dashboard
  And "--no-open" starts admin-web without opening a browser
```

- **Coverage:** No test starts admin-web from the CLI.
- **Notes:** on a computer where no browser opens, such as one reached over SSH, the output adds "Open http://localhost:3000 in your browser."

### This machine's settings

```gherkin
@local
@intent:confirmed
Scenario: [LDS-018] A local operator who joins a cloud finds the computer's open apps working without a reload
  Given the data server runs and an app is open on the computer
  When the local operator joins a cloud from the This Machine section
  Then the open app shows current data without a reload
  And the This Machine section names the new cloud address
```

- [LDS-019] A web page cannot change this machine's settings: see ACCESS-169 in [users-and-access.md](users-and-access.md).

```gherkin
@local
@intent:confirmed
Scenario: [LDS-020] A local operator who edits the settings file by hand sees the change take effect at the next start
  Given the data server runs
  When the local operator edits `config.json` in the data folder by hand, for example to change how often sync pulls
  Then changes from other devices keep arriving at the earlier pace while the data server keeps running
  And changes arrive at the edited pace after the local operator stops and starts the data server
```

- **Notes:** The data server reads `config.json` once, at startup. `nodeId` in the file never changes, even through a settings change from admin-web.

## The This Machine section

```gherkin
@local
@intent:confirmed
Scenario Outline: [LDS-021] A local operator whose data server is stopped is asked to start it
  Given the data server is stopped on <machine>
  When the local operator opens admin-web's dashboard
  Then <place> says "<copy>"
  And the section offers no sign-in form and no join form

  Examples:
    | machine                                  | place                                  | copy                                                              |
    | the computer that administers the cloud  | the line under the Local heading       | Start the local data server to sign this machine in.              |
    | a computer that joined a cloud by address | the This Machine section               | Start the local data server to join a cloud or sign this machine in. |
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-022] A local operator on a computer with no cloud can join one by its address, for a second computer or someone else's cloud
  Given the computer has neither deployed nor joined a cloud
  And the data server runs
  When the local operator presses "Join Existing Cloud"
  Then a form says "Already deployed Starkeep Cloud from another computer, or have an account on someone else's cloud? Enter the cloud's address to sync this computer with it."
  And the form offers a "Cloud address" field and a "Join" button
  And "Join" stays disabled while the field is empty
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-023] After joining a cloud, the local operator sees a restart notice and then a sign-in form for that cloud
  Given the computer has neither deployed nor joined a cloud
  And the local operator opened the join form
  When the local operator enters the cloud's https address and presses "Join"
  Then the section says "Restarting the local data server…"
  And the section then says "Sign in with your Starkeep account to sync local apps with <address>." above an email and password form
```

- **Notes:** The section checks the data server once, three seconds after Join. A restart that takes longer leaves the section showing "Start the local data server to join a cloud or sign this machine in." until the local operator reloads the page. ACCESS-062 in [users-and-access.md](users-and-access.md) owns the sign-in itself.

```gherkin
@local
@intent:confirmed
Scenario Outline: [LDS-024] The local operator cannot join with an address that is not an https URL
  Given the computer has neither deployed nor joined a cloud
  When the local operator enters "<address>" in the join form and presses "Join"
  Then the section shows "Could not complete" with "The cloud address must be an https URL."
  And the join form stays in place with the address the local operator typed

  Examples:
    | address                   |
    | http://cloud.example.com  |
    | cloud.example.com         |
    | https://                  |
```

- [LDS-025] Join refuses a request sent from another site's page: see ACCESS-169 in [users-and-access.md](users-and-access.md).

```gherkin
@local
@intent:confirmed
Scenario: [LDS-026] A local operator who joins with a trailing slash sees the cloud's address without it
  Given the computer has neither deployed nor joined a cloud
  When the local operator joins with "https://cloud.example.com/"
  Then the sign-in line names "https://cloud.example.com", without the trailing slash
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-027] A local operator on the computer that administers the cloud sees the sign-in line under Local, naming "this cloud"
  Given the cloud was deployed from this computer
  And the computer is signed in with the local operator's account
  When the local operator opens admin-web's dashboard
  Then the Local heading shows "Local apps sync with this cloud as <email>." with a "Sign out" link
  And the line sits above the Data Server card, with no "This machine" heading or card border of its own
```

- **Notes:** The administering computer reaches the cloud through its API gateway, which is not the address other devices sign in with, so the line names no address. CLOUD-SETUP-003 in [cloud-setup.md](cloud-setup.md) owns the Cloud address line.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-028] A local operator who presses Join Existing Cloud sees the join form with no heading of its own
  Given the computer has neither deployed nor joined a cloud
  When the local operator presses "Join Existing Cloud"
  Then the join form appears beneath the button with no "This machine" heading
  And after the local operator joins and reloads the page, the Cloud section shows the section under a "This machine" heading
```

## Library ownership

- [LDS-029] The first sign-in binds this machine's library to the signed-in member: see ACCESS-077 in [users-and-access.md](users-and-access.md).
- [LDS-030] Signing in as another account stops sync and says the library belongs to another account: see ACCESS-079 in [users-and-access.md](users-and-access.md).
- [LDS-031] Sync resuming after a wrong-account sign-in: see ACCESS-079 in [users-and-access.md](users-and-access.md).

```gherkin
@local
@intent:confirmed
Scenario: [LDS-097] A local operator whose stored sign-in does not match the library's owner sees which account owns the library, with a way out
  Given the computer's library is bound to one member
  And the computer still holds a sign-in for a second member, for example after the local operator copied another computer's library database into the data folder
  When the local operator starts the data server and opens admin-web's dashboard
  Then the This Machine section shows an alert titled "This machine does not sync" that says the library belongs to <owner email> and that sync stays off
  And the section offers a "Sign out" link beneath the alert
  And the section offers no "Local apps sync with" line
```

### The library cutover script

```gherkin
@local
@intent:confirmed
Scenario: [LDS-032] A local operator who dry-runs the library cutover script sees what it would change, and the library stays unchanged
  Given the computer's library was written before per-member storage keys existed
  And the data server is stopped
  When the local operator runs `apps/local-data-server/scripts/cutover-local-library.ts` without `--yes`
  Then the output names the library folder, the number of keys to rewrite per column, the folders to move, and the retired platform records to delete
  And the output ends with "Dry run. Pass --yes to apply."
  And a second dry run prints the same counts
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-033] A local operator who runs the library cutover script sees a snapshot made first and every table checked afterwards
  Given the computer's library was written before per-member storage keys existed
  And the data server is stopped
  When the local operator runs the cutover script with `--yes`
  Then the output names a snapshot folder under `backups/` in the data folder before it reports any change
  And the output lists each file table with its live files and the files missing on disk
  And the output ends with "Done. Every check passed. Start the local data server and connect this machine."
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-099] A local operator whose cutover checks fail is told to restore from the snapshot
  Given the computer's library was written before per-member storage keys existed
  And the library is in a state that fails one of the checks after the change
  And the data server is stopped
  When the local operator runs the cutover script with `--yes`
  Then the output says "CHECKS FAILED. Restore from <snapshot folder> before starting the server."
  And the output then lists each failed check
  And the command exits with an error
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-034] A local operator cannot run the library cutover script while the data server runs
  Given the data server runs
  When the local operator runs the cutover script, with or without `--yes`
  Then the local operator sees the script stop with "<database path> is open by pid <pid>. Stop the local data server first."
  And the local operator finds the library unchanged
```

- **Notes:** The script also stops with "no library at <database path>" when the data folder holds no database.

## Watched folders

### Adding and removing folders

```gherkin
@local
@intent:confirmed
Scenario: [LDS-035] A local operator who adds a folder finds its files in the library, and the Data Server card shows the folder and file counts
  Given the data server runs and the local operator watches no folder
  And a folder on the computer holds three files
  When the local operator presses "Add Local Folder", enters the folder's path, and presses "Add folder"
  Then the Local folders dialog says "Watch started: <folder path>"
  And the dialog lists the folder with the state "watching" and "3/3"
  And the Data Server card says "1 folder · 3/3 files"
  And the three files appear as items in the library, for example in Drive
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-036] A local operator can name a folder in the home folder with a path that starts with `~`
  Given the home folder holds a folder named Photos
  When the local operator adds the folder "~/Photos" in the Local folders dialog
  Then the dialog lists the folder by its full path inside the home folder
  And the folder's files appear in the library
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [LDS-037] A local operator who adds a folder that cannot be watched is told why
  Given the data server runs
  When the local operator adds a path where <situation> in the Local folders dialog
  Then the dialog shows "<message>" beneath the path field
  And the dialog's folder list stays as it was

  Examples:
    | situation                        | message                                                        |
    | nothing exists                   | Directory does not exist                                       |
    | a file sits                      | Path is not a directory                                        |
    | an already watched folder sits   | A watch for this directory already exists.                     |
    | a folder the local operator cannot read sits | the system's error, such as "EACCES: permission denied, scandir '<path>'" |
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-038] A local operator who removes a folder chooses whether to keep its files in the library
  Given the local operator watches a folder whose files are in the library
  When the local operator presses "Remove" on the folder's row in the Local folders dialog
  Then the dialog asks whether to keep the folder's files in the library or remove them, with keeping chosen
  And after the local operator confirms the choice to keep them, the dialog no longer lists the folder
  And the folder's files stay in the library
  And a file the local operator adds to the folder afterwards does not appear in the library
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-101] A local operator who removes a folder and chooses to remove its files finds them in the trash
  Given the local operator watches a folder whose files are in the library
  When the local operator presses "Remove" on the folder's row, chooses to remove its files, and confirms
  Then the dialog no longer lists the folder
  And the folder's files leave the library
  And the local operator can restore the files from the trash
  And the files stay in the folder on disk
```

- **Notes:** The items keep linking to the files in the folder. A file the local operator later deletes from the former watched folder leaves its item in the library with nothing to open and no report.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-039] A local operator finds watched folders back after a restart, with the files added while the data server was stopped
  Given the local operator watches a folder
  And the local operator stopped the data server
  When the local operator adds a file to the folder and starts the data server again
  Then the Local folders dialog lists the folder again
  And the new file appears in the library
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-040] A local operator whose watched folder cannot be read at the next start sees an error state on its row
  Given the local operator watches a folder
  And the folder became unreadable, or was removed, while the data server was stopped
  When the local operator starts the data server and opens the Local folders dialog
  Then the folder's row shows the state "error"
  And the dialog reports none of the folder's files as possibly lost
  And the folder's items stay in the library
```

- **Notes:** The row shows the state word only, not the system's error.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-041] A local operator who watches a folder finds the data folder barely grows, because the library links to the files
  Given the local operator watches a folder that holds 2 GB of files
  When the local operator checks the data folder's size after the files appear in the library
  Then the local operator finds that the data folder grew by far less than 2 GB
  And opening one of the items in an app shows the file from the folder
```

### Which files join the library

```gherkin
@local
@intent:confirmed
Scenario: [LDS-042] A local operator finds every non-empty file in the library, shown by each app that reads its type
  Given the local operator watches a folder
  When the local operator adds a `.jpg` file, a `.txt` file, and a file with an extension Starkeep does not know
  Then Drive, which reads every type, lists all three files as items
  And Photos shows the `.jpg` file and neither of the other two
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-043] A local operator never finds system clutter files in the library
  Given the local operator watches a folder
  When the local operator copies a `.DS_Store`, a `Thumbs.db`, and a `.gitkeep` file into the folder
  Then none of the three files appears in the library
  And the folder's file count in the Local folders dialog does not include them
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-044] A local operator finds a watched folder's large files in the library, and its empty files left out with a count
  Given the local operator watches a folder
  When the local operator saves an empty file and a 150 MB video into the folder
  Then the video appears in the library
  And the empty file does not appear in the library
  And the Local folders dialog counts the empty file as skipped
```

- [LDS-045] An item from a watched file carries the file's own creation and modification dates: see SHARED-019 in [shared-data.md](shared-data.md).

```gherkin
@local
@intent:confirmed
Scenario: [LDS-047] A local operator who adds a watch without recursion finds the subfolders' files left out
  Given a folder holds `top.jpg` and a subfolder that holds `deep.jpg`
  When the local operator runs `data-server-ctl watch add <folder> --no-recursive`
  Then `top.jpg` appears in the library
  And `deep.jpg` does not appear in the library
```

### Files appearing and changing

```gherkin
@local
@intent:confirmed
Scenario: [LDS-048] A local operator who adds a file to a watched folder finds it in the library
  Given the local operator watches a folder
  When the local operator saves a new file into the folder
  Then the file appears as an item in the library within a few seconds, without a restart
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-049] A local operator who edits a watched file finds a new item that shows the new content
  Given the local operator watches a folder that holds `notes.txt`
  When the local operator edits `notes.txt` and saves new content
  Then the library holds a new item for `notes.txt`
  And opening the new item shows the new content
```

```gherkin
@local
@intent:confirmed @suboptimal
Scenario: [LDS-050] A local operator who edits a watched file finds one item in the library, with the new content
  Given the local operator watches a folder that holds `notes.txt`
  When the local operator edits `notes.txt` and saves new content
  Then the library holds one `notes.txt` item
  And opening the item shows the new content
  And the earlier content no longer appears in the library
```

- **Suboptimal:** the earlier version is gone from the library. Revisit keeping earlier versions in the item's history, where the member can open them.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-051] A local operator who re-saves a watched file unchanged still finds one item, counted as synced
  Given the local operator watches a folder whose files all count as synced
  When the local operator re-saves one file without changing its content
  Then the library still holds one item for the file
  And the Local folders dialog still counts every file as synced
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-052] A local operator who renames a watched file finds its one item renamed, with its albums, labels, and details
  Given the local operator watches a folder that holds `IMG_1.jpg`
  And the item carries a Photos album label
  When the local operator renames the file to `Beach.jpg`
  Then the library holds one item named `Beach.jpg` with the album label and its details
  And the library holds no item named `IMG_1.jpg`
  And the Local folders dialog never reports `IMG_1.jpg` as possibly lost
```

### Files leaving the folder

```gherkin
@local @cloud
@intent:confirmed
Scenario: [LDS-053] A local operator who deletes a watched file that the cloud holds keeps its item in the library, kept in the cloud
  Given the computer is signed in to a cloud
  And the cloud holds a complete, verified copy of a watched file
  When the local operator deletes the file from the watched folder
  Then the item stays in the library on every device
  And the Local folders dialog says "1 file left the folder and are kept in the cloud. They stay in the library and open on demand."
  And opening the item on the computer brings its bytes back from the cloud
```

- **Notes:** The proof is the one Free up space demands, owned by [residency-and-stand-ins.md](residency-and-stand-ins.md).

```gherkin
@local
@intent:confirmed
Scenario: [LDS-054] A local operator who deletes a watched file before the cloud holds it keeps its item, reported as possibly lost
  Given no cloud holds a confirmed copy of a watched file
  When the local operator deletes the file from the watched folder
  Then the item stays in the library
  And the Local folders dialog names the file under "1 file may be lost"
  And opening the item fails because no copy of its bytes remains
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-055] A local operator who deletes a watched file while the data server is stopped sees it reported at the next start
  Given no cloud holds a confirmed copy of a watched file
  And the local operator stopped the data server
  When the local operator deletes the file from the watched folder and starts the data server again
  Then the item stays in the library
  And the Local folders dialog names the file under "1 file may be lost"
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-056] A local operator who puts a removed file back sees its item open from the folder again
  Given the local operator deleted a watched file from its folder
  And the Local folders dialog reports the file as possibly lost or kept in the cloud
  When the local operator puts the same file back at the same path
  Then the dialog no longer reports the file
  And opening the item shows the file's bytes from the folder again
```

### Identical files

- [LDS-057] Two identical files under two names are two items that share one stored copy: see SHARED-184 in [shared-data.md](shared-data.md).

```gherkin
@local
@intent:confirmed
Scenario: [LDS-058] A local operator who deletes one of two identical watched files still opens both items
  Given the local operator watches a folder that holds `a.jpg` and `copy-of-a.jpg` with the same bytes
  And no cloud holds a copy of either file
  When the local operator deletes `a.jpg` from the folder
  Then both items still open with their bytes on the computer
  And the Local folders dialog does not report `a.jpg` as possibly lost
  And the dialog does not say that the cloud keeps `a.jpg`
```

- **Notes:** Implementation gap: the dialog lists `a.jpg` among the files "kept in the cloud", even on a computer with no cloud.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-059] A local operator who saves the same file under one name into two subfolders finds one item
  Given the local operator watches a folder with the subfolders `2024` and `backup`
  When the local operator saves `beach.jpg` with the same bytes into both subfolders
  Then the library holds one item named `beach.jpg`
  And the Local folders dialog counts both files as synced
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-060] A local operator who watches a file with the same name and bytes as a Photos import finds one item, the Photos one
  Given a member imported `IMG_1.jpg` through Photos
  When the local operator adds a watched folder that holds `IMG_1.jpg` with the same bytes
  Then the library still holds one `IMG_1.jpg` item, the one Photos added
  And the item keeps its Photos labels and metadata
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-061] A local operator who watches a file with a Photos item's bytes under another name finds two items
  Given a member imported `IMG_1.jpg` through Photos
  When the local operator adds a watched folder that holds `Beach.jpg` with the same bytes
  Then the library holds both `IMG_1.jpg` and `Beach.jpg`
```

### Files deleted from the library

```gherkin
@local
@intent:confirmed
Scenario: [LDS-062] A local operator finds a watched file kept out of the library, shown as left out on purpose, after a member deletes its item
  Given the local operator watches a folder that holds `old.jpg`
  And a member deleted the `old.jpg` item from the library, for example in Drive
  When the local operator opens the Local folders dialog
  Then the dialog names `old.jpg` under "1 file left out on purpose"
  And the item stays out of the library after the local operator re-saves `old.jpg` unchanged or restarts the data server
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-063] A local operator who presses Add back gets the original item back with its labels
  Given the Local folders dialog lists `old.jpg` under "left out on purpose"
  And the item carried a Photos album label before the local operator deleted it
  When the local operator presses "Add back" beside `old.jpg`
  Then the dialog says "Back in the library: <path>"
  And the original item returns to the library with its album label, not as a copy
  And the dialog no longer lists `old.jpg` as left out
```

```gherkin
@local
@intent:confirmed @manual-review
Scenario: [LDS-064] A local operator who restores a left-out item on another device sees the file leave the "left out on purpose" list
  Given the Local folders dialog listed `old.jpg` under "left out on purpose"
  And a member restored the item on another device, and the computer has synced since
  When the local operator opens the Local folders dialog
  Then the dialog no longer lists `old.jpg` as left out
  And the item is in the library
```

- **Manual review:** the maintainer wants to look at the "left out on purpose" behavior as a whole later.

```gherkin
@local
@intent:confirmed @manual-review
Scenario: [LDS-102] A local operator who presses Add back on a file already restored on another device sees no error
  Given the Local folders dialog still lists `old.jpg` under "left out on purpose"
  And a member restored the item on another device, and the computer has synced since
  When the local operator presses "Add back" beside `old.jpg`
  Then the dialog no longer lists `old.jpg` as left out
  And the dialog shows no error
  And the item stays in the library
```

- **Manual review:** see LDS-064.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [LDS-065] A local operator who presses Add back on an item already back in the library sees the add-back succeed
  Given the Local folders dialog lists `old.jpg` under "left out on purpose"
  And a member restored the item on another device moments ago, and the dialog still lists `old.jpg` as left out
  When the local operator presses "Add back" beside `old.jpg`
  Then the dialog says "Back in the library: <path>"
  And the library holds one `old.jpg` item, the restored one
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-066] A local operator who saves new content into a left-out file finds a new item
  Given the Local folders dialog lists `old.jpg` under "left out on purpose"
  When the local operator saves new content into `old.jpg`
  Then a new `old.jpg` item with the new content appears in the library
  And the deleted item stays deleted
  And the dialog no longer lists `old.jpg` as left out
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-067] A local operator who copies a deleted item's file into another watched folder still finds it left out
  Given the local operator deleted the `old.jpg` item from the library
  When the local operator copies the same `old.jpg` into another watched folder
  Then the item does not come back to the library
  And the Local folders dialog lists the new path under "left out on purpose"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [LDS-068] A local operator finds a watched file left out on the computer without a restart after a member deletes its item on another device
  Given the computer watches a folder that holds `old.jpg` and syncs with the cloud
  And a member deleted the `old.jpg` item on another device
  When the local operator opens the computer's Local folders dialog after the next sync round
  Then the dialog lists `old.jpg` under "left out on purpose"
  And the item does not come back to the library, with no restart of the data server
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [LDS-069] A local operator finds a left-out item back on the computer without a restart after a member restores it on another device
  Given the computer's Local folders dialog lists `old.jpg` under "left out on purpose"
  And a member restored the item on another device
  When the local operator opens the Local folders dialog after the next sync round
  Then the dialog no longer lists `old.jpg` as left out
  And the item opens on the computer from the file in the folder, with no restart of the data server
```

### The Local folders dialog

```gherkin
@local
@intent:confirmed
Scenario: [LDS-070] A local operator whose watched folder is fully in the library sees only the folder's counts
  Given the local operator watches a folder whose files are all in the library
  When the local operator opens the Local folders dialog
  Then the folder's row shows its path, its state, and its synced and total counts, such as "12/12"
  And the row shows no explanation beneath it
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-071] A local operator sees possibly lost files named, with what to do about them
  Given the local operator deleted two files from a watched folder before the cloud was confirmed to hold them
  When the local operator opens the Local folders dialog
  Then the folder's row says "2 files may be lost"
  And the row says "These left the folder before the cloud was confirmed to hold them, so Starkeep may have no copy. Put the file back, or delete the item from Drive's Trash."
  And the row names each file by its full path
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-072] A local operator sees files left out on purpose named with Add back buttons, and can run one add-back at a time
  Given two files in a watched folder are left out because a member deleted their items
  When the local operator opens the Local folders dialog
  Then the folder's row says "2 files left out on purpose" and "These are in the folder and you deleted them from the library, so Starkeep leaves them alone. Adding one back returns the original item, not a copy."
  And each file has an "Add back" button
  When the local operator presses "Add back" beside one file
  Then that button reads "Adding…" and every other "Add back" button is disabled until the add-back finishes
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-073] A local operator sees files kept in the cloud explained rather than reported as a problem
  Given the local operator deleted two files from a watched folder after the cloud was confirmed to hold them
  When the local operator opens the Local folders dialog
  Then the folder's row says "2 files left the folder and are kept in the cloud. They stay in the library and open on demand."
  And the row names neither file as lost
```

### The command line

```gherkin
@local
@intent:confirmed
Scenario: [LDS-074] A local operator who runs `data-server-ctl watch add` sees the new watch's id, and the folder's files join the library
  Given the data server runs
  When the local operator runs `data-server-ctl watch add ~/Photos`
  Then the output says "Watch added:" with the new watch's id, its full path, and "recursive: true"
  And the folder's files appear in the library
```

- **Notes:** Implementation gap: the command prints "?" for the id and repeats the path as typed, because it reads fields the data server's answer does not hold.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-075] A local operator who runs `data-server-ctl watch list` sees the watched folders with their counts
  Given the local operator watches two folders
  When the local operator runs `data-server-ctl watch list`
  Then the output says "Watches (2):" and lists each watch's id, path, state, and "<synced>/<total> files"
  And with no folder watched the output says "No watches configured."
```

- **Notes:** Implementation gap: the command prints "Watches (undefined):" and then fails, because it reads the data server's answer as a list.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-076] A local operator can remove a watched folder with `data-server-ctl watch remove`, by id or by path
  Given the local operator watches a folder
  When the local operator runs `data-server-ctl watch remove` with the watch's id or with the folder's full path
  Then the output says "Watch <id> removed."
  And the Local folders dialog no longer lists the folder
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-100] A local operator who runs `data-server-ctl watch remove` with a path that no watch covers is told so
  Given the data server runs
  When the local operator runs `data-server-ctl watch remove` with the full path of a folder the local operator does not watch
  Then the output says "No watch found for path: <path>"
  And the command exits with an error
  And the Local folders dialog lists the same folders as before
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-077] A local operator who runs `data-server-ctl` while the data server is stopped is told it is not running
  Given the data server is stopped
  When the local operator runs any `data-server-ctl watch` command
  Then the output says "Could not connect to data-server at localhost:<port>" and "Make sure the data-server is running (npm run dev)."
  And the command exits with an error
```

## Local storage on disk

```gherkin
@local @cloud
@intent:confirmed
Scenario: [LDS-078] The member never sees corrupted bytes from a damaged cloud download
  Given the member's computer syncs with the cloud
  And a file's bytes arrive from the cloud corrupted
  When the member opens the item on the computer after the download
  Then the item does not open with the corrupted bytes
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [LDS-104] A local operator finds no partial file left in the data folder after a damaged cloud download
  Given the computer syncs with the cloud
  And a file's bytes arrive from the cloud corrupted
  When the local operator looks in the data folder after the download
  Then the local operator finds no partial file left in the data folder
```

- **Notes:** Retries of the failed download belong to [uploads-and-file-bytes.md](uploads-and-file-bytes.md).

```gherkin
@local
@intent:confirmed
Scenario: [LDS-079] A local operator finds files added through apps under the data folder, and watched files where they were
  Given a member imported a photo through Photos
  And the local operator watches a folder that holds another photo
  When the local operator looks on disk
  Then the local operator finds the imported photo's bytes under `objects` in the data folder
  And the watched photo stays only in its own folder, with a link to it under `objects`
```

## Several instances on one computer

```gherkin
@local
@intent:confirmed
Scenario: [LDS-080] The local operator finds all of the data server's state in the data folder that `.env.local` names
  Given the local operator set `STARKEEP_DIR` to an absolute path in `.env.local` at the root of the checkout
  And the shell that starts the data server does not set `STARKEEP_DIR`
  When the local operator starts the data server
  Then the local operator finds the database, `config.json`, and the stored files in the named folder
  And the default `~/.starkeep` folder stays unchanged
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-081] A local operator who runs two instances with their own data folders and ports finds separate libraries
  Given the local operator runs two data servers on one computer, each with its own `STARKEEP_DIR` and `STARKEEP_PORT`
  When the local operator adds a watched folder to the first instance
  Then the folder's files appear only in the first instance's library
  And the second instance's library and watched-folder list stay as they were
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-082] A local operator who opens a second instance's admin-web sees its own data server, not the default one
  Given the local operator runs a second instance with its own `STARKEEP_DIR`, `STARKEEP_ADMIN_PORT`, `STARKEEP_PORT`, and `STARKEEP_DRIVE_PORT`
  And the default instance's data server runs and is signed in
  When the local operator opens the second admin-web while its own data server is stopped
  Then the second admin-web's Data Server card shows "Offline"
  And its Cloud section offers "Deploy Starkeep Cloud" and "Join Existing Cloud", because its own data folder holds no cloud
  And the default instance's admin-web still shows its Data Server card as "Running" and its member signed in
```

- **Notes:** Installed apps on a second instance also need `STARKEEP_APP_PORT_RANGE`, which [app-lifecycle.md](app-lifecycle.md) owns.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-083] A local operator can point `data-server-ctl` at the data server on the port that `STARKEEP_PORT` names
  Given the local operator runs a second data server on port 9822
  When the local operator runs `STARKEEP_PORT=9822 data-server-ctl watch add <folder>`
  Then the folder joins that data server's library
  And the Local folders dialog of the default instance on port 9820 lists no new folder
```

- **Notes:** The command reads `STARKEEP_PORT` from the shell only. A value set only in `.env.local` does not reach it.

## Reaching the data server

### Loopback only

```gherkin
@local
@intent:confirmed
Scenario: [LDS-084] A local operator cannot reach the data server from another device on the network
  Given the data server runs on the local operator's computer
  When the local operator opens the computer's network address on the data server's port from a phone's browser on the same network
  Then the phone's browser fails to connect
  And admin-web on the computer itself still shows the Data Server card as "Running"
```

- [LDS-085] A page that rebinds its domain to this machine is refused: see ACCESS-168 in [users-and-access.md](users-and-access.md).
- [LDS-086] A page from another site cannot read or change the watched folders: see ACCESS-173 in [users-and-access.md](users-and-access.md) (moved 2026-11-23).

### The events stream (app developer)

```gherkin
@local
@intent:confirmed
Scenario: [LDS-087] An app developer's open app learns of a change and can refresh without a reload
  Given an app holds the data server's events stream open
  When the app waits on the stream while a record changes on the computer, through any app, a watched folder, or a sync round that brings another device's change
  Then the app receives an event on the stream
  And the app can refetch through its own data routes and show the change without a reload
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-088] An app developer's app learns from the events stream only that something changed, never what
  Given an app holds the events stream open
  When the app waits on the stream while another app writes a record the first app has no grant to read
  Then the first app receives an event whose data is empty
  And the event names no record, type, or app
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-089] An app developer's idle events connection stays open
  Given an app opened the events stream and received the opening ": connected" comment
  When the app keeps the stream open for several minutes with no record changes
  Then the app receives a ": ping" comment every 25 seconds
  And the connection stays open
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-090] An app developer's app sees its events stream end when the data server stops
  Given an app holds the events stream open
  When the app keeps waiting on the stream as the data server stops, for example on a Stop from admin-web
  Then the app sees the stream end
```

## Clearing local data

```gherkin
@local
@intent:confirmed
Scenario: [LDS-091] A local operator is offered Clear local data only while the data server is stopped
  Given the Data Server card shows "Running"
  When the local operator opens the card's menu
  Then the menu offers "Storage…" and "Stop" and no "Clear local data…"
  When the local operator stops the data server and opens the menu again
  Then the menu offers "Clear local data…"
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-092] A local operator who chooses Clear local data sees what goes and what stays
  Given the data server is stopped
  When the local operator chooses "Clear local data…" from the Data Server card's menu
  Then a dialog titled "Clear local data" says "This will permanently delete all local object files, the SQLite database, and watch configs on this machine. Files you added through an app are deleted. Files in your watched folders stay where they are. Cloud data is untouched."
  And the dialog offers "Cancel" and "Confirm"
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-093] A local operator who confirms the clear finds the watched-folder list empty, and keeps the watched files, the cloud address, and the sign-in
  Given the computer joined a cloud and is signed in
  And the local operator watches a folder, and a member imported photos through Photos
  When the local operator confirms "Clear local data"
  Then an output window titled "Clear local data" shows each deleted path and ends with "Done. Start the data server to reinitialize."
  And the files in the watched folder stay where they were
  When the local operator starts the data server again
  Then the Data Server card says "No folders are watched yet."
  And the This Machine section still names the same cloud and the same signed-in member
```

- **Notes:** A signed-in computer then gets its library back from the cloud, which [sync.md](sync.md) owns.

```gherkin
@local
@intent:confirmed
Scenario: [LDS-098] A local operator who clears local data finds this computer's apps uninstalled and their data gone
  Given the local operator installed Photos on a computer that has not joined a cloud
  And a member imported photos and made albums in Photos
  When the local operator confirms "Clear local data" and starts the data server again
  Then the dashboard no longer shows Photos as installed on this computer
  And after the local operator installs Photos again, Photos shows no photos and no albums
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-103] A local operator who chooses Clear local data sees the apps it uninstalls named
  Given the local operator installed Photos on a computer
  When the local operator chooses "Clear local data"
  Then the confirmation names Photos among the apps it uninstalls from this computer, with their data
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-094] A local operator who cancels Clear local data finds nothing changed
  Given the local operator opened the "Clear local data" dialog
  When the local operator presses "Cancel"
  Then the dialog closes
  And the library, watched folders, and apps stay as they were at the next start
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-095] A local operator who runs the reset script is asked to confirm unless the local operator passes `--yes`
  Given the data server is stopped
  When the local operator runs `scripts/reset-local-data.sh` in a terminal
  Then the script lists the paths it will delete and asks "Continue? [y/N] "
  And any answer but "y" or "Y" prints "Aborted." and deletes nothing
  And `--yes` or `-y` skips the question
```

```gherkin
@local
@intent:confirmed
Scenario: [LDS-096] A local operator cannot run the reset script while the data server runs
  Given the data server runs
  When the local operator runs `scripts/reset-local-data.sh --yes`
  Then the local operator sees the script refuse, with a message to stop the data server first
  And the local operator finds the library unchanged
```

- **Notes:** Implementation gap: the script does not check, and deletes the database and stored files from under the running data server.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [LDS-116] A local operator previews from the terminal what a reset of local data deletes, and nothing changes
  Given the computer holds a library and watched folders
  When the local operator runs "starkeep reset-local"
  Then the output says "Would delete:" and lists the object files folder, the database files, and the watched-folder list
  And the output ends with "Run `starkeep reset-local --apply` to delete them."
  And the local operator finds the library unchanged
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "lists what it would delete without --apply, and deletes nothing (LDS-116)" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [LDS-117] A local operator who resets local data from the terminal while the data server runs finds it running again on an empty library
  Given the data server runs
  When the local operator runs "starkeep reset-local --apply"
  Then the output says "Stopping the data server…", then "Deleted <count> item(s) in <folder>."
  And the output says the data server started again
  And the Data Server card says "No folders are watched yet."
  And the local operator keeps the config, the credentials, the files in the watched folders, and the cloud's data
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "stops the data server, deletes the library, and starts it again (LDS-117)" (integration, local). No test checks the Data Server card or the watched folders' files.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [LDS-118] A local operator with no local data to reset is told there is nothing to delete
  Given the computer holds no library, database, or watched-folder list
  When the local operator runs "starkeep reset-local"
  Then the output says "Nothing to delete in <folder>."
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "says there is nothing to delete in an empty folder (LDS-118)" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [LDS-126] A local operator whose config.json does not parse is told which file, and nothing overwrites it
  Given "~/.starkeep/config.json" holds text that is not a JSON object
  When the local operator runs a starkeep command that changes the configuration, such as "starkeep source add ~/starkeep-apps"
  Then the output says "<home>/.starkeep/config.json does not hold a JSON object, so Starkeep left it alone. Fix the file, or move it away to start over, then run the command again."
  And the command exits with status 1
  And the file keeps its text, with the cloud fields in it
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "names a file that does not parse, and leaves it alone" (integration, local).
