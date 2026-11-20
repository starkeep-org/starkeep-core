# The Starkeep example app

The example app performs every app-facing data operation the platform offers, on invented plaintext files, and shows each request on its page. Copy this folder to start your own app.

The app reads and writes only `example/plaintext`, a type in the `example` category that exists for this app alone. Trying the example on a real deployment therefore never mixes invented files into anyone's library. Every example file sits under its own heading in Drive, its own metadata table and its own storage prefix, so an operator can find and delete all of them in one place. A file named `*.skexample` dropped into a watched folder arrives in the example app too.

## What the page shows

Each heading is one group of operations, with a table of the current state and a row of controls:

| Heading         | What it does                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connection      | Which surface the page runs on, who is signed in, the 403 a write outside the app's grant gets, and a call to the app's own JWT-gated route.                             |
| Example files   | Load the sample data, create from text, upload through a presigned URL, derive a copy, filter, page, count and delete.                                                   |
| Open file       | One file's record, size, dates, content, metadata row, labels, note and collections. The note saves only if nobody changed it since the file was opened.                 |
| Metadata        | The `example` category's metadata table, queried directly, with totals.                                                                                                  |
| Labels          | Add, set and retract tags and a bare flag; count files per tag; list every app's declared keys.                                                                          |
| Collections     | Named groups of files in two more app tables: create, rename, archive and delete, with each file's note and its other collections.                                       |
| Notes           | The app's own `notes` table: write, pin, delete, and search by text, prefix, edit date, the files on or off the page, or a collection.                                   |
| Analysis        | Notes per day, in SQL the app's server runs over a snapshot of the notes table, with its load time and a Refresh button.                                                 |
| Note exports    | The app's own files: save every note as a private JSON file, then list, open and delete the files.                                                                       |
| Background jobs | The app's `digest` and `keywords` jobs: a link to the platform's page that turns each on, a Run now button, and each run's outcome. Jobs need a cloud.                   |
| Vault           | Store and delete the provider token that the digest job rotates. The page lists names and update times, and never reads a value back.                                    |
| Deleted         | Every example file deleted since an instant, a restore, and the trash retention window. A deleted file keeps its note and collections, so a restore returns them.        |
| Types           | Record counts for every type the app may read.                                                                                                                           |
| Public links    | Web links to your example files, made with a file's Share button. Anyone who has a valid link can view the shared content without signing in. Public links need a cloud. |
| Activity        | Every request the page made, with method, path, status and duration.                                                                                                     |

`web/src/browser/api.ts` holds one function per operation and names the route each one calls.

### Sample data

The **Load sample data** button in Example files creates nine files with tags and flags, one derived copy, notes from several days, and three collections, one of them archived. The set lives in `common/src/sample-data.ts`. Every sample file carries the bare flag `example-app/sample`, and the button does nothing while a live file carries it. Delete the sample files to load the set again.

### Joins and subqueries

The collections feature exercises every form in "Joins and subqueries" in `docs/authoring-an-app.md`. Each function in `web/src/browser/api.ts` shows one or more:

| Function                                   | Forms                                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listCollections`                          | A left join, and a `count` over the joined key, so an empty collection counts 0.                                                                                                          |
| `collectionContents`                       | Three left joins: a column operand with `eq` and `ne`, a self-join under `as`, a filter inside `on`, qualified response keys, an `order` on a joined column, and paging over joined rows. |
| `collectionsHolding`, `collectionsLacking` | `exists` and `not_exists`.                                                                                                                                                                |
| `searchNotes`                              | `in` and `not_in`, each with a subquery or a list.                                                                                                                                        |

Every `order` the example sends uses the JSON spelling, such as `[{"col":"created_at","dir":"desc"}]`. Every request to the app's own server passes through `web/src/browser/request-gate.ts`, which keeps at most three requests in flight and retries a request that the cloud throttled. A throttled request appears in the Activity table as a 503, followed by the retry.

### Background jobs and the vault

The manifest declares two jobs, `digest` and `keywords`. The platform runs each job in the cloud for each user who turns it on. A user turns a job on with its link under the Background jobs heading, such as **Turn on digest**, which opens the platform's consent page. There the user picks a time of day or "Only when I ask". The user turns a job off on the Connections page that the Connection table links.

Each `digest` run plays a sync from another service. The run reads the user's `provider-token` secret from the vault, rotates it the way a service that issues a new token on every use would, and stores the new value. It then saves a digest of the user's example files and notes as a new example file tagged `digest`. The run's message names the file and the rotation number, never the token. The job runs in `readwrite` mode, because it writes a file.

Each `keywords` run processes the user's existing files one by one, as an OCR or classification job would. The run picks up to 25 example files that lack the `example-app/indexed` flag, oldest first. It reads each file's text, sets the file's `keyword` label to up to three of the file's most frequent words, and flags the file `indexed`. A user with more files gets them all labelled over several runs, and no run reads a file twice. The job runs in `read` mode, which reads everything and writes labels only, and its consent page offers "Only when I ask" first.

`web/src/server/jobs.ts` holds both jobs' routes, which the platform calls with a token for that one run, and the page's routes, which call the platform with the signed-in user's token.

On the local surface no job runs and no vault exists. Both headings say they need a cloud.

### MCP for outside clients

`POST /mcp` serves the example's files and notes to an MCP client such as Claude Code: list, read, tag and create files, move a file to the Trash, and write or delete notes.

- **Locally**, any program on the computer reaches it with no token: `claude mcp add --transport http example http://localhost:<port>/mcp`, with the port admin-web shows.
- **In the cloud, with OAuth**, add `<cloud URL>/apps/example-app/mcp` as the server URL with no header, for example as a claude.ai custom connector or with `claude mcp add --transport http example <cloud URL>/apps/example-app/mcp`. The client sends you through sign-in and a consent page, where you pick `read` or `readwrite`, and renews its token by itself. A `read` grant lists, reads and tags; `readwrite` also creates files, moves them to the Trash and writes notes.
- **In the cloud, with a pasted token**, for a script or a client without OAuth, follow the **Connect page** link in the page's Connection table, create a token there, and pick the same modes. Then run `claude mcp add --transport http example <cloud URL>/apps/example-app/mcp --header "Authorization: Bearer <token>"`.

