# App lifecycle

This file specifies how apps arrive on, run on, change on, and leave a Starkeep deployment. The local operator works in Admin's local sections and runs install and upgrade commands on this computer. The cloud operator works in Admin's cloud sections and runs install, uninstall, and teardown commands against the AWS account. Members appear where they see the result of an install or an uninstall, and app developers appear where an update or an uninstall changes what their app receives. The scope covers app discovery, the consent dialog, local and cloud installs, starting and stopping local apps, updates, uninstalls and the data they keep, the teardown of every cloud app, the dashboard's app cards, and the manifest errors that app developers and both operators see.

Related files:

- [cloud-setup.md](cloud-setup.md): deploying the cloud, cloud Drive, and the full cloud teardown
- [users-and-access.md](users-and-access.md): sign-in on every surface, app credentials at request time, and who reaches which route
- [local-data-server.md](local-data-server.md): the local data server's own start and stop, and running several instances
- [shared-data.md](shared-data.md): shared records, labels, and public links
- [residency-and-stand-ins.md](residency-and-stand-ins.md): what the archive-quality setting does
- [app-data.md](app-data.md): app tables and rows, scheduled jobs, and the credential vault
- [sync.md](sync.md): what syncs, including the effects of version skew
- [cloud-runtime.md](cloud-runtime.md): serving a cloud app's files and requests
- [drive.md](drive.md): the Drive app
- [app-development.md](app-development.md): writing an app and its manifest

## Finding apps

### Discover apps folders

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-001] A local operator sees one app card for a registered folder that holds a manifest
  Given the local operator registered a folder in Discover apps
  And the folder holds a starkeep.manifest.json file and a subfolder that holds another manifest
  When the local operator opens the dashboard
  Then the dashboard shows one app card for the folder's own manifest
  And the dashboard shows no card for the subfolder's manifest
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-002] A local operator sees a card for each direct subfolder that holds a manifest in a registered folder of apps
  Given the local operator registered a folder that holds no manifest of its own
  And the folder holds two subfolders with manifests, a node_modules folder with a manifest, a dot-folder with a manifest, and a manifest two levels down
  When the local operator opens the dashboard
  Then the dashboard shows a card for each of the two subfolders
  And the dashboard shows no card for the node_modules folder, the dot-folder, or the deeper manifest
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-003] A local operator sees which apps each registered folder contributed
  Given the local operator registered several folders
  When the local operator opens Discover apps
  Then each folder shows a line naming the apps it contributed, such as "Found Photos, Drive, and 2 more apps"
  And a folder that contributed no app and has no problem shows "No apps found"
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-004] A local operator sees why Discover apps skipped a folder
  Given the local operator registered a folder where <situation>
  When the local operator opens Discover apps
  Then the folder's status shows "<reason>"
  And the dashboard shows no card for the skipped folder

  Examples:
    | situation                                      | reason                                                           |
    | the path does not exist                        | The folder does not exist.                                       |
    | the path is a file                             | The path is a file, not a folder.                                |
    | the folder cannot be read                      | The folder could not be read: <the system's error>               |
    | an app subfolder's manifest is not valid JSON  | Invalid manifest found for <subfolder>: <the parser's error>     |
    | an app subfolder's manifest fails the schema   | Invalid manifest found for <subfolder>: <the first schema error> |
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-005] A local operator sees that an app written for a newer protocol needs a newer platform
  Given the local operator registered an app folder whose manifest needs a newer Starkeep protocol than this checkout speaks
  And the manifest also uses a field this checkout does not know
  When the local operator opens Discover apps
  Then the folder's status says the app needs the newer protocol and names the version this checkout speaks
  And the status does not list the unknown field
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-006] A local operator sees both folders reported, and no card, when two folders hold one app id
  Given the local operator has not installed the app "dice" on this computer
  And two registered folders each hold an app whose manifest id is "dice"
  When the local operator opens the dashboard
  Then the dashboard shows no card for "dice"
  And Discover apps reports under each folder that its "dice" uses an id the other folder also uses
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-007] A local operator sees one card for an app that two registered folders reach
  Given the local operator registered an app's folder and also the folder that contains it
  When the local operator opens the dashboard
  Then the dashboard shows one card for the app
  And Discover apps reports no conflict, and credits the app to both registered folders
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-008] A local operator sees an alert icon on the Discover apps button while any folder has a problem
  Given one folder the local operator registered has a problem that Discover apps reports
  When the local operator looks at the dashboard header
  Then the Discover apps button shows an alert icon
  When the local operator fixes the folder and reopens Discover apps
  Then the alert icon is gone
```

- **Notes:** The modal rescans each time it opens, so a folder fixed on disk shows as fixed.

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-009] A local operator who adds or removes a registered folder sees the dashboard's app cards update
  Given the dashboard shows no card for an app in "~/starkeep-apps"
  When the local operator adds "~/starkeep-apps" in Discover apps
  Then the dashboard shows a card for each app in that folder without a reload
  When the local operator removes "~/starkeep-apps" in Discover apps
  Then the cards for that folder's apps that are not installed disappear
```

- **Notes:** An installed app keeps its card after its folder leaves the list. See APP-LIFE-046.

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-010] A local operator who empties the folder list sees no apps and a message that says so
  Given the local operator removed every folder from Discover apps
  When the local operator opens Discover apps
  Then the dialog says "No directories — no apps will be discovered."
  And the dashboard shows no app cards from folders
  And Discover apps does not list the example-app folder again on the local operator's next visit
```

### The example app

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-011] A local operator who opens Admin for the first time sees the Example App card
  Given the local operator has never run Admin on this computer, so no Admin config file exists
  When the local operator opens the dashboard
  Then Discover apps lists core's example-app folder
  And the dashboard shows the Example App card
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-012] A local operator who hides the Example App removes its folder from Discover apps
  Given the dashboard shows the Example App card, and the example app is not installed
  When the local operator chooses Hide from the card's menu
  Then a confirmation asks to hide the Example App and names the folder to add in Discover apps to show it again
  When the local operator confirms
  Then the Example App card disappears
  And Discover apps no longer lists the example-app folder, and still lists every other folder
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-013] A local operator finds Hide only on the bundled example while it is not installed
  Given the dashboard shows <card>
  When the local operator opens the card's menu
  Then the menu <offers> Hide

  Examples:
    | card                                                         | offers         |
    | the Example App from core's example-app folder, not installed | offers         |
    | a copy of the example app in another folder                  | does not offer |
    | the Example App, installed on this computer                  | does not offer |
    | the Example App while its install status is unknown          | does not offer |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-014] A local operator who hides an Example App installed only in the cloud still sees its cloud tile
  Given the example app is installed in the cloud and not on this computer
  When the local operator hides the Example App card
  Then the local Example App card disappears
  And the Cloud section still shows the Example App tile as Installed
```

## The consent dialog

### What the dialog shows

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-015] A local operator sees each file category an app asks for, with its access, before a local install
  Given an app's manifest grants <types> with <access> access<metadata>
  When the local operator clicks Install on the app's card
  Then the consent dialog lists the category "<category>"
  And the category shows "files: <files>" and "metadata: <meta>"
  And expanding the category lists its formats in the manifest's order

  Examples:
    | types                               | access    | metadata             | category              | files        | meta         |
    | image/png, image/jpeg, image/avif   | readwrite |                      | Images                | read + write | read + write |
    | image/jpeg                          | read      | and metadata write   | Images                | read         | read + write |
    | video/mp4                           | read      |                      | Videos                | read         | read         |
    | document/pdf and text/plain         | read      |                      | Documents, Text files | read         | read         |
    | example/note                        | readwrite |                      | Example files         | read + write | read + write |
```

- **Notes:** Readwrite access includes metadata write in every environment. A manifest asks for metadata write separately only with read access. Implementation gap: the dialog shows "metadata: read" for a readwrite category without metadataWrite, and the local data server refuses metadata writes from such an app.

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-187] A cloud operator sees each file category an app asks for, with its access, before a cloud install
  Given an app's manifest grants <types> with <access> access<metadata>
  When the cloud operator clicks Install in cloud on the app's web tile
  Then the consent dialog lists the category "<category>"
  And the category shows "files: <files>" and "metadata: <meta>"
  And expanding the category lists its formats in the manifest's order

  Examples:
    | types                               | access    | metadata             | category              | files        | meta         |
    | image/png, image/jpeg, image/avif   | readwrite |                      | Images                | read + write | read + write |
    | image/jpeg                          | read      | and metadata write   | Images                | read         | read + write |
    | video/mp4                           | read      |                      | Videos                | read         | read         |
    | document/pdf and text/plain         | read      |                      | Documents, Text files | read         | read         |
    | example/note                        | readwrite |                      | Example files         | read + write | read + write |
```

- **Notes:** APP-LIFE-015 states the same dialog for a local install.

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-016] A local operator sees that an app with no file grants accesses no files, before a local install
  Given an app's manifest grants no file types
  When the local operator clicks Install on the app's card
  Then the consent dialog says "<app name> doesn't access any of your files."
  And the dialog lists no categories
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-188] A cloud operator sees that an app with no file grants accesses no files, before a cloud install
  Given an app's manifest grants no file types
  When the cloud operator clicks Install in cloud on the app's web tile
  Then the consent dialog says "<app name> doesn't access any of your files."
  And the dialog lists no categories
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-017] A local operator sees all-files access for the User-Data-Owner in the consent dialog
  Given an app's manifest asks for access to all files as the User-Data-Owner
  When the local operator opens its consent dialog
  Then the dialog says the app is the User-Data-Owner with read and write access to all files, including unclassified ones
  And the dialog lists no per-category grants
```

- **Notes:** Only Drive may declare all-files access. See APP-LIFE-175 and [drive.md](drive.md).

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-018] A local operator sees which content an app's public links can expose, before a local install
  Given an app's manifest turns on public sharing and grants <grants>
  When the local operator opens its consent dialog for a local install
  Then a "Public links" panel says "<name> can create web links to your <content>. Anyone who has a valid link can view the content you share without signing in."

  Examples:
    | grants                          | content                         |
    | image and video types           | images and videos               |
    | example types                   | example files                   |
    | image, video and document types | images, videos and documents    |
    | no types                        | files                           |
```

- **Notes:** An app without public sharing shows no panel (`public-sharing-consent.test.ts` › "publicSharingConsent says nothing for an app without public sharing"). What a public link does belongs to [shared-data.md](shared-data.md).

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-189] A cloud operator sees which content an app's public links can expose, before a cloud install
  Given an app's manifest turns on public sharing and grants <grants>
  When the cloud operator opens its consent dialog for a cloud install
  Then a "Public links" panel says "<name> can create web links to your <content>. Anyone who has a valid link can view the content you share without signing in."

  Examples:
    | grants                          | content                         |
    | image and video types           | images and videos               |
    | example types                   | example files                   |
    | image, video and document types | images, videos and documents    |
    | no types                        | files                           |
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-019] A local operator sees an app's background jobs in the consent dialog, before a local install
  Given an app's manifest declares a read job "digest" and a read-and-write job "tidy"
  When the local operator opens its consent dialog for a local install
  Then a "Background jobs" panel names each job with its description
  And the panel says "digest" may read, and "tidy" may read and write, the data of each user who turns it on
  And the panel says each user turns each job on separately, and the job runs in the cloud for that user only
