# The Starkeep example app

The example app performs every app-facing data operation the platform offers, on invented plaintext files, and shows each request on its page. Copy this folder to start your own app.

The app reads and writes only `example/plaintext`, a type in the `example` category that exists for this app alone. Trying the example on a real deployment therefore never mixes invented files into anyone's library. Every example file sits under its own heading in Drive, its own metadata table and its own storage prefix, so an operator can find and delete all of them in one place. A file named `*.skexample` dropped into a watched folder arrives in the example app too.

## What the page shows

Each heading is one group of operations, with a table of the current state and a row of controls:

| Heading       | What it does                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection    | Which surface the page runs on, who is signed in, the 403 a write outside the app's grant gets, and a call to the app's own JWT-gated route. |
| Example files | Create from text, upload through a presigned URL, derive a copy, filter, page, count and delete.                                             |
| Open file     | One file's record, content, metadata row, labels and note.                                                                                   |
| Metadata      | The `example` category's metadata table, queried directly, with totals.                                                                      |
| Labels        | Add, set and retract tags and a bare flag; count files per tag; list every app's declared keys.                                              |
| Notes         | The app's own `notes` table: write, pin, search and delete.                                                                                  |
| Note exports  | The app's own files: save every note as a private JSON file, then list, open and delete the files.                                           |
| Deleted       | Every example file deleted since an instant, a restore, and the trash retention window.                                                      |
| Types         | Record counts for every type the app may read.                                                                                               |
| Public links  | Links anyone can open, made with a file's Share button. They need a cloud.                                                                   |
| Activity      | Every request the page made, with method, path, status and duration.                                                                         |

`web/src/browser/api.ts` holds one function per operation and names the route each one calls.

## Layout

```
starkeep.manifest.json   one manifest for every flavor of the app
package.json             the scripts the platform calls: start, bundle
pnpm-workspace.yaml      one workspace holding every flavor
pnpm-lock.yaml           this app's own lockfile
scripts/
  link-core-harness.mjs  links starkeep-core's e2e harness before a test run
common/                  @example-app/common: the data contract, no DOM or Node imports
web/                     @example-app/web: the local web and cloud web flavors
  src/server/app.ts      the Hono app both surfaces run
  src/server/local.ts    the local entry, which the manifest's localRun starts
  src/server/cloud.ts    the cloud entry of the `static` handler, a Lambda
  src/server/static-options.ts  the static-file options both entries share
  src/server/api.ts      the cloud entry of the `api` handler: the JWT-gated routes
  src/server/echo.ts     POST /api/echo, the JWT-gated route
  src/browser/           the page
  scripts/bundle.mjs     the cloud bundle
e2e/                     @example-app/e2e: the tier-2 suite
mobile/                  reserved for a React Native flavor
desktop/                 reserved for a desktop flavor
```

Every flavor shares the app id `example-app`, so the platform syncs the app's notes and note exports among them. See "Structuring an app with several flavors" in `docs/authoring-an-app.md`.

## Running it

```bash
pnpm install
pnpm typecheck
pnpm test
```

admin-web shows this app by default, because a new install registers this folder in **Discover apps**. Install and start the app from admin-web; Install runs `pnpm install --frozen-lockfile` here first. To run a copy, add the copy's folder in **Discover apps**. The manifest's `localRun` runs `pnpm start` in `web/`, which builds the page and serves it.

To install it to your cloud, use admin-web's cloud install. The installer runs `pnpm install --frozen-lockfile` and then `pnpm run bundle` here. The cloud's data server must know the `example` category, so a cloud deployed before the category existed needs a redeploy first. Until then, the install fails with "Unknown type id: example/plaintext".

## Testing it

```bash
pnpm exec playwright install chromium   # once, in e2e/
pnpm test:e2e
```

The suite boots a local platform from a starkeep-core checkout. `scripts/link-core-harness.mjs` finds that checkout in `STARKEEP_CORE_DIR`, in an enclosing core checkout, or as `starkeep-core` beside your repository's root. See "Testing your app" in `docs/authoring-an-app.md`.

## Copying it

1. Copy this folder anywhere. It needs nothing from the repository around it.
2. Rename the app:
   - `id` and `name` in `starkeep.manifest.json`;
   - `APP_ID` and the other names in `common/src/ids.ts`;
   - the `@example-app/` package scope in every `package.json` and import.
3. Replace `example/plaintext` with the types your app needs, in the manifest's `fileAccess` and in `common/src/ids.ts`.
4. Delete the operations your app does not use from `web/src/browser/`.
5. Keep `scripts/link-core-harness.mjs` unchanged.
