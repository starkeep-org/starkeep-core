# Command line

This file covers the `starkeep` command itself: getting it onto a computer, the first setup on a computer, and the conventions every command shares, such as help, `--json` output, and exit codes. Each command's effect belongs to the file that owns the behavior:

- [local-data-server.md](local-data-server.md): starting, stopping, and inspecting the data server and Drive, `starkeep logs`, `starkeep admin`, and `starkeep reset-local`.
- [app-lifecycle.md](app-lifecycle.md): `starkeep source`, `list`, `info`, `install`, `uninstall`, `update`, and starting and stopping apps.
- [cloud-setup.md](cloud-setup.md): `starkeep setup --cloud`, `starkeep update --platform`, and `starkeep cloud bootstrap-update`.
- [cloud-runtime.md](cloud-runtime.md): `starkeep cloud status` and `starkeep cloud cost`.
- [users-and-access.md](users-and-access.md): `starkeep login`, `logout`, and the `starkeep user` commands.

## Getting the command

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLI-001] A local operator installs Starkeep on a computer with one line
  Given the computer has git and Node 24 or later
  And the computer holds no Starkeep checkout
  When the local operator runs "curl -fsSL https://starkeep.app/install.sh | sh"
  Then the output says "Cloning Starkeep into <home>/.starkeep/platform…"
  And the output ends with "Starkeep runs on this computer." and the admin-web address
  And the local operator finds the data server and Drive running
```

- **Coverage:** `packages/cli/__tests__/integration/install-script.test.ts` › "clones the checkout and hands every other argument to setup" (integration, local). A stand-in node stands in for setup.
- **Notes:** the script's source is `scripts/install.sh`. The script runs `starkeep setup` with the person's terminal attached, so setup can still ask its questions under `curl … | sh`.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLI-002] A local operator who runs the install line again updates the checkout and repeats the setup
  Given the computer holds the checkout that the install line cloned
  When the local operator runs the install line again
  Then the output says "Updating the Starkeep checkout in <home>/.starkeep/platform…"
  And the checkout holds the newest code from its branch
  And the output ends with "Starkeep runs on this computer."
```

- **Coverage:** `packages/cli/__tests__/integration/install-script.test.ts` › "pulls on a second run instead of cloning again" (integration, local). A stand-in node stands in for setup.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-003] A local operator whose checkout holds local changes that block the update is told to commit or stash them
  Given the checkout that the install line cloned holds changes that a fast-forward pull would overwrite
  When the local operator runs the install line again
  Then the output says "Could not update <home>/.starkeep/platform with git pull --ff-only. Commit or stash your changes there, then run this again."
  And the checkout keeps the local operator's changes
```

- **Coverage:** `packages/cli/__tests__/integration/install-script.test.ts` › "refuses a pull that local work blocks, and keeps the work (CLI-003)" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-004] A local operator whose install folder holds something else is told to move it or pick another folder
  Given "~/.starkeep/platform" exists, is not empty, and is not a Starkeep checkout
  When the local operator runs the install line
  Then the output says "<home>/.starkeep/platform exists and is not a Starkeep checkout. Move it away, or pick another folder with --dir."
  And the folder's contents stay as they were
```

- **Coverage:** `packages/cli/__tests__/integration/install-script.test.ts` › "refuses a folder that holds something other than a checkout" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario Outline: [CLI-005] A local operator whose computer lacks a tool the install line needs is told how to get it
  Given the computer has no <tool> command
  When the local operator runs the install line
  Then the output says "<message>"
  And nothing gets cloned

  Examples:
    | tool | message                                                                                                     |
    | git  | Starkeep needs git. Install it (on macOS: xcode-select --install), then run this again.                     |
    | node | Starkeep needs Node 24 or later. Install it (for example with nvm: nvm install 24), then run this again.    |
```

- **Coverage:** `packages/cli/__tests__/integration/install-script.test.ts` › "names the missing tool and clones nothing (CLI-005)" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLI-006] A local operator runs the command from a checkout before any install, and the command installs its dependencies first
  Given the local operator cloned starkeep-core and never ran "pnpm install"
  When the local operator runs "pnpm starkeep setup" at the checkout's root
  Then the output says "Installing Starkeep's dependencies (pnpm install)…"
  And setup then runs and ends with "Starkeep runs on this computer."
```

- **Coverage:** No test runs the wrapper on a checkout without an install.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLI-007] A local operator on an older Node is told to install Node 24
  Given the computer runs Node 22
  When the local operator runs any starkeep command
  Then the output says "Starkeep needs Node 24 or later, and this is Node <version>." and suggests "nvm install 24"
  And the command exits with status 1 and does nothing else