```

- **Notes:** What a job does belongs to [app-data.md](app-data.md).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-190] A cloud operator sees an app's background jobs in the consent dialog, before a cloud install
  Given an app's manifest declares a read job "digest" and a read-and-write job "tidy"
  When the cloud operator opens its consent dialog for a cloud install
  Then a "Background jobs" panel names each job with its description
  And the panel says "digest" may read, and "tidy" may read and write, the data of each user who turns it on
  And the panel says each user turns each job on separately, and the job runs in the cloud for that user only
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-020] A local operator sees the dependency command a local install runs, and its folder
  Given an app's folder holds a package.json and a pnpm-lock.yaml
  When the local operator opens the app's consent dialog for a local install
  Then the dialog says Install runs "pnpm install --frozen-lockfile" in the app's folder, which runs the app's own install scripts
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-191] A cloud operator sees the dependency command a cloud web install runs, and its folder
  Given an app's folder holds a package.json and a pnpm-lock.yaml
  When the cloud operator opens the app's consent dialog for a cloud web install
  Then the dialog says Install runs "pnpm install --frozen-lockfile" in the app's folder, which runs the app's own install scripts
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-021] A local operator sees that Install will not run a command off the approved list
  Given an app's manifest declares the install command "make install"
  When the local operator opens the app's consent dialog
  Then the dialog says Install will not run "make install", gives the reason, and names the folder to run it in by hand
```

```gherkin
@mobile
@intent:confirmed
Scenario: [APP-LIFE-022] A cloud operator sees no dependency command in a mobile registration's dialog
  Given an app offers a mobile build and was never installed
  When the cloud operator clicks Register on the app's mobile tile
  Then the consent dialog shows the app's file access
  And the dialog names no dependency command
  And the approve button reads "Approve & Register"
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-023] A local operator is asked for the archive quality once, when installing an app that reads photos or videos on this computer
  Given the local operator never set the archive quality
  And the library holds no photo originals
  When the local operator clicks Install on an app that reads photos
  Then the consent dialog shows a "Quality kept when originals archive" step with the default chosen
  And the step asks only about the categories, photos or videos, that the library holds no originals of yet
  When the local operator changes the value and clicks Approve & Install
  Then the app installs, and the library's settings show the changed quality
  And a later Install of another photo app shows no quality step
  And an Install of an app that reads no photos or videos shows no quality step
```

- **Notes:** What the setting does belongs to [residency-and-stand-ins.md](residency-and-stand-ins.md).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-196] A cloud operator sees no archive-quality step in a cloud install's dialog
  Given no one ever set the archive quality, and the library holds no photo originals
  When the cloud operator clicks Install in cloud on the web tile of an app that reads photos
  Then the consent dialog shows no "Quality kept when originals archive" step
```

- **Notes:** APP-LIFE-023 states the step in a local install's dialog.

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-024] A local operator who cancels the consent dialog installs nothing
  Given the local operator opened the consent dialog from Install on an app's card
  When the local operator clicks Cancel
  Then the dialog closes
  And the app's card still reads Not installed
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-192] A cloud operator who cancels a cloud install's consent dialog installs nothing
  Given the cloud operator opened the consent dialog from Install in cloud on an app's web tile
  When the cloud operator clicks Cancel
  Then the dialog closes
  And the app's web tile still reads Not installed
```

### The approved manifest is the one installed

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-025] A local operator cannot install an app whose manifest changed after the approval
  Given the local operator opened the consent dialog for an app
  And another terminal changed the app's manifest in its folder
  When the local operator clicks Approve & Install
  Then the install fails with "changed after you approved its manifest. Review the new manifest and install again."
  And the app is not installed, and no credentials file exists for it
  And the local operator's next Install shows the new manifest
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-026] A cloud operator sees a cloud install refused when the app's manifest changed after the approval
  Given the cloud operator approved a cloud install of an app
  And another program changed the app's manifest in its folder before the deploy started
  When the cloud operator watches the install panel
  Then the install panel shows that the folder changed after the approval, and that the cloud operator should review the new manifest and deploy again
  And nothing deploys
  And the panel offers no Retry, and the cloud operator's next Install in cloud shows the new manifest
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-027] A local operator finds the same consent words in the terminal install and the dialog
  Given an app whose manifest has <content>
  When the local operator runs the terminal install for the app
  And the local operator opens the app's consent dialog in Admin
  Then both show the same sentences, in the same order

  Examples:
    | content                                             |
    | no file grants and no dependency install            |
    | file grants, public links and a dependency install  |
    | background jobs                                     |
    | User-Data-Owner access and a refused dependency install |
```

## Installing on this computer

### Install from the dashboard

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-028] A local operator who installs an app on this computer finds it Installed, with its credentials file
  Given the local data server is running
  And the dashboard shows the card for an app that is not installed
  When the local operator clicks Install and then Approve & Install
  Then the card reads Installed and offers Start
  And the app's credentials file exists, readable only by the computer account that runs Admin
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-029] A local operator cannot install an app while the local data server is offline
  Given the local data server is stopped
  And the app's card still reads Not installed, rather than Status unknown
  When the local operator looks at the card of an app that is not installed
  Then the Install button is disabled
  And hovering it says "Start the local data server before installing"
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-030] A local operator sees the dependency command and its output during a local install
  Given an app's folder holds a package.json and a lockfile
  When the local operator approves the app's install
  Then a dialog titled "Installing <app>'s dependencies" names the command and streams its output
  And the dialog closes when the command succeeds
  And the card then reads Installed
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-031] A local operator whose dependency command fails finds the app not installed
  Given an app's dependency install will fail
  When the local operator approves the app's install
  Then the dependency output stays open and ends with an error naming the command and its exit code
  And the card still reads Not installed
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-032] A local operator installs an app whose dependency command is refused, and sees a notice
  Given an app's manifest declares an install command off the approved list
  When the local operator approves the app's install
  Then the app installs and its card reads Installed
  And a "Dependencies not installed" notice names the command, the reason, and the folder to run it in before starting the app
```

- **Notes:** Start then refuses the app until its dependencies resolve. See APP-LIFE-057.

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-033] A local operator sees the dependency command a local install picks from the app's folder
  Given an app's manifest declares no install command
  And the app's folder <layout>
  When the local operator opens the app's consent dialog for a local install
  Then the dialog <outcome>

  Examples:
    | layout                                                         | outcome                                                     |
    | holds pnpm-lock.yaml                                           | names "pnpm install --frozen-lockfile" in the app's folder   |
    | holds package-lock.json or npm-shrinkwrap.json                 | names "npm ci" in the app's folder                          |
    | holds a yarn.lock                                              | names Yarn's frozen install in the app's folder             |
    | holds bun.lock or bun.lockb                                    | names "bun install --frozen-lockfile" in the app's folder    |
    | sits in a pnpm workspace that lists it                         | names the frozen pnpm install at the workspace root          |
    | sits in a pnpm workspace that does not list it                 | names a pnpm install with "--ignore-workspace"               |
    | holds a package.json with no lockfile and no workspace         | names "pnpm install" in the app's folder                    |
    | holds no package.json                                          | names no dependency command                                 |
    | sits in core's own workspace                                   | names no dependency command                                 |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-193] A cloud operator sees the dependency command a cloud web install picks from the app's folder
  Given an app's manifest declares no install command
  And the app's folder <layout>
  When the cloud operator opens the app's consent dialog for a cloud web install
  Then the dialog <outcome>

  Examples:
    | layout                                                         | outcome                                                     |
    | holds pnpm-lock.yaml                                           | names "pnpm install --frozen-lockfile" in the app's folder   |
    | holds package-lock.json or npm-shrinkwrap.json                 | names "npm ci" in the app's folder                          |
    | holds a yarn.lock                                              | names Yarn's frozen install in the app's folder             |
    | holds bun.lock or bun.lockb                                    | names "bun install --frozen-lockfile" in the app's folder    |
    | sits in a pnpm workspace that lists it                         | names the frozen pnpm install at the workspace root          |
    | sits in a pnpm workspace that does not list it                 | names a pnpm install with "--ignore-workspace"               |
    | holds a package.json with no lockfile and no workspace         | names "pnpm install" in the app's folder                    |
    | holds no package.json                                          | names no dependency command                                 |
    | sits in core's own workspace                                   | names no dependency command                                 |
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-034] A local operator sees that a local install will not run an inferred command it cannot run safely
  Given an app's manifest declares no install command
  And the app's folder <layout>
  When the local operator opens the app's consent dialog for a local install
  Then the dialog says Install will not run the command, because <reason>, and names <what to run>

  Examples:
    | layout                                                 | reason                                                       | what to run                                       |
    | sits inside an npm project at a folder above it        | the app sits inside that npm project, outside its folder      | that project's install, in that project's folder  |
    | holds a pnpm-workspace.yaml that lists no packages      | the file hides the app from the workspace that lists it       | the outer workspace's install, after deleting the file |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-194] A cloud operator sees that a cloud web install will not run an inferred command it cannot run safely
  Given an app's manifest declares no install command
  And the app's folder <layout>
  When the cloud operator opens the app's consent dialog for a cloud web install
  Then the dialog says Install will not run the command, because <reason>, and names <what to run>

  Examples:
    | layout                                                 | reason                                                       | what to run                                       |
    | sits inside an npm project at a folder above it        | the app sits inside that npm project, outside its folder      | that project's install, in that project's folder  |
    | holds a pnpm-workspace.yaml that lists no packages      | the file hides the app from the workspace that lists it       | the outer workspace's install, after deleting the file |
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-035] A local operator sees a local install refuse a declared install command off the approved list
  Given an app's manifest declares the install command <command>
  When the local operator opens the app's consent dialog for a local install
  Then the dialog says Install will not run the command and gives the reason "<reason>"

  Examples:
    | command                          | reason                                     |
    | ./scripts/install.sh             | ./scripts/install.sh is not an approved package manager. |
    | /usr/bin/pnpm install            | /usr/bin/pnpm is not an approved package manager. |
    | make install                     | make is not an approved package manager.   |
    | pnpm add left-pad                | pnpm add is not an approved install.       |
    | pnpm with no arguments           | pnpm is not an approved install.           |
    | npm install --unsafe-perm        | --unsafe-perm is not an approved flag.     |
    | pnpm install && rm               | && is not an approved flag.                |
    | pnpm install, run from ../..     | Its folder is outside the app's folder.    |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-195] A cloud operator sees a cloud web install refuse a declared install command off the approved list
  Given an app's manifest declares the install command <command>
  When the cloud operator opens the app's consent dialog for a cloud web install
  Then the dialog says Install will not run the command and gives the reason "<reason>"

  Examples:
    | command                          | reason                                     |
    | ./scripts/install.sh             | ./scripts/install.sh is not an approved package manager. |
    | /usr/bin/pnpm install            | /usr/bin/pnpm is not an approved package manager. |
    | make install                     | make is not an approved package manager.   |
    | pnpm add left-pad                | pnpm add is not an approved install.       |
    | pnpm with no arguments           | pnpm is not an approved install.           |
    | npm install --unsafe-perm        | --unsafe-perm is not an approved flag.     |
    | pnpm install && rm               | && is not an approved flag.                |
    | pnpm install, run from ../..     | Its folder is outside the app's folder.    |
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-036] A local operator whose install fails sees the install steps with the reason on top
  Given an app's install will fail at a schema step
  When the local operator approves the app's install
  Then a dialog titled "Install of <app> failed" opens
  And the dialog shows the failure's reason above the recorded install steps
  And the step that failed shows its error
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-037] A local operator sees the install and uninstall steps of an installed app
  Given an app is installed on this computer
  When the local operator chooses "Install steps…" from the card's menu
  Then a dialog lists each install and uninstall step with its status and time
  And a failed step shows its error
  And Refresh reloads the list