The **Connections page** link in the same table lists both kinds of connection, and the user revokes them there. The page reads both links from the `connectUrl` and `connectionsUrl` fields of the app's runtime config. Both pages answer on the gateway's execute-api host, not on the cloud URL.

### How labels read

The page shows each label as `<app>/<key>=<value>`, such as `example-app/tag=spoon`. The `example-app/` prefix names the app that made the assertion. Every label has a key, and the app declares its keys in `starkeep.manifest.json`. The example app declares six:

- `tag` holds a tag you add, such as `example-app/tag=spoon`.
- `derived` marks a copy and names how the copy was made, such as `example-app/derived=uppercase`.
- `keyword` holds a keyword the `keywords` job found in the file's text, such as `example-app/keyword=flour`.
- `reviewed` is a bare flag. A bare flag has an empty value, so the page shows `example-app/reviewed` with no `=`.
- `sample` is a bare flag on each file that the Load sample data button made.
- `indexed` is a bare flag on each file that the `keywords` job has read.

### How dates read

The Open file panel shows two kinds of date. "Record created" and "Record updated" say when Starkeep made and changed the record. "Original created" and "Original modified" are the source file's own dates. Only a file from a watched folder carries file dates.

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
  src/server/mcp.ts      POST /mcp, the MCP endpoint for outside clients
  src/server/analysis.ts GET /api/notes-by-day, SQL over a snapshot of the notes
  src/server/jobs.ts     the digest and keywords jobs, and the page's job and vault routes
  src/server/data-call.ts data calls with a delegation or a job run's token
  src/browser/           the page
  scripts/bundle.mjs     the cloud bundle
e2e/                     @example-app/e2e: the tier-2 suite
mobile/                  reserved for a React Native flavor
desktop/                 reserved for a desktop flavor
```

Every flavor shares the app id `example-app`, so the platform syncs the app's notes, collections and note exports among them. See "Structuring an app with several flavors" in `docs/authoring-an-app.md`.

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

`pnpm test` runs the unit suites. They cover the MCP endpoint, a run of each job, the order of the server's routes, every page operation's URL shape, and the request gate.

To check the cloud bundle loads before you install it, build it and send it a few requests:

```bash
STARKEEP_APP_BASE_PATH=/apps/example-app STARKEEP_BUNDLE_OUT=/tmp/example-dist.zip pnpm bundle
pnpm bundle:smoke /tmp/example-dist.zip
```

The e2e suite boots a local platform from a starkeep-core checkout. `scripts/link-core-harness.mjs` finds that checkout in `STARKEEP_CORE_DIR`, in an enclosing core checkout, or as `starkeep-core` beside your repository's root. See "Testing your app" in `docs/authoring-an-app.md`.

The same suite runs against a real cloud, too. Run it after each starkeep-core release, and whenever you want to check the app in the cloud:

```bash
STARKEEP_AWS_TESTS=1 pnpm test:e2e:cloud
```

The cloud run deploys real AWS resources, so read core's `e2e-aws/README.md` first. It uses the tier-3 test stack and its settings: set `STARKEEP_AWS_E2E_REGION` once, as that README's "The test region" section says. Before the tests, the run brings the stack up to date, installs this app on it, and signs a new user in. A user made for the run starts with an empty library, even on a stack an earlier run kept up. A step that holds on one surface only, such as the local server's `Host` check or the cloud's public links, skips on the other. A passing run deletes its user and tears the stack down as `STARKEEP_AWS_TEARDOWN` says. A failing run leaves both up for debugging. Without `STARKEEP_AWS_TESTS=1`, every step skips and the run makes no AWS call.

## Copying it

1. Copy this folder anywhere. It needs nothing from the repository around it.
2. Rename the app:
   - `id` and `name` in `starkeep.manifest.json`;
   - `APP_ID` and the other names in `common/src/ids.ts`;
   - the `@example-app/` package scope in every `package.json` and import.
3. Replace `example/plaintext` with the types your app needs, in the manifest's `fileAccess` and in `common/src/ids.ts`.
4. Delete the operations your app does not use from `web/src/browser/`.
5. Keep `scripts/link-core-harness.mjs` unchanged.
