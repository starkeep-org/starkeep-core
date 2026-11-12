# Evaluation of the `starkeep` skills on a copied-out example app (AI-696)

- **Date:** 2026-11-12
- **Claude Code:** 2.1.322
- **Skills at:** starkeep-core `2abb509` (main after AI-698)
- **Path taken:** **B (desk review).** The live run (Path A) was not possible.

## Path decision

The example app was copied out the way `example-app/README.md` "Copying it" step 1 and the
`example-copied-out` CI job do it, into a scratch directory outside the repository:

```sh
git archive HEAD:example-app | tar -x -C <scratch>/example-app
cd <scratch>/example-app && pnpm install --frozen-lockfile   # Done in 3.3s using pnpm v10.20.0
```

The path probe, run in the copy:

```text
$ claude -p "reply ok" --max-turns 1
Not logged in · Please run /login
exit=1
```

The sandbox has no Claude credentials (no `~/.claude/.credentials.json`, no API key), so no session
can run and the live run below was not done. Path B applies. The copy was deleted afterwards and
nothing from it is committed.

The Path A command and task, kept here unchanged so the owner can run them in a logged-in session:

```sh
claude -p --plugin-dir <core>/plugins/starkeep --permission-mode acceptEdits \
  --allowedTools "Bash(pnpm *)" --output-format stream-json --verbose --max-turns 60 \
  "<task>" > run.jsonl
```

> This is a Starkeep app. (1) Add a label key `priority` with values low, medium or high that a user
> can set on an example file. (2) Add a route `GET /api/version` that returns the manifest version
> and is reachable without sign-in on both the local and cloud surface. (3) Add an app-specific
> table `bookmarks` (record id plus when it was bookmarked) and a control that lists bookmarked
> files. (4) Run the app locally and confirm each change works. Report what you verified and how.

## Do the skills load?

What could be checked without logging in:

- `claude plugin validate plugins/starkeep --strict` exits 0. Its only output is a plugin-directory
  warning (`ICON_MISSING`), which does not affect the result.
- `claude --plugin-dir <core>/plugins/starkeep plugin details starkeep`, run from **inside the
  copied-out app**, lists `Skills (4) starkeep-app-anatomy, starkeep-cloud-and-sign-in,
starkeep-data-model, starkeep-run-local`, at about 527 always-on tokens. All four skills are
  discovered and their frontmatter parses.
- `node scripts/check-skill-links.mjs`: `checked 4 skills, 72 links`, with no failures.

**Not proven:** that each skill can be invoked as `/starkeep:<name>` in a logged-in session, and
that the model picks it up on its own. That needs credentials. The lead asked for it, so it stays
open (see Proposed follow-ups).

## Coverage table: friction items 1–7

The friction items come from epic AI-689's "Why". Items 4 and 6 are platform gaps and are not graded
here (out of scope). Their rows only note what the skills say.