```

- **Notes:** With the local data server stopped, the dialog shows "Could not reach local-data-server" (`install-status.test.ts` › "when the data server is not running answers 502 with the reason rather than throwing").

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-038] A local operator cannot install an app that needs a newer protocol
  Given an app's manifest needs a Starkeep protocol newer than this computer's local data server speaks
  When the local operator tries to install the app
  Then the install fails with a message that names the version the app needs and the version the local data server speaks
  And the message says to update and restart the local data server
  And the app is not installed
```

- **Notes:** An app written for an older major version gets a message to install a version built for the current protocol (`protocol-check.test.ts` › "protocolRefusal says to update the app when the platform is on a later major version"). Discover apps usually reports the same app first. See APP-LIFE-005.

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-039] A local operator cannot reinstall an app from its folder once the folder holds another app
  Given the app "dice" is installed from a folder
  And that folder now holds a manifest with another app id
  When the local operator reinstalls "dice"
  Then the install fails, saying the folder now holds another app's manifest
  And the "dice" card still reads Installed, and its credentials file remains
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-040] A local operator sees an error when the local data server does not answer an install
  Given the local data server stopped after the dashboard loaded
  When the local operator approves an app's install
  Then the install fails with an error saying Admin could not reach the local data server
  And the card does not read Installed
```

### Install from the terminal

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-041] A local operator reads the consent words in the terminal install and installs only after a yes
  Given the local data server is running
  When the local operator runs "cli:install-app-local <app folder>" in a terminal
  Then the command prints "Install <app>?" and the same consent words as Admin's dialog
  And the command asks "Approve and install? [y/N]"
  When the local operator answers anything other than yes
  Then the command prints "Not installed." and installs nothing
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-042] A local operator who passes `--yes` installs without being asked
  Given the local data server is running
  When the local operator runs "cli:install-app-local <app folder> --yes"
  Then the command prints the consent words, installs the app's dependencies, and registers the app
  And the command prints where the app's credentials file is
  And the command says to start the app from Admin, and to restart it if it already ran
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-043] A local operator whose script runs the terminal install without `--yes` installs nothing
  Given the local operator runs commands from a script with no terminal attached
  When the local operator runs "cli:install-app-local <app folder>" from that script without "--yes"
  Then the command says there is no terminal to ask for approval and to pass "--yes"
  And the command exits with an error and installs nothing
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-044] A local operator gets an early refusal from the terminal install when the local data server does not answer
  Given the local data server is stopped
  When the local operator runs "cli:install-app-local <app folder>"
  Then the command says the local data server is not answering and to start it from Admin
  And the command prints no consent words and runs no dependency install
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-045] A local operator cannot install from the terminal a folder with no manifest or an invalid one
  When the local operator runs "cli:install-app-local" on a folder with <problem>
  Then the command prints "<message>" and exits with an error
  And nothing installs

  Examples:
    | problem                  | message                                                    |
    | no starkeep.manifest.json | <folder> holds no starkeep.manifest.json.                 |
    | an invalid manifest       | The app's manifest failed validation: <first error>       |
```

## Installed apps on this computer

### Install pinning

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-046] A local operator keeps an installed app's card, folder and approved manifest when the registered folders change
  Given the app "dice" is installed from "~/apps/dice"
  When the local operator removes "~/apps" from Discover apps
  Then the dashboard still shows the "dice" card as Installed, with the manifest the local operator approved
  And Start still runs "dice" from "~/apps/dice"
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-047] A local operator sees a conflict for another folder that holds an installed app's id
  Given the app "dice" is installed from "~/apps/dice"
  And the local operator registers another folder that holds an app with the id "dice"
  When the local operator opens Discover apps
  Then the other folder's status says its "dice" uses an id already installed from "~/apps/dice"
  And the dashboard shows one "dice" card, for the installed app
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-048] A local operator can uninstall, but not start, an app whose folder is gone
  Given the app "dice" is installed
  And the folder the local operator installed it from was deleted
  When the local operator opens the dashboard
  Then the "dice" card reads Installed and says "Source folder not found: <folder>. Restore the folder to start the app. Uninstalling keeps its data on this machine."
  And Start is disabled
  And the menu still offers Uninstall
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-049] A local operator sees an installed app keep its approved manifest when its folder holds an invalid one
  Given the app "dice" is installed
  And its folder's manifest now fails validation, or names another app id
  When the local operator opens the dashboard
  Then the card replaces its description with a note naming the error, saying Starkeep keeps using the manifest the local operator approved
  And Start and Uninstall stay available
  And Start offers no update
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-050] A local operator learns that Start applies an installed app's changed manifest
  Given the app "dice" is installed
  And its folder now holds a valid but different manifest
  When the local operator opens the dashboard
  Then a stopped app's card says "Its folder holds a changed manifest. Start the app to apply it."
  And a running app's card says "Its folder holds a changed manifest. Stop and start the app to apply it."
  And the card's menu offers no separate update action
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-051] A local operator starts an app installed before Starkeep recorded install folders from the folder Discover apps finds
  Given an app was installed before Starkeep recorded each install's folder
  When the local operator opens the dashboard and clicks Start
  Then the card shows the app from the folder Discover apps finds
  And Start runs the app from that folder
```

- **Notes:** A reinstall pins the folder (`packages/admin-installer/__tests__/local-install.test.ts` › "the folder an app was installed from moves when a reinstall names a folder, and stays when it names none").

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-052] A local operator sees Status unknown on every card while the local data server is offline
  Given the local data server is stopped
  When the local operator opens the dashboard
  Then every discovered app's card reads "Status unknown"
  And each card says to start the local data server to see the app's status, and offers no Install
  When the local operator starts the local data server
  Then the cards show their real install status without a reload
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-053] A local operator sees an error when the app list fails to load
  Given Admin cannot load its app list
  When the local operator opens the dashboard
  Then the dashboard shows the failure
  And the dashboard does not show an empty list of apps as if none existed
```

## Starting and stopping apps on this computer

### Start and Stop

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-054] A local operator starts an app from the folder it was installed from, and opens it
  Given the app "dice" is installed from "~/apps/dice"
  And another registered folder holds a copy of "dice"
  When the local operator clicks Start dice
  Then the card shows "Starting…" and then "Running :<port>"
  And Open dice opens the app at "http://localhost:<port>"
  And the app runs from "~/apps/dice" with the run command from the manifest the local operator approved
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-055] A local operator who stops an app finds it shut down
  Given the app "dice" is running
  When the local operator chooses Stop from the card's menu
  Then the card shows "Stopping…" and then offers Start dice
  And the app's address no longer answers
  And an app that ignores the polite stop request is stopped forcibly after a grace period
```

- **Notes:** Stop refuses to signal another program that holds the app's port (`daemon.test.ts` › "the ps guard on port-based stop refuses to signal a non-dev-server process occupying the recorded port").

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-056] A local operator sees the log of an app that dies at startup
  Given an app crashes as soon as it starts, or its run command does not exist
  When the local operator clicks Start
  Then the dashboard shows an error that includes the end of the app's log or the spawn error
  And the card offers Start again
```

- **Notes:** An app that starts but never comes online within 20 seconds shows "<app> did not come online within 20s" (`apps/admin-web/src/components/LocalAppsSection.tsx`). No test covers that message.

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-057] A local operator cannot start an app whose dependencies do not resolve
  Given an installed app declares packages that its folder cannot resolve
  When the local operator clicks Start
  Then the dashboard shows an error that names the missing packages and the install command to run, and where
  And the app does not start
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-058] A local operator cannot start an app with no run command
  Given an installed app's manifest has no localRun block
  When the local operator clicks Start
  Then the dashboard shows that the app has no localRun block and cannot be started from Admin
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-059] A local operator cannot start a second copy of an app that already runs
  Given the app "dice" already runs at "http://localhost:20124", for example started from another tab
  When the local operator clicks Start dice in a tab whose status is stale
  Then the dashboard shows "'dice' is already running at http://localhost:20124."
  And the dashboard offers no other port
  And the running copy keeps its port, and Stop still stops it
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-060] A local operator cannot start an app whose folder is gone, and learns how to recover
  Given the app "dice" is installed
  And the folder it was installed from no longer holds a manifest, and a tab whose status is stale still offers Start
  When the local operator clicks Start dice
  Then the dashboard shows that "dice" cannot start because its source folder, named in the message, no longer holds a manifest
  And the message says to restore the folder to start the app
  And the message says uninstalling keeps the app's data on this computer
```

- **Notes:** Implementation gap: the start route's refusal message still says uninstalling deletes the data (`apps/admin-web/src/routes/exec-daemon.ts`).

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-061] A local operator sees Open disabled, with the reason, for a running app that reports no port
  Given an app runs but Admin found no port for it
  When the local operator looks at the app's card
  Then the Open button is disabled
  And hovering it says "No port found. Stop and restart to fix"
```

### Ports

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-062] A local operator finds an app on the same port, with its browser storage, after a restart
  Given the local operator started "dice" and it runs on a port
  When the local operator stops "dice" and starts it again, right away or later
  Then "dice" runs on the same port
  And the data "dice" kept in the browser is still there
