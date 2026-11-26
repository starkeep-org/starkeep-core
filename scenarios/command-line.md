# Command line

This file covers the `starkeep` command itself: getting it onto a computer, the first setup on a computer, and the conventions every command shares, such as help, `--json` output, and exit codes. Each command's effect belongs to the file that owns the behavior:

- [local-data-server.md](local-data-server.md): starting, stopping, and inspecting the data server and Drive, `starkeep logs`, `starkeep admin`, and `starkeep reset-local`.
- [app-lifecycle.md](app-lifecycle.md): `starkeep source`, `list`, `info`, `install`, `uninstall`, `update`, and starting and stopping apps.

## Getting the command

```gherkin
@local
@intent:confirmed
Scenario: [CLI-001] A local operator installs Starkeep on a computer with one line
  Given the computer has git and Node 24 or later
  And the computer holds no Starkeep checkout
  When the local operator runs "curl -fsSL https://starkeep.app/install.sh | sh"
  Then the output says "Cloning Starkeep into <home>/.starkeep/platform…"
  And the output ends with "Starkeep runs on this computer." and the admin-web address
  And the local operator finds the data server and Drive running
```

- **Notes:** the script's source is `scripts/install.sh`. The script runs `starkeep setup` with the person's terminal attached, so setup can still ask its questions under `curl … | sh`.

```gherkin
@local
@intent:confirmed
Scenario: [CLI-002] A local operator who runs the install line again updates the checkout and repeats the setup
  Given the computer holds the checkout that the install line cloned
  When the local operator runs the install line again
  Then the output says "Updating the Starkeep checkout in <home>/.starkeep/platform…"
  And the checkout holds the newest code from its branch
  And the output ends with "Starkeep runs on this computer."
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-003] A local operator whose checkout holds local changes that block the update is told to commit or stash them
  Given the checkout that the install line cloned holds changes that a fast-forward pull would overwrite
  When the local operator runs the install line again
  Then the output says "Could not update <home>/.starkeep/platform with git pull --ff-only. Commit or stash your changes there, then run this again."
  And the checkout keeps the local operator's changes
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-004] A local operator whose install folder holds something else is told to move it or pick another folder
  Given "~/.starkeep/platform" exists, is not empty, and is not a Starkeep checkout
  When the local operator runs the install line
  Then the output says "<home>/.starkeep/platform exists and is not a Starkeep checkout. Move it away, or pick another folder with --dir."
  And the folder's contents stay as they were
```

```gherkin
@local
@intent:confirmed
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

```gherkin
@local
@intent:confirmed
Scenario: [CLI-006] A local operator runs the command from a checkout before any install, and the command installs its dependencies first
  Given the local operator cloned starkeep-core and never ran "pnpm install"
  When the local operator runs "pnpm starkeep setup" at the checkout's root
  Then the output says "Installing Starkeep's dependencies (pnpm install)…"
  And setup then runs and ends with "Starkeep runs on this computer."
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-007] A local operator on an older Node is told to install Node 24
  Given the computer runs Node 22
  When the local operator runs any starkeep command
  Then the output says "Starkeep needs Node 24 or later, and this is Node <version>." and suggests "nvm install 24"
  And the command exits with status 1 and does nothing else
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-008] A local operator without pnpm is told to install it
  Given no pnpm command is on the local operator's PATH
  When the local operator runs any starkeep command
  Then the output says "Starkeep needs a `pnpm` command on your PATH. Install one with `npm install -g pnpm@10`, then run the command again."
  And the command exits with status 1
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-009] A local operator whose checkout moved since the last install is warned that the build may be stale
  Given the local operator pulled new commits into the checkout after its last install
  When the local operator runs a starkeep command other than setup
  Then the output warns "Warning: the checkout changed since the last install, so the built packages may be stale."
  And the warning says to run "pnpm install" in the checkout
  And the command still runs
  When the local operator runs "pnpm install" in the checkout
  Then the next starkeep command shows no warning
```

- **Notes:** `setup` always runs the install first, so it never shows the warning. A run with `--json` skips the warning, so the output stays parseable.

## Setting up this computer

```gherkin
@local
@intent:confirmed
Scenario: [CLI-010] A local operator who runs setup gets the data server and Drive running and the next steps
  When the local operator runs "starkeep setup"
  Then the output says "Starkeep keeps its data in <folder>."
  And the output says the data server and Drive started, each with its address
  And the output ends with "Starkeep runs on this computer." and the lines "starkeep admin", "starkeep list", and "starkeep status", each with what it does