| #   | Friction item                                                                                                                           | Skill sentence that would have prevented it                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Verdict       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | Agents read Starkeep but never ran it                                                                                                   | `starkeep-run-local/SKILL.md:9` "Unit tests and a green CI do not show that an app installs." and `:168-169` "Run each check and **report each one in your summary** … "Tests pass" alone is not done." The `when_to_use` (`:4`) ends "and always before declaring an app task finished."                                                                                                                                                                                                                         | covered       |
| 2   | Config the platform expects but never enforces (`VITE_DATA_BACKEND`, router `basename`, leading-slash fetches, stale `dist/`)           | `starkeep-app-anatomy/SKILL.md:170-176` "Two build paths, one setting … set it in **both**"; `:160-162` "`fetch("/api/...")` with a leading slash, or a `BrowserRouter` without `basename={import.meta.env.BASE_URL}`, works locally … and in the cloud hits the deployment's root"; `:177-182` "Start must rebuild"; repeated as checks in `starkeep-run-local/SKILL.md:171-186`.                                                                                                                                | covered       |
| 3   | Sign-in surface learned by trial (mandatory `/sign-in` public path, no local session, `publicPaths` derives `ANY` routes)               | `starkeep-app-anatomy/SKILL.md:117-121` "The validator does not check for `/sign-in` … the first cloud request returns the gateway's raw `{"message":"Unauthorized"}`"; `starkeep-cloud-and-sign-in/SKILL.md:102-104` "a sign-in flow that "works locally" has not been exercised … Sign-in is tested only on a cloud install."; `starkeep-app-anatomy/SKILL.md:109-113` "A derived route replaces any declared route on the same path, whatever its method".                                                     | covered       |
| 4   | Headless identity for MCP (platform gap, not graded)                                                                                    | `starkeep-cloud-and-sign-in/SKILL.md:116-119` "a cloud caller with no session cookie … still gets this `401` … Obtain an ID token another way, as §11 describes".                                                                                                                                                                                                                                                                                                                                                 | not graded    |
| 5   | Row-API limits vs Postgres (AND-only, 500-row pages, inserts are upserts, reserved `deleted_at`/`updated_at`, no json, no transactions) | `starkeep-data-model/SKILL.md:95-96` "joined with **AND**. There is no `or`"; `:100` "`limit` defaults to 30 and a value above 500 is a 400"; `:163` "**Every POST is an upsert.**"; `:132-133` "`updated_at` and `deleted_at` are reserved column names"; `:126` "No json, uuid, numeric or array type."; `:167-168` "there is no multi-row body and no transaction."                                                                                                                                            | covered       |
| 6   | Local proxy anonymous, no Origin check (platform gap, not graded)                                                                       | `starkeep-cloud-and-sign-in/SKILL.md:102-103` "Locally, protect the server with the loopback `Host` and `Sec-Fetch-Site` checks (§4)."                                                                                                                                                                                                                                                                                                                                                                            | not graded    |
| 7   | Doc/dialog mismatches                                                                                                                   | `starkeep-run-local/SKILL.md:15-16` "Read them when a step does not behave as described here, and report the mismatch." and `:217-218`. The one mismatch fixed in a skill, where **Update from folder** lives, is described two ways: `starkeep-run-local/SKILL.md:69-70` says the card's **⋯** menu (it is in the menu: `LocalAppsSection.tsx` keeps one primary button and puts "Everything else" in the menu), while `starkeep-app-anatomy/SKILL.md:77` says "click **Update from folder** on the app's card". | covered (nit) |

## Coverage table: task checks (a)–(f)