```

- **Notes:** An app's first port is a hash of its id inside the range (`app-ports.test.ts` › "appPort gives an app the hash of its id first, inside the range"). An update keeps the port. See APP-LIFE-076.

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-063] A local operator who reinstalls an app finds it on its old port, with its browser storage
  Given "dice" ran on a port, and the local operator uninstalled and installed it again
  And no other program or app took that port in the meantime
  When the local operator starts "dice"
  Then "dice" runs on the port it had before
  And "dice" finds the browser storage it had before, as its kept data comes back (APP-LIFE-142)
```

- **Notes:** Best effort: each app's first port comes from its app id, and the app moves to the next free port when another program or app holds that one. Implementation gap: a reinstall retires the old port forever and gives the app a new one, so its browser storage stays behind.

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-064] A local operator whose app's port is held sees an alert that offers another port
  Given another program holds the port "dice" last ran on
  When the local operator clicks Start dice
  Then an alert says "dice cannot start" because its port is in use, and asks whether dice already runs at "http://localhost:<port>", with a link
  And the alert offers "Choose another port"
  And the alert says that on another port, dice starts with empty browser storage
```

- **Notes:** Any other failed Start shows a plain error with no port choice (`start-port-in-use.test.tsx` › "Start when the app's port is in use shows any other failed Start as a plain error, with no port choice").

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-065] A local operator who chooses another port finds the app running on a new port
  Given the port-in-use alert for "dice" is showing
  When the local operator clicks Choose another port
  Then the alert clears
  And "dice" runs on a new port, which later starts keep
  And later starts of "dice" never return to the held port
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-066] A local operator finds apps on ports inside the configured range, never on ones browsers refuse
  Given Admin runs with a custom app port range
  When the local operator starts several apps for the first time
  Then each app gets a port inside the range
  And no app gets a port that browsers refuse to load
  And an app whose first-choice port is held moves past it once and keeps the port it moved to
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-067] A local operator whose port range is malformed cannot start an app for the first time, and sees the variable named
  Given Admin runs with an app port range variable that is reversed, privileged, too high, or not two numbers
  When the local operator starts an app for the first time
  Then the start fails with a message that names the variable
  When the local operator starts an app that already has a recorded port
  Then the app starts on its recorded port
  And Choose another port is refused, and the app keeps its recorded port
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-068] A local operator who starts two apps at once finds them on two different ports
  Given two installed apps have never started
  When the local operator starts both at the same moment
  Then each app runs on its own port
```

- **Notes:** A second local data server instance's copy of an app runs on a different port. That behavior belongs to [local-data-server.md](local-data-server.md).

## Updating apps

### A changed manifest on this computer

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-069] A local operator who starts an app whose folder changed can update and start it in one step
  Given "dice" is installed on this computer and stopped
  And the manifest in its pinned folder changed since the install
  When the local operator clicks Start dice
  Then a dialog titled "Update Dice?" says "Dice's folder has changes to install. Choose the installs to update."
  And the box "Update Dice on this computer" is checked
  When the local operator clicks Update & Start
  Then the card reads Installed and Running
  And the app runs with the changed manifest
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-070] A local operator sees file access and public links in the update dialog only when the change affects them
  Given the manifest in an installed app's folder changed
  When the local operator opens the update dialog
  Then the dialog lists the app's file access only when the change alters the file access, the types, or all-files access
  And the dialog shows the public-links sentence only when the change turns public links on
  And a change of key order or an added default field shows no access section
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-071] A local operator who unchecks the local update sees a version-skew warning and starts the approved manifest
  Given the update dialog for "dice" is open from Start
  When the local operator unchecks "Update Dice on this computer"
  Then the dialog says "Running different app versions might affect syncing behavior."
  And the approve button reads "Start Dice"
  When the local operator clicks Start Dice
  Then "dice" runs with the manifest the local operator approved at install
  And the card still says Start applies the folder's change
```

- **Notes:** The effects of version skew on sync belong to [sync.md](sync.md).

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-072] A local operator who cancels the update dialog changes nothing
  Given the update dialog for "dice" is open from Start
  When the local operator clicks Cancel
  Then the dialog closes
  And "dice" stays stopped, and its card still says Start applies the folder's change
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-073] A local operator whose reinstall fails finds the app stopped, with the failure shown
  Given the update dialog for "dice" is open from Start
  And the reinstall will fail
  When the local operator clicks Update & Start
  Then the local operator sees the reinstall's error
  And "dice" stays stopped
```

- **Notes:** When the failure is that the folder changed again after the approval, the dashboard re-reads the app list so the card shows the newer change (`pinned-app-card.test.tsx` › "Start with a changed folder manifest re-reads the app list when the folder changed after the approval").

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-074] A local operator whose app is current starts it at once
  Given the manifest in an installed app's folder matches the approved manifest
  And the cloud install, if any, is current
  When the local operator clicks Start
  Then no update dialog opens
  And the app starts
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-075] A local operator who reinstalls a running app finds it stopped, and the next Start runs the new manifest
  Given "dice" runs on this computer
  When the local operator reinstalls "dice"
  Then the card reads Stopped
  And the next Start runs "dice" with the reinstalled manifest and credentials
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-076] An app developer whose app updates keeps its credentials, port and rows, and gets the newly declared tables and indexes
  Given the app developer's app "dice" is installed on this computer, holds rows, and has run on a port
  And its new manifest declares one more table and one more index
  When the app developer updates "dice" from Admin and starts it
  Then "dice" signs its requests with the credentials it had before
  And "dice" runs on the same port and finds all of its rows
  And "dice" can write to the new table, and its queries can use the new index
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-077] An app developer whose update asks for less file access finds the app's access narrowed at once
  Given the app developer's app "dice" reads photos and documents
  And its new manifest asks only for photos
  When the app developer updates "dice" from Admin
  Then "dice" can no longer read documents
  And "dice" still reads photos
```

```gherkin
@local
@intent:confirmed @suboptimal
Scenario: [APP-LIFE-078] An app developer whose update changes a column's declared type finds the stored type unchanged
  Given the app developer's app "dice" declares a column as text and holds rows
  And its new manifest declares the column as a number
  When the app developer updates "dice" from Admin
  Then "dice" still finds the column's existing values unchanged
  And "dice" reads the column with its old storage type
```

- **Suboptimal:** an update is not a migration. A changed column type that crosses a storage class needs an uninstall, a data deletion, and a reinstall.
- **Notes:** Row semantics belong to [app-data.md](app-data.md).

### Updating the cloud and this computer together

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-079] A local operator whose app is behind in both places finds the local app reinstalled and started after the cloud deploy
  Given "dice" is installed on this computer and in the cloud
  And its folder's manifest changed since both installs
  When the local operator clicks Start dice
  Then the update dialog checks "Update Dice on this computer"
  When the local operator clicks Update & Start
  Then after the cloud deploy succeeds, the card reads Running on this computer
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-209] A cloud operator whose app is behind in both places deploys the cloud first from the update dialog
  Given "dice" is installed on this computer and in the cloud
  And its folder's manifest changed since both installs
  When the cloud operator clicks Start dice
  Then the update dialog checks "Update Dice in the cloud"
  And the dialog says "The cloud update runs first and takes a few minutes."
  When the cloud operator clicks Update & Start
  Then the install panel streams the cloud deploy
```

- **Notes:** APP-LIFE-079 states the local reinstall that follows the cloud deploy.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-080] A local operator who unchecks the cloud update sees a version-skew warning and updates only this computer
  Given the update dialog for "dice" checks both installs
  When the local operator unchecks "Update Dice in the cloud"
  Then the dialog says "Running different app versions might affect syncing behavior."
  When the local operator clicks Update & Start
  Then no cloud deploy starts
  And "dice" runs on this computer with the changed manifest
```

- **Notes:** The effects of version skew on sync belong to [sync.md](sync.md).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-081] A local operator whose cloud deploy fails finds the update stopped before the local reinstall
  Given the update dialog for "dice" checks both installs
  And the cloud deploy will fail
  When the local operator clicks Update & Start
  Then the install panel shows Failed
  And "dice" stays stopped on this computer with its old manifest
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-082] A cloud operator whose cloud install alone is behind updates it from Start
  Given "dice" on this computer matches its folder
  And the cloud install of "dice" is behind its folder
  When the cloud operator clicks Start dice
  Then the update dialog offers only "Update Dice in the cloud", checked
  When the cloud operator clicks Update & Start
  Then the cloud deploy runs
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-210] A local operator whose cloud install alone is behind finds the app started on this computer after the cloud update
  Given "dice" on this computer matches its folder
  And the cloud install of "dice" is behind its folder
  When the local operator clicks Start dice and then Update & Start
  Then the cloud deploy runs first, and then "dice" starts on this computer
```

```gherkin
@cloud @mobile
@intent:confirmed
Scenario: [APP-LIFE-083] A cloud operator finds a cloud web app behind on changed code alone, but never a mobile-only registration
  Given the manifest in an app's folder matches the cloud install
  And the app's code in the folder changed since the cloud deploy
  When the cloud operator clicks Start on the app
  Then the update dialog offers the cloud web app's update when the cloud runs the web app
  And the app starts at once, with no dialog, when the cloud holds only a mobile registration
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-084] A local operator without a cloud sign-in sees the cloud choice disabled, with the reason and a warning
  Given "dice" is installed in the cloud, and its folder changed
  And no account with cloud operator rights is signed in to the cloud in Admin
  When the local operator clicks Start dice
  Then the cloud choice in the update dialog is disabled
  And the dialog says "Sign in to the cloud to update it."
  And the dialog says "Running different app versions might affect syncing behavior."
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-085] A local operator who starts a changed local-only app sees only the local update while the cloud registry is unread
  Given "dice" targets only this computer, and its folder changed
  And the cloud registry is <state>
  When the local operator clicks Start dice
  Then the update dialog offers only "Update Dice on this computer", checked
  And the dialog shows no cloud choice and no version-skew warning

  Examples:
    | state                                                             |
    | unread because no account with cloud operator rights is signed in |
    | still loading                                                     |
    | failing to load                                                   |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-086] A local operator who redeploys finds a local app that ran before running again, and a stopped app still stopped
  Given "dice" is behind on this computer and in the cloud
  When the local operator clicks Redeploy on the cloud tile and approves both updates
  Then "dice" runs again on this computer if it ran before the update
  And "dice" stays stopped on this computer if it was stopped before
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-087] A cloud operator who redeploys with only the local install behind is offered the cloud redeploy, checked, and it runs first
  Given the cloud install of "dice" matches its folder
  And the local install of "dice" is behind
  When the cloud operator clicks Redeploy on the cloud tile
  Then the update dialog offers "Redeploy Dice in the cloud", checked
  And leaving the cloud redeploy unchecked shows no version-skew warning
  When the cloud operator approves both
  Then the cloud redeploy runs before the local update
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-211] A local operator who redeploys with only the local install behind finds the local update offered, and it runs after the cloud redeploy
  Given the cloud install of "dice" matches its folder
  And the local install of "dice" is behind
  When the local operator clicks Redeploy on the cloud tile
  Then the update dialog offers "Update Dice on this computer"
  When the local operator approves both installs
  Then the local update runs after the cloud redeploy
```

