---
name: starkeep-run-local
description: Use when a Starkeep app must run against a real local platform — bring up admin-web and the data server, install and start the app, send it signed requests, run its e2e suite, and pass the checklist before calling the work done.
when_to_use: Running or testing a Starkeep app locally; verifying a change against the platform rather than mocks; sending a request to the local data server by hand; re-applying a changed starkeep.manifest.json; and always before declaring an app task finished.
---

# Run a Starkeep app against a local platform

Unit tests and a green CI do not show that an app installs. The breakages that
shipped before — a mock backend in the build, a wrong basename, a stale `dist/`
— each show up within two minutes against a local stack. This skill is the
sequence: bring the platform up, install and start the app from admin-web,
exercise it, run its e2e suite, then work through **Before you say done**.

The docs and script headers linked from each step are the source of truth. Read
them when a step does not behave as described here, and report the mismatch.

You need a starkeep-core checkout. The commands below run from its root unless
a step says otherwise. Node 22+ and pnpm (the version in core's
`packageManager`) must be on `PATH`.

## 1. Bring up the stack

Source: [README — 2. Start Starkeep Admin](../../ref/README.md#2-start-starkeep-admin)
and [3. Start the local data server](../../ref/README.md#3-start-the-local-data-server).

```sh
pnpm install                    # once, at core's root
pnpm --filter admin-web dev     # leave running
```

1. Open `http://localhost:3000`.
2. In the **Local** section, on the **Data Server** card, click
   **Start Data Server**. The data server listens on port 9820. admin-web
   starts `apps/local-data-server`; do not start it by hand.

From the README section:

- admin-web listens on `127.0.0.1` and refuses requests addressed to any name
  other than `localhost`, `127.0.0.1` or `[::1]`. Use `http://localhost:3000`.
- The data server keeps its state in `~/.starkeep/`. `STARKEEP_DIR` (an
  absolute path) in `.env.local` at core's root moves it.

Without a browser, drive the same buttons with Playwright from core's `e2e/`
package. The harness in step 4 does this for you.

## 2. Install and start the app

Source: [authoring — Installing it](../../ref/docs/authoring-an-app.md#installing-it)
and [example app — Running it](../../ref/example-app/README.md#running-it).

1. Click **Discover apps** in the header and add the app's folder, or a folder
   that holds it. A new install already registers core's `example-app/`.
2. On the app's card click `Install <name>` (for example **Install Example
   App**), then **Approve & Install**.
   Install runs the app's dependency install in its folder: the manifest's
   `installDependencies`, or the frozen install the lockfile implies
   (`pnpm install --frozen-lockfile`, `npm ci`, …). A command outside the
   approved table in that doc section is not run; the dialog shows it for you
   to run yourself.
3. Click `Start <name>`. Start runs the manifest's `localRun.command` and
   `args` in `localRun.cwd`. The card then shows the badges `Installed` and
   `Running :<port>`, and `Open <name> ↗` links to `http://localhost:<port>`.

**Install pins the folder and the manifest you approved.** Editing
`starkeep.manifest.json` afterwards changes nothing on its own. Re-apply the
change one of two ways:

- **In admin-web.** The card says "Its folder holds a changed manifest". Choose
  **Update from folder** from the card's **⋯** menu (label in
  [`LocalAppsSection.tsx`](https://github.com/myleshenderson/starkeep-core/blob/main/apps/admin-web/src/components/LocalAppsSection.tsx)).
  It asks for approval again only when the app's file access changed.
- **From a shell**, with the data server running. This is not in the docs; the
  [`scripts/upgrade-app.sh`](https://github.com/myleshenderson/starkeep-core/blob/main/scripts/upgrade-app.sh)
  header is the source. Look at the diff first:

  ```sh
  scripts/upgrade-app.sh --diff <appId>   # what is stale, no writes
  scripts/upgrade-app.sh <appId>          # apply
  ```

  It reapplies every schema step without touching rows. It is not a
  migration: a column type change that crosses a SQLite storage class is not
  applied. `STARKEEP_PORT` picks the port. It calls `python`, like
  `lds-request.sh` below. Right after an install, `--diff` lists fields the
  schema defaults (`was : []`, `now : "<absent>"`); that is expected.

## 3. Send a signed request by hand

Not in the docs; the
[`scripts/lds-request.sh`](https://github.com/myleshenderson/starkeep-core/blob/main/scripts/lds-request.sh)
header is the source.

```sh
scripts/lds-request.sh METHOD PATH [BODY]
```

- `STARKEEP_APP` names the app to sign as (default `starkeep-drive`).
- `STARKEEP_PORT` names the data server's port (default 9820).
- It needs `python` on `PATH`. Where only `python3` exists, put a `python`
  symlink to it on `PATH` first.
- It reads the app's credential from `$HOME/.starkeep/app-creds/<app>.json`,
  a literal `$HOME`: it ignores `STARKEEP_DIR`. admin-web's Install writes the
  file under `STARKEEP_DIR`
  ([`apps-install.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/apps/admin-web/src/routes/apps-install.ts)),
  so with `STARKEEP_DIR` set the script reports "no credentials". Leave
  `STARKEEP_DIR` unset while you use the script.
- It signs the pathname alone, without the query string. A body goes out as
  `Content-Type: application/json`; a GET or HEAD is signed with no body.

Read the app's declared label keys:

```sh
STARKEEP_APP=<appId> scripts/lds-request.sh GET /data/label-keys
```

Create a record: store the bytes, then register them with the hash and size
the first call returns. The type must be one the app's manifest grants.

```sh
STARKEEP_APP=<appId> scripts/lds-request.sh POST '/data/files?type=<category>/<type>' 'hello'
STARKEEP_APP=<appId> scripts/lds-request.sh POST /data/records \
  '{"type":"<category>/<type>","fileName":"by-hand.txt","contentType":"text/plain","contentHash":"<contentHash>","sizeBytes":<sizeBytes>}'
```

A type outside the grant answers 403. Filters on `GET /data/records` go under
`where=` as URL-encoded JSON, not as `?type=`.

## 4. Run e2e against a real platform

Source: [authoring — Testing your app](../../ref/docs/authoring-an-app.md#testing-your-app),
[example app — Testing it](../../ref/example-app/README.md#testing-it) and
[e2e — Gotchas baked into the harness](../../ref/e2e/README.md#gotchas-baked-into-the-harness).

The harness, `@starkeep/e2e`, boots local-data-server, admin-web and Drive from
core's source. Stop any stack you started by hand first: the harness needs the
same ports.

1. Copy
   [`example-app/scripts/link-core-harness.mjs`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/scripts/link-core-harness.mjs)
   into your app **unchanged**. It finds core in `STARKEEP_CORE_DIR`, then an
   enclosing core checkout, then `starkeep-core` beside your repository's
   root, and links the harness into `node_modules/@starkeep/`. It needs
   `pnpm install` done in core: it checks for
   `e2e/node_modules/@starkeep/testkit` there.
2. Once, in core's `e2e/`: `pnpm exec playwright install chromium`.
3. Copy
   [`example-app/e2e/global-setup.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/e2e/global-setup.ts).
   It calls `startPlatformStack({ appParentDirs: [<folder holding the app>] })`
   from `@starkeep/e2e`
   ([`e2e/src/stack.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/e2e/src/stack.ts)).
   `appParentDirs` is required; the stack returns `lds.url`, `adminUrl`,
   `driveUrl` (or `null`) and `stop()`.
4. Make the e2e script link first, as the example's does:
   `node scripts/link-core-harness.mjs && pnpm --filter <your e2e package> test`.
5. Every URL a browser opens uses `localhost`, never `127.0.0.1`. With the bare
   IP, hydration never completes and the page stays frozen (harness gotchas).

For the example app, from `example-app/`:

```sh
pnpm install
pnpm test:e2e
```

## Before you say done

Run each check and **report each one in your summary** as passed, failed or
not applicable, with what you saw. "Tests pass" alone is not done.

- [ ] **`dist/` was rebuilt on Start.** The local server must serve the build
      from this change, not an older one. The example's `start` is
      `vite build && tsx src/server/local.ts`
      ([`example-app/web/package.json`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/web/package.json)).
      If your `start` does not build, rebuild by hand before Start. Check:
      `ls -l --time-style=full-iso <web folder>/dist` is later than your last edit.
- [ ] **Any build-time backend switch is set in both the `start` and `bundle`
      paths.** A mock-or-real switch set only for one path ships the mock to the
      other (friction AI-607). The docs do not cover this; read both scripts.
- [ ] **Every URL the browser builds, and any router basename, comes from
      `import.meta.env.BASE_URL`.** The app is mounted at `/` locally and at
      `/apps/<appId>/` in the cloud. See `BASE` in
      [`api.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/web/src/browser/api.ts)
      and
      [`vite.config.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/web/vite.config.ts).
      Grep for hard-coded `"/api`, `"/_immutable` and `basename=`.
- [ ] **The session handler's `publicPaths` lists `/`, `/_immutable/*`,
      `/sign-in`, `/api/session/*` and `/starkeep-runtime-config`**, as in
      [`example-app/starkeep.manifest.json`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/starkeep.manifest.json).
      `starkeep-app-anatomy` explains why.
- [ ] **It runs on the platform.** The admin-web card shows **Installed** and
      `Running :<port>`; `http://localhost:<port>/` loads; one data call
      from the page succeeds. Watch the example's **Activity** table or your
      network tab for a 2xx on `/api/local-data/data/...`.
- [ ] **A changed manifest was re-applied** (step 2). An edited file alone
      changes nothing.
- [ ] **`validateManifest()` passes in a unit test**
      ([authoring — 2. Write `starkeep.manifest.json`](../../ref/docs/authoring-an-app.md#2-write-starkeepmanifestjson);
      [`validate.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-manifest/src/validate.ts)).
      With `@starkeep/admin-manifest` as a dev dependency:

  ```ts
  import { readFileSync } from "node:fs";
  import { expect, test } from "vitest";
  import { validateManifest } from "@starkeep/admin-manifest";

  test("starkeep.manifest.json validates", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../starkeep.manifest.json", import.meta.url), "utf8"),
    );
    const result = validateManifest(raw);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
  ```

If a step here or in a linked doc did not work as written, say so in your
report, naming the step and the actual output.

## Related skills

- `starkeep-app-anatomy`: an app's shape, its manifest and `publicPaths`.
- `starkeep-data-model`: which data calls to make.
- `starkeep-cloud-and-sign-in`: cloud install and sign-in.