| Check                                                                                            | Skill sentence that would have prevented the mistake                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Verdict |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| (a) Label key declared in `infraRequirements.labelKeys` before any write                         | `starkeep-data-model/SKILL.md:46` "Keys must be declared in `infraRequirements.labelKeys`, max 64 per app"; `starkeep-app-anatomy/SKILL.md:72-75` "Editing `starkeep.manifest.json` afterwards changes nothing: no new table, index, label key … takes effect."; single-valued recipe at `starkeep-data-model/SKILL.md:199-200` "always write it through `POST /data/labels/values` with a one-element `values`". **Gap:** the doc that `starkeep-data-model` sends the agent to for labels (§9) has three code samples that fetch `"/api/local-data/data/labels"` with a leading slash, and the skill never says to rebase them on `BASE_URL` (see (d)).                                                                                                                                                                                                                        | covered |
| (b) Route in `web/src/server/app.ts` **and** in the `static` handler's `publicPaths`             | `starkeep-cloud-and-sign-in/SKILL.md:67-69` "The origin gate … reading `publicPaths` from the manifest so gate and gateway share one list."; `starkeep-app-anatomy/SKILL.md:105-113` "Each entry becomes its own `ANY <path>` route with no authorizer … Make public only paths that are safe for anyone to call with any method"; `starkeep-cloud-and-sign-in/SKILL.md:97` "Locally the origin gate is inert". **Gap:** these are three sentences across two skills. Neither skill has a recipe that says "add an anonymous route: the Hono route in `app.ts`, plus the path in the handler's `publicPaths`, then re-apply the manifest". An agent has to put that together itself.                                                                                                                                                                                             | partial |
| (c) Table under `appSpecificSyncable.tables`, typed columns, no reserved names, index per filter | `starkeep-data-model/SKILL.md:62-64` "Declared under `infraRequirements.appSpecificSyncable`"; `:123` "Column types are exactly `integer bigint real text blob timestamp boolean`"; `:132-134` reserved names, "Pick another name, such as `updated_on`"; `:138-139` "declare one for every filter you issue"; `:201-202` "**Per-record app state** … an app table whose primary key is `record_id`".                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | covered |
| (d) Fetches built from `import.meta.env.BASE_URL`, never leading-slash `/api/...`                | `starkeep-app-anatomy/SKILL.md:155-158` "The page reads `import.meta.env.BASE_URL` … and builds every URL it fetches from it."; `starkeep-run-local/SKILL.md:180-186` "Grep for hard-coded `"/api`". **Gap:** `starkeep-data-model`, the skill an agent loads for tasks (1) and (3), never mentions `BASE_URL`. It routes to §9, whose samples use `fetch("/api/local-data/data/labels", …)` (`docs/authoring-an-app.md` §9).                                                                                                                                                                                                                                                                                                                                                                                                                                                    | partial |
| (e) Platform really brought up, copy installed and started, versus claimed                       | `starkeep-run-local/SKILL.md:22-35` (bring up admin-web, **Start Data Server**), `:47-63` (Discover apps, Install, Start), `:191-194` "**It runs on the platform.** The admin-web card shows **Installed** and `Running :<port>`". **Gaps for a copied-out app:** `:18` "You need a starkeep-core checkout" says nothing about how to get one (clone URL, or where to put it so `link-core-harness.mjs` finds it). And `:53` "A new install already registers core's `example-app/`" does not connect to the collision rule in `starkeep-app-anatomy/SKILL.md:36-39` "when two folders hold one id, Discover apps offers neither". A copy that keeps the id `example-app`, as this task requires, cannot be installed next to core's copy, and neither skill says what to do about it.                                                                                           | partial |
| (f) Can the agent open the linked docs from the copy's cwd?                                      | Links resolve inside the plugin: all `../../ref/…` links stay in `plugins/starkeep/` and the checker passes (72 links). When a skill loads, Claude Code 2.1.322 prefixes its body with "Base directory for this skill: <dir>" (string present in the CLI binary), so an agent can resolve `../../ref/docs/…` from it. **Unverified:** whether the agent follows the links, and whether `Read` outside the copy's cwd is allowed under `--permission-mode acceptEdits` in `-p` mode (a permission prompt in `-p` is a denial). No skill tells the agent that its links are relative to the skill's base directory. The 48 GitHub `blob/main` source links have no local copy: the installed `@starkeep/app-client` ships `dist/` only, so the agent needs network access (github.com answered 200 from this sandbox). They also point at `main`, not at the version the app pins. | partial |

### Frontmatter and length

| Skill                        | `description` chars | Says when it applies                                 | `when_to_use` | Lines |
| ---------------------------- | ------------------- | ---------------------------------------------------- | ------------- | ----- |
| `starkeep-app-anatomy`       | 182                 | yes: "Use when creating, restructuring or debugging" | yes           | 204   |
| `starkeep-cloud-and-sign-in` | 212                 | yes: "Use when a Starkeep app targets the cloud"     | yes           | 194   |
| `starkeep-data-model`        | 191                 | yes: "Use before designing or porting"               | yes           | 212   |
| `starkeep-run-local`         | 230                 | yes: "Use when a Starkeep app must run against"      | yes           | 224   |

All four are under the 300-character and roughly 250-line bars.

### Restatements found

Each of these paraphrases a doc paragraph that the same skill also links. The skills cite their
sources, so nothing here is wrong today. The risk is drift: when the doc changes, the skill text
goes stale, and the link checker only verifies anchors, not wording. Gotchas the docs do not state
(the `publicPaths` route derivation, row writes, build mode) are not restatements and are not
listed.

- `starkeep-cloud-and-sign-in/SKILL.md:60-69`, "Sign-in: the four pieces", restates §8 items 1–4
  almost word for word, for example "**The origin gate**, `honoOriginGate({ publicPaths, signInPath:
"/sign-in" })` … reading `publicPaths` from the manifest so gate and gateway share one list".
- `starkeep-cloud-and-sign-in/SKILL.md:71-75` restates §8 "The sign-in page must live at
  `/sign-in`", and `:97-98` restates §8 "None of this runs on the local surface".
- `starkeep-cloud-and-sign-in/SKILL.md:51-53` restates §7 "Limits on what your Lambda can return":
  "6 MB per response (about 4.5 MB binary), 30 s per request".
- `starkeep-run-local/SKILL.md:37-42`, introduced as "From the README section:", restates README §2–3
  on `localhost`-only listening and `STARKEEP_DIR`.
- `starkeep-data-model/SKILL.md:95-102` and `:112-115` restate the §6a grammar (operator list, "There
  is no `or`", "`limit` defaults to 30", aggregate "Five things"). `:123-131` restates the §6 column
  types, `timestamp` and `boolean` rules.

### Lead's verification nits

1. **`starkeep-app-anatomy/SKILL.md:140` is misleading.** It says "**The browser half is not
   documented beyond "route prefix to bake in"**" (§7). But §7 "Build tools that emit stable names"
   documents the Flutter case (`flutter build web --base-href "$STARKEEP_APP_BASE_PATH/"`, so the
   page resolves relative URLs against the app's root), and the web adapter sample passes
   `basePath: process.env.STARKEEP_APP_BASE_PATH`. Only the Vite pattern is undocumented: `base` from
   `STARKEEP_APP_BASE_PATH`, with fetches and router basename built from `import.meta.env.BASE_URL`.
   This is a follow-up below. Backlog AI-707 (browser base path in §7) is the doc side.
2. **`/starkeep:<name>` invocation in a logged-in session:** not proven. Discovery from `--plugin-dir`
   is proven (see "Do the skills load?"). Invocation needs a login this sandbox does not have.

## Findings

| #   | Row                   | Verdict           | Finding                                                                                                                                                  |
| --- | --------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | (b)                   | partial           | No single "add an anonymous route" recipe. It is split across `starkeep-app-anatomy` and `starkeep-cloud-and-sign-in`.                                   |
| F2  | (d), (a)              | partial           | `starkeep-data-model` routes to §9 samples that use leading-slash fetches and never mentions `BASE_URL`.                                                 |
| F3  | (e)                   | partial / missing | `starkeep-run-local` does not say how a copied-out app gets a starkeep-core checkout.                                                                    |
| F4  | (e)                   | missing           | `starkeep-run-local` does not say how to install a copy that keeps the id `example-app` next to core's registered copy.                                  |
| F5  | (f)                   | partial           | No skill says its links are relative to the skill's base directory. Following them from a foreign cwd under `-p` permissions is unverified.              |
| F6  | (f)                   | partial           | 48 GitHub `blob/main` source links need network access and may not match the installed package version.                                                  |
| F7  | lead nit 1            | wrong             | `starkeep-app-anatomy` says the browser half is undocumented. Only the Vite/`BASE_URL` pattern is.                                                       |
| F8  | lead nit 2            | not proven        | `/starkeep:<name>` invocation in a logged-in session.                                                                                                    |
| F9  | item 7                | nit               | **Update from folder** location is described differently in `starkeep-app-anatomy:77` and `starkeep-run-local:69-70`.                                    |
| F10 | restatements          | finding           | `starkeep-cloud-and-sign-in` §"Sign-in: the four pieces" and the `starkeep-data-model` grammar list restate the docs (listed above).                     |
| F11 | Path A command (eval) | eval-design note  | `--allowedTools "Bash(pnpm *)"` denies `scripts/lds-request.sh`, `scripts/upgrade-app.sh`, `curl` and `git clone`, which `starkeep-run-local` relies on. |

F11 is not a skill gap. It is recorded so whoever runs Path A knows that check (e) cannot pass under
the fixed command unless the agent drives everything through `pnpm` (admin-web via
`pnpm --filter admin-web dev` from a core checkout).

## Proposed follow-ups

One line per **wrong**, **missing** or **partial** row, phrased as an issue title:

- Skill starkeep-app-anatomy: add an "add an anonymous route" recipe (Hono route in `app.ts` + `static` handler `publicPaths` + re-apply the manifest, 405 for other methods) (F1)
- Skill starkeep-data-model: warn that §9 label samples use leading-slash fetches and point browser calls at `import.meta.env.BASE_URL` / starkeep-app-anatomy "Mount and fetches" (F2)
- Skill starkeep-run-local: say how a copied-out app gets a starkeep-core checkout (clone URL, `STARKEEP_CORE_DIR` or sibling `starkeep-core`) (F3)
- Skill starkeep-run-local: say how to install a copy that keeps the id `example-app` alongside core's registered example app, linking starkeep-app-anatomy's id-collision rule (F4)
- Skills (all four): state once that `../../ref/…` links resolve from the skill's base directory, and confirm `Read` reaches them from a foreign cwd under `--permission-mode acceptEdits` (F5)
- Skills (all four): decide how GitHub `blob/main` source links behave offline and against a pinned package version (F6)
- Skill starkeep-app-anatomy: correct "browser half is not documented" to "§7 documents Flutter `--base-href`; the Vite `base`/`BASE_URL` pattern is undocumented" (F7)
- Plugin starkeep: prove each skill invokes as `/starkeep:<name>` in a logged-in `claude --plugin-dir plugins/starkeep` session and run AI-696's Path A (F8)
- Skill starkeep-app-anatomy: say **Update from folder** sits in the app card's ⋯ menu, matching starkeep-run-local (F9)
- Skill starkeep-cloud-and-sign-in: replace the restated §8 "four pieces" and §7 limits with links plus the gotchas only (F10)
- Skill starkeep-data-model: replace the restated §6a grammar and §6 column rules with links, keeping only limits the docs do not state (F10)
- Skill starkeep-run-local: replace the restated README §2–3 notes with the link (F10)
- Eval AI-696 Path A: widen `--allowedTools` so starkeep-run-local's scripts and `curl` can run, or state that check (e) is graded on `pnpm`-only bring-up (F11)
