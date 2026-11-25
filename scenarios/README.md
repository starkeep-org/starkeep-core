# Behavior scenarios

The files in this folder specify Starkeep's behavior as Gherkin scenarios, written from the user's point of view. The scenarios are the canonical statement of what the system should do. Code and tests implement the scenarios. A scenario may also record how well tests cover the behavior.

This README defines the conventions for every Starkeep repository that keeps a `scenarios/` folder. Other repositories link here instead of restating the rules.

## Problems the scenarios solve

1. Intended behavior otherwise lives only in code, tests, and design notes, and nobody can see where those sources disagree.
2. Nobody can see which behaviors automated tests cover, at which tier, and in which environment. Coverage tags answer this question for the scenarios that carry them.
3. Behaviors whose correct outcome is unsettled need a visible marker until the maintainer decides them.
4. Behaviors accepted for now but worth improving need a visible marker too.

## Development rule

A behavior change starts here.

1. Write or update the scenarios that own the behavior before writing code.
2. The maintainer confirms the scenarios correct before any code gets written. No `@intent:unclear` tag remains on them.
3. The implementing pull request adds automated tests that bring every added or changed scenario to `@coverage:full`, and adds or updates the coverage tag and **Coverage:** line.

## Files

| File                                                     | ID prefix      | Covers                                                                                                                    |
| -------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [cloud-setup.md](cloud-setup.md)                         | `CLOUD-SETUP-` | Bootstrapping a deployment in AWS, the cloud setup wizard, the first cloud operator account, custom domains, and teardown |
| [app-lifecycle.md](app-lifecycle.md)                     | `APP-LIFE-`    | Finding, installing, starting, stopping, upgrading, and uninstalling apps, locally and in the cloud                       |
| [users-and-access.md](users-and-access.md)               | `ACCESS-`      | Roles, invitations, sign-in on every surface, device pairing, user-sharing, delegated access, and OAuth clients           |
| [local-data-server.md](local-data-server.md)             | `LDS-`         | The local data server on a computer: starting, stopping, watched folders, and running several instances                   |
| [shared-data.md](shared-data.md)                         | `SHARED-`      | Shared records, types, labels, deletion and trash, and public links                                                       |
| [residency-and-stand-ins.md](residency-and-stand-ins.md) | `RESIDENCY-`   | Which file bytes each device keeps, stand-ins, and freeing up space                                                       |
| [app-data.md](app-data.md)                               | `APP-DATA-`    | App tables, rows, queries and joins, snapshots, scheduled jobs, and the credential vault                                  |
| [sync.md](sync.md)                                       | `SYNC-`        | Keeping records and rows the same across a member's devices and the cloud                                                 |
| [uploads-and-file-bytes.md](uploads-and-file-bytes.md)   | `BYTES-`       | Moving file bytes between devices and the cloud: upload order, large files, and files awaiting upload                     |
| [cloud-runtime.md](cloud-runtime.md)                     | `CLOUD-RUN-`   | What a cloud operator sees of the running cloud: app hosting, load, errors, and cost                                      |
| [drive.md](drive.md)                                     | `DRIVE-`       | The Drive app                                                                                                             |
| [app-development.md](app-development.md)                 | `APP-DEV-`     | Building a Starkeep app: the app client, the SDK, the test kit, and the example app                                       |

## Scenario shape

Each scenario sits under a `##` or `###` heading in one fenced `gherkin` block, followed by annotation lines.

````markdown
### Offline edits

```gherkin
@local @mobile
@intent:confirmed @coverage:partial
Scenario: [SYNC-014] An edit made offline appears on the other device after reconnecting
  Given a member has Photos open on a laptop and on a phone signed into the same deployment
  And the phone has no network connection
  When the member renames an album on the phone
  And the phone reconnects
  Then the laptop shows the new album name within one sync cycle
```

- **Coverage:** unit test only; no end-to-end test drives the phone-to-laptop path.
- **Notes:** free-form comments from anyone.
````

### Annotation lines