```

- **Coverage:** No test runs the wrapper on an older Node.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-008] A local operator without pnpm is told to install it
  Given no pnpm command is on the local operator's PATH
  When the local operator runs any starkeep command
  Then the output says "Starkeep needs a `pnpm` command on your PATH. Install one with `npm install -g pnpm@10`, then run the command again."
  And the command exits with status 1
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "names how to get pnpm when none is on PATH (CLI-008)" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLI-009] A local operator whose checkout moved since the last install is warned that the build may be stale
  Given the local operator pulled new commits into the checkout after its last install
  When the local operator runs a starkeep command other than setup
  Then the output warns "Warning: the checkout changed since the last install, so the built packages may be stale."
  And the warning says to run "pnpm install" in the checkout
  And the command still runs
  When the local operator runs "pnpm install" in the checkout
  Then the next starkeep command shows no warning
```

- **Coverage:** No test controls the install record the warning compares with.
- **Notes:** `setup` always runs the install first, so it never shows the warning. A run with `--json` skips the warning, so the output stays parseable.

## Setting up this computer

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-010] A local operator who runs setup gets the data server and Drive running and the next steps
  When the local operator runs "starkeep setup"
  Then the output says "Starkeep keeps its data in <folder>."
  And the output says the data server and Drive started, each with its address
  And the output ends with "Starkeep runs on this computer." and the lines "starkeep admin", "starkeep list", and "starkeep status", each with what it does
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "starts the data server and Drive and names the next steps (CLI-010)" (integration, local).
- **Notes:** `setup` and `setup --local` do the same. Cloud setup from the terminal belongs to [cloud-setup.md](cloud-setup.md).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-011] A local operator who lets setup link the command can run starkeep from any folder
  Given "~/.local/bin" is on the local operator's PATH
  And "~/.local/bin/starkeep" does not exist
  When the local operator runs "starkeep setup" in a terminal
  Then setup asks "Link ~/.local/bin/starkeep, so `starkeep` works from any folder? [y/N]"
  When the local operator answers yes
  Then the output says "Linked ~/.local/bin/starkeep → <checkout>/scripts/starkeep.mjs."
  And "starkeep status" then works from any folder
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "asks before it links, and names the PATH line when ~/.local/bin is missing from PATH (CLI-011, CLI-012)" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-012] A local operator whose PATH lacks ~/.local/bin is told the line to add
  Given "~/.local/bin" is not on the local operator's PATH
  When the local operator runs "starkeep setup" and lets it link the command
  Then the output says "~/.local/bin is not on your PATH. Add this line to your shell profile:"
  And the output shows the line 'export PATH="$HOME/.local/bin:$PATH"'
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "asks before it links, and names the PATH line when ~/.local/bin is missing from PATH (CLI-011, CLI-012)" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-013] A local operator whose ~/.local/bin/starkeep is a file of their own keeps it
  Given "~/.local/bin/starkeep" is a regular file, not a link
  When the local operator runs "starkeep setup"
  Then the output says "~/.local/bin/starkeep exists and is not a link; leaving it alone."
  And the file stays as it was
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "leaves a file of the person's own alone (CLI-013)" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-014] A local operator whose link points at another checkout is asked before it moves
  Given "~/.local/bin/starkeep" links to the wrapper of another Starkeep checkout
  When the local operator runs "starkeep setup" in this checkout
  Then setup asks whether to point the link at this checkout instead
  And an answer other than yes leaves the link pointing at the other checkout
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "asks before moving a link that points at another checkout, and a no keeps it (CLI-014)" (integration, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-015] A local operator whose setup cannot start a service is told so, with a failing exit status
  Given another program holds the data server's port
  When the local operator runs "starkeep setup"
  Then the output says "Could not start data-server:" with the reason
  And the output ends with "Setup could not start every service. See the messages above."
  And the command exits with status 1
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "says setup could not start a service whose port another program holds (CLI-015)" (integration, local), and `packages/operator/__tests__/adopt-orphan.test.ts` (unit, local).
- **Notes:** Starkeep takes over a data server or Drive that runs from the checkout's own folder, such as one left from an earlier session. Any other program on the port, a node program included, stays untouched.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-032] A local operator's script that runs setup without a terminal is told how to answer the link question
  Given the local operator's script runs "starkeep setup" with no terminal attached
  And "~/.local/bin/starkeep" does not exist
  When setup reaches the link question
  Then the output says "No terminal is attached to answer. Pass --yes or --no-link to approve."
  And the command exits with status 3
  And "~/.local/bin/starkeep" still does not exist
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "stops with status 3 at the link question without a terminal, and names the flags" (integration, local).