```

- **Notes:** `setup` and `setup --local` do the same. Cloud setup from the terminal belongs to [cloud-setup.md](cloud-setup.md).

```gherkin
@local
@intent:confirmed
Scenario: [CLI-011] A local operator who lets setup link the command can run starkeep from any folder
  Given "~/.local/bin" is on the local operator's PATH
  And "~/.local/bin/starkeep" does not exist
  When the local operator runs "starkeep setup" in a terminal
  Then setup asks "Link ~/.local/bin/starkeep, so `starkeep` works from any folder? [y/N]"
  When the local operator answers yes
  Then the output says "Linked ~/.local/bin/starkeep → <checkout>/scripts/starkeep.mjs."
  And "starkeep status" then works from any folder
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-012] A local operator whose PATH lacks ~/.local/bin is told the line to add
  Given "~/.local/bin" is not on the local operator's PATH
  When the local operator runs "starkeep setup" and lets it link the command
  Then the output says "~/.local/bin is not on your PATH. Add this line to your shell profile:"
  And the output shows the line 'export PATH="$HOME/.local/bin:$PATH"'
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-013] A local operator whose ~/.local/bin/starkeep is a file of their own keeps it
  Given "~/.local/bin/starkeep" is a regular file, not a link
  When the local operator runs "starkeep setup"
  Then the output says "~/.local/bin/starkeep exists and is not a link; leaving it alone."
  And the file stays as it was
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-014] A local operator whose link points at another checkout is asked before it moves
  Given "~/.local/bin/starkeep" links to the wrapper of another Starkeep checkout
  When the local operator runs "starkeep setup" in this checkout
  Then setup asks whether to point the link at this checkout instead
  And an answer other than yes leaves the link pointing at the other checkout
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-015] A local operator whose setup cannot start a service is told so, with a failing exit status
  Given another program holds the data server's port
  When the local operator runs "starkeep setup"
  Then the output says "Could not start data-server:" with the reason
  And the output ends with "Setup could not start every service. See the messages above."
  And the command exits with status 1
```

## Folders and paths

```gherkin
@local
@intent:confirmed
Scenario: [CLI-016] A local operator who names a folder by a relative path gets the folder the command ran in
  Given the local operator's shell is in "~/code/dice", which holds an app
  When the local operator runs "starkeep install . --local" there, through the linked command or through "pnpm starkeep" at the checkout's root
  Then the command installs the app in "~/code/dice"
```

- **Notes:** `pnpm` runs scripts at the checkout's root, so the wrapper passes the person's own folder on to the command.

## Help, output, and exit codes

```gherkin
@local
@intent:confirmed
Scenario: [CLI-017] A local operator sees every command with one line about each, and what the exit codes mean
  When the local operator runs "starkeep help"
  Then the output lists each command with a one-line summary
  And the output says "Every command accepts --json and --help. Run `starkeep help <command>` for one command's help."
  And the output says "Exit codes: 0 success, 1 failure, 2 bad usage, 3 needs input a run without a terminal cannot give."
  And the command exits with status 0
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-018] A local operator sees one command's usage, flags, and which credentials it uses
  When the local operator runs "starkeep help start"
  Then the output shows "Usage: starkeep start [<name>...]" and the command's summary
  And the output shows "Credentials: This computer only. Needs no cloud credentials."
  And the output lists the command's flags, with "--json", "--verbose", and "--help"
```

- **Notes:** `starkeep start --help` prints the same text.

```gherkin
@local
@intent:confirmed
Scenario: [CLI-019] A local operator who runs starkeep with no command sees the help and a bad-usage status
  When the local operator runs "starkeep" with no command
  Then the output shows the list of commands
  And the command exits with status 2
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-020] A local operator who mistypes a command sees which word was not understood
  When the local operator runs "starkeep strat"
  Then the output says 'Unknown command "strat".' followed by the list of commands
  And the command exits with status 2
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-021] A local operator who passes an unknown flag sees the command's help and a bad-usage status
  When the local operator runs "starkeep start --force"
  Then the output names the unknown option and shows the help for "start"
  And the command exits with status 2 and starts nothing
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-022] A local operator's script reads one JSON object per line and a final result
  When the local operator's script runs "starkeep start --json"
  Then each line of the output is one JSON object
  And progress lines read like {"type":"progress","message":"Started data-server on http://localhost:<port>."}
  And the last line is a result object with "ok": true and the started names
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-023] A local operator's script reads a failure as a JSON result with the message and a failing exit status
  Given the local data server is stopped
  When the local operator's script runs "starkeep install dice --local --yes --json"
  Then the last output line is a result object with "ok": false and an error whose message says the local data server is not answering
  And the command exits with status 1
```

```gherkin
@local
@intent:confirmed
Scenario: [CLI-024] A local operator's script that needs an answer gets exit status 3 and the flag that gives it
  Given the local operator's script runs with no terminal attached
  When the script runs a command that asks a question, such as "starkeep install dice --local" without "--yes"
  Then the output says "Approve and install? No terminal is attached to answer. Pass --yes to approve."
  And the command exits with status 3
  And the command changes nothing
```

- **Notes:** a question about typing an app id back names its own flag, such as "Pass --yes to delete without typing the app id."

```gherkin
@local
@intent:confirmed
Scenario: [CLI-025] A local operator sees a step's own output only with --verbose
  When the local operator runs "starkeep install dice --local --yes"
  Then the output shows "Installing dependencies (<command> in <folder>)…" but not the package manager's own lines
  When the local operator runs the same command with "--verbose"
  Then the output also shows the package manager's lines, each indented
```

- **Notes:** a step that fails names the log file under `~/.starkeep/logs/` that holds its whole output (APP-LIFE-222).