- **Notes:** Unchecking the local install redeploys the cloud alone (`app-update.test.tsx` › "redeploys the cloud alone when the operator unchecks the local install"). For a mobile-only cloud install, the choice reads "Re-register Dice Mobile".

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-088] A cloud operator who unchecks every install in the Redeploy dialog finds Update disabled
  Given the update dialog is open from Redeploy
  When the cloud operator unchecks every install
  Then the Update button is disabled
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-089] A cloud operator sees a pending cloud update only when the deployed manifest or code differs from the folder
  Given "dice" is installed in the cloud
  When the cloud operator opens the dashboard
  Then the cloud tile shows no pending update when the folder holds the deployed manifest in another key order
  And the cloud tile shows no pending update when the folder's uncommitted changes are the ones deployed, or were committed after the deploy
  And the cloud tile shows a pending update when the folder holds another manifest
  And the cloud tile shows a pending update when the cloud install predates the recorded manifest
```

```gherkin
@cloud @mobile
@intent:confirmed
Scenario: [APP-LIFE-090] A cloud operator is asked for consent again on a redeploy or a second surface only when the folder's manifest asks for more access
  Given "dice" is installed in the cloud
  When the cloud operator redeploys "dice", or registers its second surface
  Then no consent dialog opens when the folder's manifest asks for the same access as the deployed one
  And the consent dialog opens when the folder's manifest asks for more access, or when the cloud install predates the recorded manifest
```

### The upgrade script

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-091] A local operator who runs upgrade-app.sh --diff sees what is stale, and nothing changes
  Given the local data server runs and several apps are installed
  When the local operator runs "scripts/upgrade-app.sh --diff dice", or "--diff" with no app
  Then the output lists, for each named app or every installed app, each manifest field whose stored value differs from the folder, with "was" and "now"
  And an app with no difference reads "identical"
  And the apps keep their installed manifests
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-092] A local operator who runs upgrade-app.sh reapplies an installed app's manifest and sees what moved
  Given "dice" is installed and its folder's manifest changed
  When the local operator runs "scripts/upgrade-app.sh dice"
  Then the output names each field that moved
  And "dice" runs with the folder's manifest after its next start, with its rows and credentials intact
  And the output says that a column type crossing a storage class was not applied
```

- **Notes:** An app whose manifest did not change reads "already current". An app that is not installed is refused with "install it from admin-web first".

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-093] A local operator cannot run upgrade-app.sh while the local data server does not answer
  Given the local data server is not running
  When the local operator runs "scripts/upgrade-app.sh dice"
  Then the command says the local data server is not answering and to start it first
  And the command exits with an error
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-094] A local operator cannot upgrade an app that two folders hold when Starkeep never recorded its install folder
  Given "dice" was installed before Starkeep recorded each install's folder
  And two registered folders each hold an app with the id "dice"
  When the local operator runs "scripts/upgrade-app.sh dice"
  Then the command says that two folders hold "dice" and names both
  And the command exits with an error and changes no app
```

- **Notes:** A pinned app whose folder now holds another app's id is refused the same way.

## Installing in the cloud

### From the dashboard

```gherkin
@cloud @mobile
@intent:confirmed
Scenario: [APP-LIFE-095] A cloud operator sees a web tile and a mobile tile for each surface the manifest offers
  Given the cloud is set up
  And Discover apps finds an app with compute and an Android build, and an app with an Android build and no compute
  When the cloud operator opens the dashboard
  Then the Cloud section shows a web tile and a "Mobile" tile for the first app
  And the Cloud section shows only a "Mobile" tile for the second app
  And each web tile reads Installed or Not installed, and each mobile tile reads Registered or Not registered
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-096] A cloud operator who starts a first cloud install of an app never approved is asked for consent
  Given an app was never installed on this computer or in the cloud
  When the cloud operator clicks Install in cloud on its web tile, or Register on its mobile tile
  Then the consent dialog opens with what the app asks for
  And nothing deploys until the cloud operator approves
```

- **Notes:** The cloud dialog leaves out the local install's archive-quality step (APP-LIFE-023).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-097] A cloud operator who installs in the cloud an app installed on this computer deploys its approved manifest without being asked
  Given "dice" is installed on this computer, and its folder matches the approved manifest
  When the cloud operator clicks Install Dice in cloud
  Then no consent dialog opens
  And the install panel starts the deploy of the manifest approved for the local install
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-098] A cloud operator installs a cloud web app with no local install of it
  Given "dice" is not installed on this computer
  When the cloud operator approves the cloud install of "dice"
  Then the web tile reads Installed
  And the Local section's card for "dice" still reads Not installed
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-099] A cloud operator watches the deploy stream, and the tile then reads Installed and opens the app
  Given the cloud operator approved the cloud install of "dice"
  When the cloud operator watches the install panel
  Then the install panel shows each line of the deploy's output as it arrives
  And the panel reads Done when the deploy succeeds
  And the web tile reads Installed, and its Open action opens the app's cloud address
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-100] A member opens the installed cloud app and signs in with the deployment account
  Given the cloud operator installed "dice" in the cloud
  When a member opens the app's cloud address
  Then the member signs in with the account the cloud operator invited, and sees the app
```

- **Notes:** The sign-in steps belong to [users-and-access.md](users-and-access.md) (ACCESS-028, ACCESS-034).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-101] A cloud operator whose cloud install failed can retry it
  Given a cloud install of "dice" failed part-way
  When the cloud operator looks at the install panel
  Then the panel reads Failed and shows the deploy's error
  And the panel offers Retry, which runs the install again
```

- **Notes:** A refusal before the deploy starts, because the folder changed after the approval, offers no Retry (APP-LIFE-026).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-102] A cloud operator can run only one cloud install at a time, and a second request names the running install
  Given a cloud install of "dice" is running
  When the cloud operator looks at the other cloud tiles
  Then their actions are disabled, and hovering says "Another cloud install is running"
  When the cloud operator starts an install of another app from a tab whose status is stale
  Then the cloud operator sees "Another cloud install is running (<the running install>). Try again once it ends."
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-103] A cloud operator finds a cloud install still running, with its output resumed, after the connection drops or Admin restarts
  Given a cloud install of "dice" is running
  When the cloud operator's browser loses its connection, or the cloud operator restarts Admin, and the cloud operator reopens the install panel
  Then the panel shows the install still running
  And the panel shows the output written while it was away, without repeating lines, and then the outcome
  And the output shows no second deploy starting
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-104] A cloud operator whose AWS session expires during a cloud install is told to sign in again
  Given the cloud operator's AWS session expires during a cloud install
  When the cloud operator waits for the install to end
  Then the install panel says "Your AWS sign-in session was rejected (expired or invalid). Sign in again to retry."
```

- **Notes:** The message also reaches a browser that reconnects after the run ended (`install-stream.test.ts` › "reports an expired session that ended the run while the browser was away").

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-105] A cloud operator cannot install in the cloud before setup, or without a sign-in with cloud operator rights
  Given the cloud is not set up
  When the cloud operator looks at a cloud tile
  Then its action is disabled, and hovering says "Set up cloud before installing apps"
  Given the cloud is set up and no account with cloud operator rights is signed in to the cloud
  When the cloud operator starts a cloud install
  Then the cloud operator sees "Not signed in. Sign in from the dashboard first."
  And nothing deploys
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-106] A cloud operator must update a changed local app with Start or Redeploy before its first cloud install
  Given "dice" is installed on this computer, not in the cloud
  And its folder's manifest changed since the local install
  When the cloud operator looks at the Dice web tile
  Then Install in cloud is disabled, and hovering says "Its folder holds a changed manifest. Choose Start or Redeploy to update it."
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-107] A cloud operator cannot install in the cloud an app whose folder holds no manifest or an invalid one
  Given the folder of an app installed on this computer now holds no manifest, or an invalid one
  When the cloud operator looks at the app's cloud tile
  Then the install action is disabled, and hovering says "Its source folder is not found" or "Its folder holds an invalid manifest. Fix the manifest first"
  And an install started from a tab whose status is stale is refused with the folder named, and nothing deploys
```

```gherkin
@cloud @mobile
@intent:confirmed
Scenario: [APP-LIFE-108] A cloud operator keeps the tiles of a cloud-installed app whose folder is not in Discover apps, with Redeploy disabled
  Given "dice" is installed in the cloud with a web app and a mobile registration
  And no registered folder holds "dice"
  When the cloud operator opens the dashboard
  Then the Cloud section keeps a tile for each installed surface, described "Installed in the cloud. Its folder is not in Discover apps."
  And Redeploy and Re-register are disabled, and hovering says "Add the app's folder in Discover apps to redeploy" or "… to re-register"
  And the section shows no tile for a surface the cloud does not have
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-109] A cloud operator sees a cloud app's status as unknown, with a way to sign in, while the cloud registry is unread
  Given "dice" is installed in the cloud
  And the cloud registry cannot be read, for example because no account with cloud operator rights is signed in
  When the cloud operator opens the dashboard
  Then the Dice web tile says its cloud status is unknown, rather than Not installed
  And the tile offers a sign-in that shows the status
```

- **Notes:** Implementation gap: the tile reads Not installed.

```gherkin
@mobile
@intent:confirmed
Scenario: [APP-LIFE-110] A cloud operator who registers a mobile build sees its tile read Registered
  Given an app's manifest offers an Android build
  When the cloud operator clicks Register on its Mobile tile and approves the consent dialog
  Then the install panel reads Done
  And the Mobile tile reads Registered, with no primary action and Re-register in its menu
```

- **Notes:** A mobile-only registration deploys the data side with no compute (`orchestrator.test.ts` › "installs the mobile app with the whole data side and no compute"). Sign-in by the mobile build belongs to [users-and-access.md](users-and-access.md) (ACCESS-085).

```gherkin
@mobile
@intent:confirmed
Scenario: [APP-LIFE-111] A cloud operator cannot register a mobile build on a deployment without the mobile-apps client
  Given the cloud data server was installed before it created the mobile-apps sign-in client
  When the cloud operator registers an app's mobile build
  Then the install fails before any step with a message that says to reinstall the cloud data server first
  And a web-only install of the same app still succeeds