- **Intent:** optional, and temporary. An author may leave a short note on why the scenario states this outcome, as an aid to the reviewer. The reviewer deletes the line after judging the scenario. Committed scenarios carry no **Intent:** line, because each scenario stands on its own merits.
- **Coverage:** optional, and present only with a coverage tag. The line names the covering test file and test name, the tier, and the environment the test exercises. Tiers are unit (`test`), integration (`test:integration`), tier-2 end-to-end (`test:e2e` and the apps' Playwright suites), and tier-3 AWS (`test:aws`).
- **Suboptimal:** present only with the `@suboptimal` tag. The line states what to revisit.
- **Manual review:** present only with the `@manual-review` tag. The line states what the maintainer wants to review.
- **Notes:** optional free-form comments. A note may cite an STA issue that tracks implementation work.

Annotation lines cite only paths inside the repositories. Private notes outside the repositories appear as "maintainer design notes".

## Tags

| Tag                           | Meaning                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@local`, `@cloud`, `@mobile` | The environments where the behavior applies: a member's computer, the cloud deployment, or a phone           |
| `@intent:confirmed`           | The author and the reviewer, or the maintainer, judge that the scenario states the intended correct behavior |
| `@intent:unclear`             | Someone doubts that the scenario states the correct behavior, and the maintainer has not yet decided         |
| `@coverage:full`              | A passing test drives the scenario's path at a fitting tier and asserts every `Then` clause                  |
| `@coverage:partial`           | Tests cover only some `Then` clauses, only some environments, or only isolated parts of a multi-step flow    |
| `@coverage:none`              | No passing test exercises the behavior                                                                       |
| `@suboptimal`                 | The maintainer accepts the behavior for now and wants to revisit it                                          |
| `@manual-review`              | The maintainer wants to review the behavior by hand later, beyond its intent decision                        |

The coverage tags are optional. A scenario carries at most one.

No tag marks a scenario as wrong. A wrong scenario gets corrected, not tagged.

The maintainer can add `@suboptimal`, `@manual-review`, or a **Notes:** line to any scenario at any time.

## Point of view

Every scenario reads from the point of view of one user: a member, a cloud operator, a local operator, an app developer, or a visitor. That user is the scenario's actor. The title and every step speak from the actor's point of view.

- The title states the actor's outcome. A title never makes a system part its subject. Write "A member cannot see another member's photos", not "The data server refuses reads under another member's segment".
- `Given` steps describe the situation as the actor knows it, such as which apps the member installed, which devices the member signed in, or which files the member added.
- `When` steps describe what the actor does. A `When` step never describes the system's own action. Write "the cloud operator runs the install", not "the installer reads the manifest".
- `Then` steps always describe an outcome the actor can observe. The outcome belongs to the actor, never to the system.

What the actor observes depends on the role:

| Actor           | Observes                                                                                |
| --------------- | --------------------------------------------------------------------------------------- |
| member, visitor | what appears on screen, in a browser, on a phone, or later in their files               |
| cloud operator  | admin-web's cloud sections, command output, the AWS console, and the running deployment |
| local operator  | admin-web's local sections, command output, and the computer's files                    |
| app developer   | what the app receives from the platform or shows its own user                           |

Only app developer scenarios state what an app receives. A scenario whose actor is a member or an operator never ends in "the app receives a forbidden answer". The scenario states what the member sees instead, such as an empty library or the app's error message. A behavior that matters to both roles gets one scenario per role.

The title, `Given`, and `When` steps should stay in the actor's terms too.

`Given` and `When` steps may reference an internal system concept only when no user-level description can express the situation. Examples include a sync cycle, a stand-in, or an expired token. The step names the concept in plain words, and the scenario still ends in an outcome the user can observe. When a behavior seems to have only an internal outcome, the scenario follows the behavior to the later point where the user notices it. For example, data kept after an uninstall shows up when the member reinstalls the app and finds the photos still present.

Scenarios name actors by role only. The roles describe what a person does in one scenario. One person often holds several roles, sometimes at the same moment, such as a person who installs an app on a computer and in the cloud from one dialog.

- **member:** a person who uses Starkeep apps on a computer, on a phone, or in the cloud. A member needs an account only for cloud apps and sync.
- **cloud operator:** a person who manages the deployment's users, cloud apps, and cloud infrastructure, and who runs scripts that affect the cloud. Bootstrap, the cloud setup wizard, cloud installs, custom domains, costs, and cloud teardown belong to the cloud operator.
- **local operator:** a person with access to a computer's Starkeep install. The local operator runs admin-web's local sections, manages that computer's data server, apps, watched folders, and storage, joins the computer to a cloud, and runs scripts with local effect.
- **app developer:** a person who builds an app on Starkeep.
- **visitor:** a person outside the deployment, such as someone who opens a member's public link.

A phone has no local operator. Every action on a phone happens inside an app, so phone scenarios belong to the member.

Name the actor by where the action takes effect, not by the tool. Admin-web serves both operators: its cloud sections need a sign-in with cloud operator rights, and its local sections need no sign-in. A scenario whose action takes effect both on a computer and in the cloud splits into one scenario per operator.

User accounts exist only in the cloud. When an outcome depends on an account's rights or on the AWS account's credentials, a `Given` states them, such as "the local operator holds an account that can use apps but has no cloud operator rights" or "the cloud operator holds the AWS account's credentials". The roles' names deliberately differ from the implementation's names. The cloud operator corresponds to the `starkeep-admins` group and the Admin app IAM role, and a member's account corresponds to the `starkeep-users` group. Scenarios never name those groups or roles. "Admin" in a scenario names only the Admin app or quoted copy, never an actor.

Scenarios never name a real person.

## Intended behavior as the standard

Every scenario states what the system should do. Current behavior usually matches the intent, and the scenario then describes current behavior. Code and tests serve as strong evidence of intent, but the intent remains the standard.

- When code, tests, and design notes agree, the scenario states that behavior.
- When the code contradicts clear intent, the scenario states the intended behavior, and the gap gets tracked as implementation work.
- When the correct behavior is in doubt, the scenario states the author's best judgment of correct behavior and carries `@intent:unclear`. A scenario never states behavior its author believes wrong.

### Intent rubric

Authors and reviewers judge intent holistically: the question is what makes sense for the user. Code, comments, tests, and design notes inform the judgment, but any of them can be wrong, so none of them settles intent alone. A test that pins an odd-looking outcome does not make the outcome correct, and the absence of a design document does not make an obvious outcome doubtful.

A scenario earns `@intent:confirmed` when the judge is confident the scenario describes correct behavior. Any doubt earns `@intent:unclear` and an entry for the maintainer to decide. A reviewer who disagrees with the author marks the scenario `@intent:unclear` and records both outcomes, rather than overruling the author.

### Coverage rubric

Coverage tags are optional. The initial catalog left most scenarios ungraded, and a scenario without a coverage tag makes no claim about its tests. Coverage tags get added as pull requests touch the behaviors.

Coverage requires a test that passes at the recorded baseline. A failing test, a test marked `.skip`, and a test marked `it.fails` cover nothing. Coverage measures tests against the scenario's intended behavior, so a test that asserts a different outcome covers nothing either. A test in a suite that did not run at the baseline counts only with the note "suite not run at baseline".

## Granularity

One scenario covers one distinct outcome for the user. Error paths that a user can reach get their own scenarios. A `Scenario Outline` groups input variations that share one outcome, so validation rules do not explode into dozens of near-identical scenarios. When the outcome or its coverage differs by environment, the behavior splits into one scenario per environment.

## IDs, ownership, and cross-repository links

- Each file owns an ID prefix. IDs never change once committed, and a removed scenario's ID is never reused.
- Each behavior lives in exactly one file. Other files link to the owning scenario by ID instead of restating the scenario.
- Scenarios in app repositories may link to core scenarios by ID. Core scenarios may mention Photos, Drive, and the example app.