## Folders and paths

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLI-016] A local operator who names a folder by a relative path gets the folder the command ran in
  Given the local operator's shell is in "~/code/dice", which holds an app
  When the local operator runs "starkeep install . --local" there, through the linked command or through "pnpm starkeep" at the checkout's root
  Then the command installs the app in "~/code/dice"
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "installs the app in the folder the command ran in (CLI-016)" (integration, local). No test runs through "pnpm starkeep" at the checkout's root.
- **Notes:** `pnpm` runs scripts at the checkout's root, so the wrapper passes the person's own folder on to the command.

## Help, output, and exit codes

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-017] A local operator sees every command with one line about each, and what the exit codes mean
  When the local operator runs "starkeep help"
  Then the output lists each command with a one-line summary
  And the output says "Every command accepts --json and --help. Run `starkeep help <command>` for one command's help."
  And the output says "Exit codes: 0 success, 1 failure, 2 bad usage, 3 needs input a run without a terminal cannot give."
  And the command exits with status 0
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "names the shared flags and the exit codes in the general help (CLI-017)" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-018] A local operator sees one command's usage, flags, and which credentials it uses
  When the local operator runs "starkeep help start"
  Then the output shows "Usage: starkeep start [<name>...]" and the command's summary
  And the output shows "Credentials: This computer only. Needs no cloud credentials."
  And the output lists the command's flags, with "--json", "--verbose", and "--help"
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "prints one command's usage, lane and flags, the same for --help (CLI-018)" (unit, local).
- **Notes:** `starkeep start --help` prints the same text.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-019] A local operator who runs starkeep with no command sees the help and a bad-usage status
  When the local operator runs "starkeep" with no command
  Then the output shows the list of commands
  And the command exits with status 2
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "no command at all" and "lists every command in the general help" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-020] A local operator who mistypes a command sees which word was not understood
  When the local operator runs "starkeep strat"
  Then the output says 'Unknown command "strat".' followed by the list of commands
  And the command exits with status 2
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "an unknown command" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-021] A local operator who passes an unknown flag sees the command's help and a bad-usage status
  When the local operator runs "starkeep start --force"
  Then the output names the unknown option and shows the help for "start"
  And the command exits with status 2 and starts nothing
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "an unknown flag, with the command's help (CLI-021)" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-031] A local operator's script that passes an unknown command or flag still reads a final result
  When the local operator's script runs "starkeep start --force --json"
  Then the last output line is a result object with "ok": false and an error whose code is "USAGE"
  And the command exits with status 2
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "an unknown command or flag under --json ends with a result object" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-022] A local operator's script reads one JSON object per line and a final result
  When the local operator's script runs "starkeep start --json"
  Then each line of the output is one JSON object
  And progress lines read like {"type":"progress","message":"Started data-server on http://localhost:<port>."}
  And the last line is a result object with "ok": true and the started names
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "prints JSON progress lines and a result with the started names (CLI-022)" (integration, local).
- **Notes:** an output holds exactly one result object, even when a command continues in a new process, as `starkeep update --platform` does after it pulls the checkout, and even when the wrapper stops before the CLI runs, for example because `pnpm install` failed.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-023] A local operator's script reads a failure as a JSON result with the message and a failing exit status
  Given the local data server is stopped
  When the local operator's script runs "starkeep install dice --local --yes --json"
  Then the last output line is a result object with "ok": false and an error whose message says the local data server is not answering
  And the command exits with status 1
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "fails with exit 1 and names the fix when it is not answering" and "--json reports the failure as a result event" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-024] A local operator's script that needs an answer gets exit status 3 and the flag that gives it
  Given the local operator's script runs with no terminal attached
  When the script runs a command that asks a question, such as "starkeep install dice --local" without "--yes"
  Then the output says "Approve and install? No terminal is attached to answer. Pass --yes to approve."
  And the command exits with status 3
  And the command changes nothing
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "a run without a terminal stops before it changes anything (CLI-024)", and `packages/cli/__tests__/integration/local-scenarios.test.ts` › "stops with status 3 before the pull when no terminal can answer (CLI-024)" and "stops with status 3 before the uninstall when no terminal can type the id (CLI-024)" (unit and integration, local).
- **Notes:** a question about typing an app id back names its own flag, such as "Pass --yes to delete without typing the app id." Every command checks before its first change, so `starkeep update` stops before it pulls and `starkeep uninstall --delete-data` stops before it uninstalls.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-025] A local operator sees a step's own output only with --verbose
  When the local operator runs "starkeep install dice --local --yes"
  Then the output shows "Installing dependencies (<command> in <folder>)…" but not the package manager's own lines
  When the local operator runs the same command with "--verbose"
  Then the output also shows the package manager's lines, each indented