```

### From the terminal

```gherkin
@cloud @mobile
@intent:confirmed
Scenario Outline: [APP-LIFE-112] A cloud operator who runs cli:install-app installs the data side and the surfaces asked for
  Given an app's manifest offers a web app and an Android build
  When the cloud operator runs "cli:install-app dice <flags>"
  Then the command installs the app's data side and <surfaces>

  Examples:
    | flags      | surfaces                                    |
    |            | the web app and the mobile registration     |
    | --web      | the web app only                            |
    | --mobile   | the mobile registration only, with no compute |
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-113] A cloud operator sees the deployment and folder before cli:install-app acts, and the app's address when done
  When the cloud operator runs "cli:install-app dice"
  Then before any step the output shows the region, the stage, the account, the app folder, and the surfaces it adds
  And after a web install the output says "Install complete. dice app available at:" and the address ending in "/apps/dice"
  And after a mobile-only registration the output names the Android package and its sign-in callback
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-114] A cloud operator sees every manifest error and warning, and cli:install-app refuses
  Given the app's manifest holds several errors and one warning
  When the cloud operator runs "cli:install-app dice"
  Then the output says the manifest is not a valid app manifest and lists each error
  And the output prints the warning
  And the command exits with an error before deploying anything
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-115] A cloud operator cannot install an app that needs a newer protocol than the cloud data server
  Given the app's manifest needs a newer Starkeep protocol than the deployed cloud data server speaks
  When the cloud operator runs "cli:install-app dice"
  Then the command names both versions and exits with an error before deploying anything
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-116] A cloud operator cannot install an app with an unapproved bundle command
  Given the app declares a bundle command off the approved list
  When the cloud operator runs "cli:install-app dice"
  Then the command names the refused command and exits with an error
  And the cloud shows no install of "dice"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-117] A cloud operator cannot deploy a folder whose manifest no longer matches the approved digest
  Given the cloud operator approved a cloud install of "dice" in Admin
  And the folder's manifest changed after Admin passed the install to "cli:install-app"
  When the cloud operator watches the install panel
  Then the panel shows that the manifest "changed after the manifest was approved. Review the new manifest and deploy again."
  And nothing deploys
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-118] A cloud operator whose bundle build writes no dist.zip sees the install stop
  Given the app's bundle command succeeds but writes no dist.zip
  When the cloud operator runs "cli:install-app dice"
  Then the command says the bundle build did not produce a dist.zip, names the path, and exits with an error
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-119] A cloud operator cannot install an app with a built-in app id or an id the cloud cannot name resources with
  Given an app's manifest uses a built-in app's id, or an id the cloud cannot use in resource names
  When the cloud operator runs "cli:install-app" for it
  Then the command refuses before any install step
  And the cloud shows no install of the app
```

```gherkin
@cloud @mobile
@intent:confirmed
Scenario: [APP-LIFE-120] A cloud operator cannot install a surface the manifest does not offer
  Given an app's manifest declares no compute and no public site
  When the cloud operator runs "cli:install-app notes --web"
  Then the command says "notes's manifest declares no compute and no public site, so it has no web app." and exits with an error
  And "--mobile" on an app with no mobile build says the manifest declares no mobile build
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-121] A cloud operator without the cloud data server's settings is told to install it first
  Given the local Starkeep config lacks the cloud data server's settings
  When the cloud operator runs "cli:install-app dice"
  Then the command names the missing settings and says "Install the cloud-data-server first."
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-122] A cloud operator reads the consent words and answers yes before a terminal cloud install acts
  Given "dice" was never approved on this computer or in the cloud
  When the cloud operator runs "cli:install-app dice" in a terminal
  Then the command prints what "dice" asks for, in the consent dialog's words
  And the command deploys only after the cloud operator answers yes, or "--yes" was given
```

- **Notes:** Implementation gap: the command deploys without printing the consent words or asking.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-123] A cloud operator who reruns a cloud install that failed part-way resumes from the failed step
  Given a cloud install of "dice" failed at one step
  When the cloud operator runs the install again
  Then the install picks up at the failed step, without repeating the steps that finished
  And the install panel reads Done when the rest succeeds
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-124] A member keeps using a cloud app at the same address, with no new sign-in, after the cloud operator reruns its install
  Given the member uses "dice" in the cloud on a browser and a device
  And the cloud operator ran the install of "dice" again with changed code
  When the member opens "dice" at its address
  Then the member finds the changed app
  And the member's device keeps syncing "dice" with no new sign-in
```

- **Notes:** The credential's role in request signing belongs to [users-and-access.md](users-and-access.md).

### A web app's served files

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-125] A cloud operator who installs an app in the cloud finds its immutable and static files served from the app's address
  Given the app's bundle holds files under "_immutable/" and "_static/" and declares them as static asset paths
  When the cloud operator installs the app in the cloud
  Then those files load from the app's address
  And files under "_immutable/" come back marked immutable, and files under "_static/" come back marked to revalidate
```

- **Notes:** Serving belongs to [cloud-runtime.md](cloud-runtime.md).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-126] A member keeps loading a page opened before a redeploy
  Given the member opened the app's page
  And the cloud operator then redeployed the app with new file names
  When the member keeps using the open page
  Then the page still loads its files
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-197] A cloud operator finds a deployment's files removed two redeploys later
  Given the cloud operator deployed an app, then redeployed it twice, each time with new file names
  When the cloud operator requests a file of the first deployment from the app's address
  Then the file no longer loads
```

- **Notes:** APP-LIFE-126 states that a member's page from the previous deployment keeps loading.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-127] A cloud operator cannot install an app whose function would serve a file too large to return
  Given the app's function would have to serve a file larger than a function response can carry
  When the cloud operator installs the app
  Then the install fails, names the file, and says to move it under "_static/" or "_immutable/"
```

- **Notes:** The install also refuses a bundle assets folder the zip lacks, a zip entry that is not a plain relative path, and two handlers that serve one file (`static-assets.test.ts` › "collectStaticAssets").

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-128] A cloud operator who redeploys an app that stops serving files from storage finds its old files removed
  Given an app's earlier deployment published files for the edge
  When the cloud operator redeploys a version whose function serves every file
  Then the old files no longer load from the edge
  And no other app's files change
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-129] A cloud operator whose bootstrap stack predates the app assets bucket is told to update it
  Given the deployment's bootstrap stack predates the app assets bucket
  When the cloud operator installs an app with static files
  Then the install fails with a message that says to download the bootstrap template from Admin, update the bootstrap stack, and install again
```

### Checks after a cloud install

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-130] A cloud operator sees in the install log every route reachable without sign-in and every outside-client route
  Given an app declares public paths and a route for an outside client
  When the cloud operator installs the app in the cloud
  Then the output lists each route reachable without sign-in, and the declaration it came from
  And the output lists the routes outside clients call
  And an app whose every route needs a sign-in prints no such list
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-131] A cloud operator whose app's data path answers without sign-in sees the install fail as EXPOSED, with the takedown command
  Given an app's data path would answer a request that carries no sign-in
  When the cloud operator installs the app in the cloud
  Then the command says "dice is installed but EXPOSED. Take it down before doing anything else:" and prints the "cli:uninstall-app" command
  And the command exits with an error
```

- **Notes:** A 401 or a 403 counts as a refusal. A 404, a 500, or no answer is not counted as an exposure (`post-install-probe.test.ts` › "what is not treated as exposure").

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-132] A cloud operator sees a warning when a declared public path refuses, or a sign-in page does not answer
  Given the app declares a public path, or a sign-in page, that refuses a signed-out request
  When the cloud operator installs the app in the cloud
  Then the output prints "WARNING: <address> is declared public but answered <status>."
  And the install still completes
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-133] A cloud operator sees a warning, and the install completes, when the app root refuses its trailing-slash spelling
  Given the app root answers "/apps/dice" but refuses "/apps/dice/" without a sign-in
  When the cloud operator installs the app in the cloud
  Then the output warns about the trailing-slash spelling of the app root
  And the install still completes
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-134] A cloud operator sees a cold-start warning when the first request used half the handler's timeout
  Given the app root's first request takes more than half its handler's timeout
  When the cloud operator installs the app in the cloud
  Then the output warns that the handler's first request took "<seconds>s of its <timeout>s timeout"
  And the install still completes
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-135] A cloud operator sees the install fail when the first request used four fifths of the handler's timeout
  Given the app root's first request takes more than four fifths of its handler's timeout
  When the cloud operator installs the app in the cloud
  Then the command says the app is installed but its handler spent most of its timeout on the first request
  And the command says to load the module graph at module scope and points to the authoring guide
  And the command exits with an error
```

- **Notes:** `docs/authoring-an-app.md` › "7. Cloud compute + the bundle (cloud target only)" states the four-fifths failure. The install walkthrough in "Install in your cloud" lists only the warning, and the comment in `post-install-probe.test.ts` › "never fails the install on its own" calls exposure the only fatal signal. Both lag the command.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-136] A cloud operator sees the install skip its checks when the config holds no live address
  Given the local Starkeep config holds no public address and no gateway address
  When the cloud operator installs a web app
  Then the output says it is skipping the post-install probe because there is no live address to ask
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-137] A cloud operator cannot install a route that claims a reserved path, or a gate the deployment lacks
  Given an app declares a route under a reserved platform path, or a route that needs a gate the deployment does not have
  When the cloud operator installs the app in the cloud
  Then the install fails and names the route
  And the app's address gains no route from the refused install
```

## Uninstalling apps

### On this computer

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-138] A local operator learns from the uninstall dialog that the app's data stays, and how to delete it
  Given "dice" is installed on this computer and stopped
  When the local operator chooses Uninstall on its card
  Then a dialog titled "Uninstall Dice?" says "Uninstall stops Dice and removes its access to your data."
  And the dialog says Dice's own data stays on this machine and reinstalling brings it back
  And the dialog says records Dice shared with other apps stay
  And the dialog says to choose Delete data on its card after uninstalling to delete the data
  And the dialog asks for no typed confirmation
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-139] A local operator who uninstalls an app finds it Not installed with Data kept, and its credentials file gone
  Given "dice" is installed on this computer and stopped
  When the local operator confirms the uninstall
  Then the card reads Not installed, with a "Data kept" badge
  And the app's credentials file is gone
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-198] An app developer whose app was uninstalled finds its old credentials refused
  Given the app developer's app "dice" was installed on this computer and then uninstalled
  When "dice" reads or writes data with its old credentials
  Then the app's reads and writes are refused
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-140] A local operator cannot uninstall an app while it runs
  Given "dice" runs on this computer
  When the local operator opens the card's menu
  Then Uninstall is disabled, and hovering says "Stop the app before uninstalling"
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-141] A local operator still finds an uninstalled app's shared records in Drive
  Given "dice" wrote shared records that Drive shows
  When the local operator uninstalls "dice"
  Then Drive still shows the records
```

- **Notes:** The rules for the uninstalled app's labels belong to [shared-data.md](shared-data.md) (SHARED-083, SHARED-084).

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-142] A local operator who reinstalls an app gets its kept data back, and the consent dialog says so with the counts
  Given an earlier uninstall of "dice" kept 12 rows on this computer
  When the local operator clicks Install on the "dice" card
  Then the consent dialog says "This install brings back Dice's kept data" and "An earlier uninstall kept 12 rows on this machine. Dice gets them back."
  When the local operator approves the install and starts "dice"
  Then "dice" shows the data from its 12 rows
  And the card no longer shows "Data kept"
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-143] A local operator who cancels the uninstall dialog uninstalls nothing
  Given the uninstall dialog for "dice" is open
  When the local operator clicks Cancel
  Then the card still reads Installed
  And "dice" starts and works as before
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-144] A local operator sees an error when the local data server does not answer an uninstall
  Given the local data server stopped answering after the dashboard loaded
  When the local operator confirms the uninstall of "dice"
  Then the dashboard shows the uninstall's error
  And the card still reads Installed after the server comes back
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-145] A local operator keeps a card with Delete data for kept data whose app folder is gone
  Given an uninstall of "dice" kept its data
  And no registered folder holds "dice" any more
  When the local operator opens the dashboard
  Then the Local section shows a "dice" card with the "Data kept" badge
  And the card offers Delete data
```

### Deleting kept data on this computer

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-146] A local operator sees in Delete data the rows and files it removes, and whether the cloud holds a copy
  Given an uninstall of "dice" kept its data
  When the local operator chooses Delete data on the card
  Then the dialog says "This machine holds" the row count and the file count and size
  And the dialog says whether the cloud holds a full copy, a copy missing recent changes, or no copy
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-147] A local operator deletes kept data only after typing the app id
  Given the Delete data dialog for "dice" is open
  Then the Delete data button is disabled
  When the local operator types "dice"
  Then the Delete data button is enabled
  When the local operator clicks Delete data
  Then the card no longer shows "Data kept"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-148] A local operator learns that a reinstall downloads the cloud copy again, and it does
  Given this computer synced all of "dice"'s data to the cloud, and "dice" stays installed in the cloud
  When the local operator opens Delete data for "dice" on this computer
  Then the dialog says the cloud held all of the data at the last sync, and reinstalling downloads it again while Dice is installed in the cloud
  When the local operator deletes the data and reinstalls "dice" on this computer
  Then "dice" shows its data again after the next sync
```

- **Notes:** When this computer holds changes it had not synced, the dialog says "The cloud copy is missing recent changes" and that the deletion loses them. The download belongs to [sync.md](sync.md).

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-149] A local operator without a cloud copy learns the deletion is permanent
  Given this computer never synced "dice"'s data to the cloud
  When the local operator opens Delete data for "dice"
  Then the dialog says "The deletion is permanent" and that no cloud copy can restore the data
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-150] A local operator cannot delete the data of an app that is installed
  Given "dice" is installed on this computer
  When the local operator opens the card's menu
  Then the menu offers no Delete data
  And Delete data from a tab whose status is stale is refused, and "dice" keeps its data
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-151] A local operator who deletes kept data finds the reinstalled app empty
  Given the local operator deleted the kept data of "dice", which had no cloud copy
  When the local operator installs and starts "dice"
  Then the consent dialog shows no kept-data note
  And "dice" shows none of its old data
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-152] A local operator whose deletion fails part-way keeps the Data kept card, and a retry finishes it
  Given a Delete data run for "dice" failed part-way
  When the local operator looks at the dashboard
  Then the dialog shows "Delete failed" with the error
  And the card still shows "Data kept" with Delete data
  When the local operator runs Delete data again
  Then the card no longer shows "Data kept"
```

### In the cloud

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-153] A cloud operator who runs cli:uninstall-app removes the app, keeps its data, and learns how to delete it
  Given "dice" is installed in the cloud
  When the cloud operator runs "cli:uninstall-app dice"
  Then the output names the region, the stage and the account before it acts
  And the output ends with "dice cloud uninstall complete. Its data stays in the cloud, and reinstalling dice gets it back. To delete it, run cli:delete-app-data dice."
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-154] A member cannot reach a cloud app after its uninstall, and still finds its shared records in Drive
  Given the member used "dice" in the cloud and it wrote shared records
  And the cloud operator then uninstalled "dice" from the cloud
  When the member visits the app's address
  Then the visit does not reach the app
  And the member still finds the shared records in Drive
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-155] A member finds their rows again after the cloud operator reinstalls a cloud app
  Given the member held rows in "dice" in the cloud
  And the cloud operator uninstalled "dice", keeping its data, and later installed it again
  When the member opens "dice" in the cloud
  Then the member finds their rows
```

```gherkin
@cloud @mobile
@intent:confirmed
Scenario: [APP-LIFE-156] A cloud operator who removes one surface with --web or --mobile keeps the data side and the other surface
  Given "dice" is installed in the cloud with a web app and a mobile registration
  When the cloud operator runs "cli:uninstall-app dice --mobile"
  Then the output says "dice's mobile app removed; its data stays installed."
  And the dashboard's Dice Mobile tile reads Not registered
```

- **Notes:** What the phone sees after its surface goes belongs to [users-and-access.md](users-and-access.md) (ACCESS-085, ACCESS-101).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-199] A member keeps using a cloud web app with their data after the cloud operator removes its mobile surface
  Given the member uses "dice" in the cloud on the web
  And the cloud operator removed the mobile surface of "dice" with "cli:uninstall-app dice --mobile"
  When the member opens "dice" on the web
  Then the member finds the app with their data
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-157] A cloud operator can uninstall a cloud app whose folder is gone, from the manifest the cloud recorded
  Given "dice" is installed in the cloud
  And no folder on this computer holds "dice"
  When the cloud operator runs "cli:uninstall-app dice"
  Then the uninstall completes from the manifest the cloud recorded at install
```

- **Notes:** A cloud install that predates the recorded manifest falls back to the source folder and says "The cloud registry holds no manifest for this app; using its source folder."

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-158] A cloud operator whose deployment lacks the kept-data table gets a refusal before any uninstall step
  Given the cloud data server was deployed before uninstalls kept data
  When the cloud operator runs "cli:uninstall-app dice"
  Then the command says the database has no kept-data table and to redeploy the cloud data server
  And "dice" stays installed and working
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-159] A cloud operator who uninstalls a reinstalled app removes everything again
  Given the cloud operator uninstalled "dice" from the cloud and installed it again
  When the cloud operator uninstalls "dice" a second time
  Then the app's address no longer reaches the app
  And the dashboard's Dice tiles read Not installed and Not registered
```

### Deleting kept data in the cloud

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-160] A cloud operator deletes a cloud app's kept data only after typing the app id
  Given the cloud keeps the data of an uninstalled "dice"
  When the cloud operator runs "cli:delete-app-data dice"
  Then the output says "The cloud keeps Dice's data from an uninstall:" and lists each table's rows and the files
  And the output says the deletion removes them for every account, and that records shared with other apps stay
  And the command asks "Type dice to delete its cloud data:"
  When the cloud operator types "dice"
  Then the output says "dice's cloud data deleted."
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-161] A cloud operator who types a non-matching answer cancels the deletion, and nothing changes
  Given "cli:delete-app-data dice" asks for the app id
  When the cloud operator types anything other than "dice"
  Then the output says "Deletion cancelled. Nothing changed."
  And the command exits with an error
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-162] A cloud operator can delete without a question only with --confirm naming the same app id
  When the cloud operator runs "cli:delete-app-data dice --non-interactive" without "--confirm dice"
  Then the command says "--non-interactive deletes data only with --confirm dice. Nothing changed." and exits with an error
  When the cloud operator adds "--confirm dice"
  Then the data is deleted without a question
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-163] A cloud operator cannot delete a cloud app's data while it is installed
  Given "dice" is installed in the cloud
  When the cloud operator runs "cli:delete-app-data dice"
  Then the command says "dice is installed in the cloud. Uninstall it (cli:uninstall-app dice) before deleting its data."
  And "dice" keeps working in the cloud with its data
```

```gherkin
@cloud @local
@intent:confirmed @suboptimal
Scenario: [APP-LIFE-164] A cloud operator learns that devices that keep the data do not upload it again after a cloud deletion
  Given a computer still holds "dice"'s rows
  When the cloud operator deletes "dice"'s cloud data
  Then the output says devices that keep the app's data do not upload it again, and the cloud's copy stays partial
  And a later cloud reinstall of "dice" does not show the rows that computer holds
```

- **Suboptimal:** the cloud copy stays partial until a device uploads its rows again. STA-96 tracks the fix.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-165] A member finds none of their old rows in a cloud app reinstalled after its data was deleted
  Given the member held rows in "dice" in the cloud
  And the cloud operator uninstalled "dice", deleted its cloud data, and later installed it again
  When the member opens "dice" in the cloud
  Then the member finds none of those rows
```

## Removing every cloud app

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-166] A cloud operator must give teardown-cloud-apps.sh --prefix and --region, is asked for them in a terminal, and fails unattended without them
  When the cloud operator runs "scripts/teardown-cloud-apps.sh" in a terminal without "--prefix" or "--region"
  Then the script asks for each missing value
  When the cloud operator runs it with "--yes", or with no terminal, and a value is missing
  Then the script says the value is required, prints its usage, and exits with an error before deleting anything
```

- **Notes:** The script never reads the prefix or the region from the config. It only mentions the config's prefix for reference.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-167] A cloud operator who runs a dry run sees the apps, functions and log groups listed, and nothing deleted
  When the cloud operator runs "scripts/teardown-cloud-apps.sh --dry-run --prefix sk1 --region us-east-2"
  Then the output lists each app, function and log group the teardown would delete
  And every app still works afterward
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-168] A cloud operator who tears down one deployment's apps leaves the other deployment and the built-in identities working
  Given the account holds two deployments with the prefixes "sk1" and "sk2"
  When the cloud operator runs the teardown with "--prefix sk1"
  Then the "sk1" apps no longer answer
  And the "sk2" apps keep working
  And the "sk1" cloud data server, Admin's cloud sign-in, and computer sync keep working
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-169] A cloud operator sees each teardown failure listed at the end, and a resource already gone counts as no failure
  Given one app's function cannot be deleted
  When the cloud operator runs the teardown
  Then the teardown still deletes the other apps' resources
  And the output lists the failed deletion at the end, and the script exits with an error
  And a resource that is already gone prints "Not found, skipping." and counts as no failure
```

- **Notes:** A lookup that fails fails the teardown, rather than reporting nothing to delete (`teardown-cloud-apps-script.test.ts` › "fails when a lookup fails, rather than reporting nothing to delete").

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-170] A cloud operator who removes every cloud app sees each one uninstalled with its data kept
  Given members hold rows in cloud apps
  When the cloud operator runs "scripts/teardown-cloud-apps.sh"
  Then the dashboard shows each removed cloud app as uninstalled with its data kept, as an uninstall from the dashboard shows it