```

- **Coverage:** `packages/cli/__tests__/integration/local-scenarios.test.ts` › "shows a step's own output only with --verbose (CLI-025)" (integration, local).
- **Notes:** a step that fails names the log file under `~/.starkeep/logs/` that holds its whole output (APP-LIFE-222).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-030] A local operator's script that asks for a log as JSON is told to read the log file instead
  When the local operator's script runs "starkeep logs data-server --json"
  Then the output says that "starkeep logs" prints text only, and names the log file's path
  And the command exits with status 2
```

- **Coverage:** `packages/cli/__tests__/main.test.ts` › "refuses --json and names the log file (CLI-030)" (unit, local).

## Checking a computer's setup

`starkeep doctor` checks the tools, the install, the ports, and `config.json`, and on a computer with a cloud, the admin session, the terminal's AWS credentials, the bootstrap stack, and the cloud data server. Each line starts "ok", "warn", or "FAIL".

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-026] A local operator sees each check's outcome and the fix for every problem, and a failure exits with status 1
  Given this computer's config.json does not parse
  When the local operator runs "starkeep doctor"
  Then the output lists Node, pnpm, git, the install, each service's port, and config.json, each with its outcome
  And the config.json line says "FAIL" with a "Fix:" line beneath it
  And the output ends with the count of failed checks and warnings
  And the command exits with status 1
```

- **Coverage:** `packages/cli/__tests__/cost-and-doctor.test.ts` › "doctor exits 1 when a check fails, with every check in the --json result" and "fails a config.json that does not parse, or whose cloud fields disagree" (unit).
- **Notes:** a warning alone exits with status 0. Under "--json", the result lists every check.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-027] A local operator whose service port another program holds is told how to free it
  Given another program holds the data server's port, and the data server is not running
  When the local operator runs "starkeep doctor"
  Then the port's line says "FAIL" and "another program holds data-server's port"
  And the fix names "lsof -i :<port>" and the STARKEEP_PORT setting
  And a port a running Starkeep service holds passes
```

- **Coverage:** `packages/cli/__tests__/cost-and-doctor.test.ts` › "doctor fails a port another program holds, and passes one a Starkeep service holds" and "sees a port held by another program" (unit).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLI-028] A local operator with an old Node or no pnpm is told what to install
  Given this computer runs Node 22 and has no pnpm on PATH
  When the local operator runs "starkeep doctor"
  Then the Node line says "FAIL" with the fix "nvm install 24"
  And the pnpm line says "no `pnpm` on PATH" with the fix "npm install -g pnpm@10"
```

- **Coverage:** `packages/cli/__tests__/cost-and-doctor.test.ts` › "doctor fails a Node older than 24 and names the fix" and "fails a missing tool and names the fix" (unit).

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [CLI-029] A cloud operator sees the cloud's drift among the doctor's checks, and the check neither signs in nor keeps the admin session going
  Given this computer deployed the cloud, and the cloud operator is signed in as the admin
  And the bootstrap stack differs from this checkout's template, and the cloud data server is behind this checkout
  When the cloud operator runs "starkeep doctor"
  Then the bootstrap stack's line says "warn" with the fix "starkeep cloud bootstrap-update"
  And the cloud data server's line says "warn" with the fix "starkeep update --platform"
  And the admin session's idle time is unchanged
  And without an admin session, the admin session's line says "not signed in, so the cloud data server and Drive checks are skipped" with the fix "starkeep login --admin"
  And without an admin session, the AWS credentials and bootstrap stack lines still appear, and no browser opens
```

- **Coverage:** `packages/cli/__tests__/doctor-cloud.test.ts` › "warns about the bootstrap stack and a cloud data server behind the checkout, with each fix (CLI-029)", "reads the cloud without a sign-in and without counting as a use of the session (CLI-029)" and "without an admin session, says which checks it skips and still checks the AWS credentials and the bootstrap stack (CLI-029)" (unit); `packages/operator/__tests__/admin-session.test.ts` › "leaves the session's last use alone for a read that is no cloud action (CLI-029)" (unit).
- **Notes:** the doctor's help names its lane: it reads this computer, the cloud with an open admin session, and the bootstrap stack with the terminal's AWS credentials, and it changes nothing. A status bar that polls the doctor leaves the session to end after its twelve idle hours (ACCESS-198).