```

- **Notes:** The full cloud teardown belongs to [cloud-setup.md](cloud-setup.md) (CLOUD-SETUP-119). Implementation gap: the registry still lists each app as installed after the script, so the dashboard tiles can read Installed.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-186] A member finds their rows in a cloud app reinstalled after every cloud app was removed
  Given the member held rows in a cloud app
  And the cloud operator removed every cloud app with "scripts/teardown-cloud-apps.sh" and later installed the app again
  When the member opens the app in the cloud
  Then the member finds their rows
```

## Dashboard app cards and command output

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-171] A local operator sees one primary action on each local app card, and the rest in its menu
  When the local operator looks at an app card
  Then the card shows one primary button for its state, such as Install, Start, or Open
  And the card's menu holds the other actions, such as Stop, Uninstall, Install steps, or Delete data
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-200] A cloud operator sees one primary action on each cloud tile, and the rest in its menu
  When the cloud operator looks at a cloud tile
  Then the tile shows one primary button for its state, such as Install in cloud or Open
  And the tile's menu holds the other actions, such as Redeploy
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-172] A cloud operator follows a cloud install's output panel, with Running, Done or Failed
  Given the cloud operator started a cloud install from the dashboard
  When the cloud operator watches its output panel
  Then the panel shows "Running" while the command runs
  And the panel scrolls to each new line as it arrives
  And the panel shows "Done" when the command succeeds, or "Failed" when it fails
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-201] A local operator follows a dependency install's output, with Running, Done or Failed
  Given an app's folder holds a package.json and a lockfile
  When the local operator approves the app's install on this computer
  Then the output shows "Running" while the dependency command runs
  And the output scrolls to each new line as it arrives
  And the output shows "Done" when the command succeeds, or "Failed" when it fails
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-173] A local operator sees a message in the Local section when it has no apps
  Given Discover apps finds no app
  When the local operator opens the dashboard
  Then the Local section says "No local apps found."
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-212] A cloud operator sees a message in the Cloud section when it has no apps
  Given Discover apps finds no app
  When the cloud operator opens the dashboard
  Then the Cloud section says "No cloud apps found."
```

## Manifest errors an app developer, a local operator, or a cloud operator sees

These errors show in Discover apps (APP-LIFE-004), in the terminal installs (APP-LIFE-045, APP-LIFE-114), and in an install from the dashboard. Writing the manifest belongs to [app-development.md](app-development.md).

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-174] A local operator cannot install an app with a misspelled or stray manifest key, and sees its path and the field it resembles
  Given an app's manifest holds "compute.handlers.0.timout" instead of "timeout"
  When the local operator installs the app on this computer
  Then the install is refused with "compute.handlers.0: unknown key "timout" (did you mean "timeout"?)"
  And a key unlike any declared field is named without a suggestion
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-202] A cloud operator cannot install in the cloud an app with a misspelled or stray manifest key, and sees its path and the field it resembles
  Given an app's manifest holds "compute.handlers.0.timout" instead of "timeout"
  When the cloud operator installs the app in the cloud
  Then the install is refused with "compute.handlers.0: unknown key "timout" (did you mean "timeout"?)"
  And a key unlike any declared field is named without a suggestion
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-175] A local operator cannot install an app that sets a privilege flag outside the apps it belongs to
  Given an app's manifest <declares>
  When the local operator installs the app on this computer
  Then the install is refused with an error naming the field

  Examples:
    | declares                                                     |
    | fileAccessAll, and its id is not starkeep-drive              |
    | brokerPower, and its id is not cloud-data-server             |
    | publicSharing, and it has no cloud target                    |
    | an id that starts with "@starkeep/", and it is a community app |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-203] A cloud operator cannot install in the cloud an app that sets a privilege flag outside the apps it belongs to
  Given an app's manifest <declares>
  When the cloud operator installs the app in the cloud
  Then the install is refused with an error naming the field

  Examples:
    | declares                                                     |
    | fileAccessAll, and its id is not starkeep-drive              |
    | brokerPower, and its id is not cloud-data-server             |
    | an id that starts with "@starkeep/", and it is a community app |
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-176] A local operator cannot install an app whose table declarations break a rule
  Given an app's manifest declares a table where <problem>
  When the local operator installs the app on this computer
  Then the install is refused with an error naming the table or column

  Examples:
    | problem                                                     |
    | a column is named updated_at or deleted_at                  |
    | a column is named exists or not_exists                      |
    | two columns share one name                                  |
    | two tables share one name                                   |
    | a table or column name is not snake_case                    |
    | a column's type is off the allowed list                     |
    | the table has no columns                                    |
    | a syncable table has no primary key                         |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-204] A cloud operator cannot install in the cloud an app whose table declarations break a rule
  Given an app's manifest declares a table where <problem>
  When the cloud operator installs the app in the cloud
  Then the install is refused with an error naming the table or column

  Examples:
    | problem                                                     |
    | a column is named updated_at or deleted_at                  |
    | a column is named exists or not_exists                      |
    | two columns share one name                                  |
    | two tables share one name                                   |
    | a table or column name is not snake_case                    |
    | a column's type is off the allowed list                     |
    | the table has no columns                                    |
    | a syncable table has no primary key                         |
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-177] A local operator cannot install an app whose file access types break a rule
  Given an app's manifest asks for file access where <problem>
  When the local operator installs the app on this computer
  Then the install is refused with an error naming the type or the entry

  Examples:
    | problem                                         |
    | a type id is not shaped "<category>/<format>"   |
    | a type id is not a registered type              |
    | a type id is "other/other"                      |
    | a type id is the library's settings type        |
    | an entry lists no type                          |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-205] A cloud operator cannot install in the cloud an app whose file access types break a rule
  Given an app's manifest asks for file access where <problem>
  When the cloud operator installs the app in the cloud
  Then the install is refused with an error naming the type or the entry

  Examples:
    | problem                                         |
    | a type id is not shaped "<category>/<format>"   |
    | a type id is not a registered type              |
    | a type id is "other/other"                      |
    | a type id is the library's settings type        |
    | an entry lists no type                          |
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-178] A local operator cannot install an app whose compute, targets or localRun break a rule
  Given an app's manifest <problem>
  When the local operator installs the app on this computer
  Then the install is refused with an error naming the field

  Examples:
    | problem                                                |
    | turns compute on with no handlers                      |
    | gives a handler memory or a timeout outside the bounds |
    | names an unknown target                                |
    | gives localRun an empty command                        |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-206] A cloud operator cannot install in the cloud an app whose compute, targets or localRun break a rule
  Given an app's manifest <problem>
  When the cloud operator installs the app in the cloud
  Then the install is refused with an error naming the field

  Examples:
    | problem                                                |
    | turns compute on with no handlers                      |
    | gives a handler memory or a timeout outside the bounds |
    | names an unknown target                                |
    | gives localRun an empty command                        |
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-LIFE-179] A local operator cannot install an app whose label keys break a rule
  Given an app's manifest declares label keys where <problem>
  When the local operator installs the app on this computer
  Then the install is refused with an error naming the key

  Examples:
    | problem                                  |
    | a key is not an identifier               |
    | a key has no description                 |
    | the app declares more than 64 keys       |
    | a key appears twice                      |
    | the app has no file access types at all  |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-207] A cloud operator cannot install in the cloud an app whose label keys break a rule
  Given an app's manifest declares label keys where <problem>
  When the cloud operator installs the app in the cloud
  Then the install is refused with an error naming the key

  Examples:
    | problem                                  |
    | a key is not an identifier               |
    | a key has no description                 |
    | the app declares more than 64 keys       |
    | a key appears twice                      |
    | the app has no file access types at all  |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-180] A cloud operator cannot install an app whose anonymous routes or public paths break a rule
  Given an app's manifest <problem>
  When the cloud operator installs the app in the cloud
  Then the install is refused with an error that names the handler or path and what to use instead

  Examples:
    | problem                                                                      |
    | sets auth "public" on a handler or a route                                   |
    | declares a delegated catch-all route                                         |
    | declares publicPaths on a jwt handler                                        |
    | declares a public path that is neither a platform page nor a static file     |
    | sets auth "session" with no publicPaths, or without "/sign-in"               |
    | declares "/sign-in/*"                                                        |
    | declares a public path that would silently override a gated route            |
    | declares "/*", which un-gates every route                                    |
    | lists one public path twice                                                  |
    | lists a relative public path                                                 |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-181] A cloud operator cannot install an app whose static asset paths or bundle assets folder break a rule
  Given an app's manifest <problem>
  When the cloud operator installs the app in the cloud
  Then the install is refused with an error naming the path or the folder

  Examples:
    | problem                                                                       |
    | serves a path from disk that publicPaths does not cover                       |
    | declares a static wildcard wider than the public path beside it               |
    | lists a relative static asset path                                            |
    | serves static files with no bundleAssetsDir                                   |
    | names a bundleAssetsDir that could leave the bundle                           |
```

```gherkin
@mobile
@intent:confirmed
Scenario Outline: [APP-LIFE-182] A cloud operator cannot register a mobile build that breaks a rule
  Given an app's manifest declares an Android build where <problem>
  When the cloud operator registers the app's mobile build
  Then the registration is refused with an error naming the field

  Examples:
    | problem                                          |
    | the app has no cloud target                      |
    | the package name is malformed                    |
    | the signing digest is malformed                  |
    | the callback scheme is malformed                 |
    | the callback scheme is http or https             |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-LIFE-183] A cloud operator cannot install an app whose background jobs break a rule
  Given an app's manifest declares jobs where <problem>
  When the cloud operator installs the app in the cloud
  Then the install is refused with an error naming the job

  Examples:
    | problem                                                          |
    | a job's name, time or mode is malformed                          |
    | the app declares more than eight jobs                            |
    | two jobs share one name                                          |
    | a job names a handler the manifest does not declare              |
    | the app has no compute                                           |
    | the app targets only this computer                               |
    | a job's handler may outlast the dispatcher's timeout             |
    | the manifest's protocolMinVersion is below 1.1.0                 |
```

- **Notes:** What a job does once installed belongs to [app-data.md](app-data.md).

```gherkin
@local
@intent:confirmed
Scenario: [APP-LIFE-184] A local operator cannot install an app whose protocolMinVersion is not major.minor.patch
  Given an app's manifest sets protocolMinVersion to "1.1"
  When the local operator installs the app on this computer
  Then the install is refused with an error naming protocolMinVersion
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-LIFE-208] A cloud operator cannot install in the cloud an app whose protocolMinVersion is not major.minor.patch
  Given an app's manifest sets protocolMinVersion to "1.1"
  When the cloud operator installs the app in the cloud
  Then the install is refused with an error naming protocolMinVersion
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-LIFE-185] A local operator sees a warning for a redundant metadataWrite, and the install goes on
  Given an app's manifest asks for "readwrite" file access and also sets metadataWrite
  When the local operator installs the app on this computer from the terminal
  Then the output warns that metadataWrite is redundant when access is "readwrite"
  And the install goes on
```
