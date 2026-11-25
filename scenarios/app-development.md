# App development

This file specifies what a person who builds a Starkeep app gets from the platform's packages and tools, and what a member sees in the example app. The app developer is the actor for the published `@starkeep/app-client` package, its local server, the runtime config, download names, the state-folder guard, the e2e harness an app links from a core checkout, the cloud suite, the cloud bundle and its smoke check, and the example app as the template to copy. The member is the actor for the example app's page on a computer or in the cloud, its two background jobs, its vault, and its tools for outside clients. The app developer is the actor for the protocol errors that only a hand-built client call can reach. The platform rules that the example app demonstrates stay in the files that own them.

Related files:

- [app-lifecycle.md](app-lifecycle.md): manifest validation, install, start, update, and uninstall.
- [users-and-access.md](users-and-access.md): sign-in helpers, the data proxy's refusals, local request checks, and outside-client tokens.
- [app-data.md](app-data.md): app tables, joins, snapshots, background jobs, and the credential vault.
- [shared-data.md](shared-data.md): records, labels, deletion and restore, and public links.
- [cloud-runtime.md](cloud-runtime.md): hosting an app's server half and serving its build files.
- [uploads-and-file-bytes.md](uploads-and-file-bytes.md): uploads and files awaiting upload.
- [local-data-server.md](local-data-server.md): the data folder and several instances on one computer.

## Getting the platform packages

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-001] An app developer gets a core change in the app only after core publishes a release
  Given an app developer's app declares `@starkeep/app-client` by a published version range
  And a change to `@starkeep/app-client` has merged into core but core has not published a release with it
  When the app developer installs the app's dependencies
  Then the app gets the last published version of `@starkeep/app-client`, which lacks the change
```

- **Notes:** The authoring guide (`docs/authoring-an-app.md` › "1. Install the SDK packages") tells authors never to point a platform package at a core checkout through `workspace:*`, `link:` or `file:`. A copy of the app would then fail to install anywhere that checkout is absent.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-002] An app developer installs, tests, builds and bundles a copy of the example app outside the core repository
  Given an app developer copies the `example-app` folder to a place outside any core checkout
  When the app developer runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm bundle`, and then `pnpm bundle:smoke` on the bundle, in the copy
  Then each command succeeds
  And the smoke check ends with "The bundle loads and answers."
```

- **Notes:** Core's CI job `example-copied-out` in `.github/workflows/ci.yml` runs these steps on a `git archive` of the folder.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-003] An app developer cannot land the example app with an unreleased core package inside it
  Given an app developer packed an unreleased core package into `example-app/vendor` to try a change before a release
  When the app developer pushes the change for review
  Then the core checks fail with "example-app/vendor holds core packages packed from an unreleased branch, for trying a change before release. Release core, point the example at the published version, and delete example-app/vendor."
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-004] An app developer who uses the web adapter gets a function bundle with no AWS SDK and no other package
  Given an app developer's server half imports `@starkeep/app-client/web`, `@starkeep/app-client/hono`, or `@starkeep/app-client/lambda`
  When the app developer bundles the app for the cloud
  Then the code those subpaths add to the bundle imports only Node's built-in modules
  And the bundle holds no AWS SDK client from `@starkeep/app-client`
```

- **Notes:** `packages/app-client/__tests__/subpath-deps.test.ts` checks the source graph and the built chunks. The Hono subpath imports no Hono, so an app gets no second copy of Hono.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-005] An app developer gets no other code in a browser bundle that imports the session-cookie or download-name helper
  Given an app developer's code imports `@starkeep/app-client/session-cookies` or `@starkeep/app-client/content-disposition`
  When the app developer bundles that code
  Then the bundle gains only the helper's own code, with no import of any other module
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-006] An app developer gets no `node:sqlite` import in a bundle that leaves out the snapshot helper
  Given an app developer's code imports any `@starkeep/app-client` entry other than `@starkeep/app-client/snapshot`
  When the app developer bundles the code for a browser, the edge, or a function
  Then the bundle never imports `node:sqlite`
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-127] An app developer loads the snapshot helper without an npm package named `sqlite`
  Given an app developer's server imports `@starkeep/app-client/snapshot` from the published package
  And the app installs no npm package named `sqlite`
  When the app developer starts the app's server
  Then the app starts with the helper loaded on Node's built-in `node:sqlite`
```

- **Notes:** The build tool strips the `node:` prefix by default. A bare `sqlite` names an npm package and fails the moment an app loads the subpath (`packages/app-client/__tests__/subpath-deps.test.ts` › "ships the snapshot subpath with the node: prefix intact").

Links: manifest validation (APP-LIFE-174 to APP-LIFE-185), the protocol version an app needs (APP-LIFE-038, APP-LIFE-115, SYNC-043).

## Serving an app on a computer

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-007] An app developer finds the local server listening on the port admin-web passes
  Given an app developer's server starts with `serveLocal` from `@starkeep/app-client/local`
  And the app's manifest sets `localRun.portFlag` to "--port"
  When the app developer starts the app from admin-web's Dashboard
  Then the app answers on `http://127.0.0.1:<port>`, at the port admin-web chose for it
  And the app's log reads "listening on http://127.0.0.1:<port>"
```

- **Notes:** Without `--port`, `serveLocal` falls back to the `PORT` variable. Keeping one port per installed app is APP-LIFE-062.

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-DEV-008] An app developer who starts the local server without a usable port sees a message naming the manifest fix
  Given an app developer's server starts with `serveLocal`
  And the server receives <port> as its port
  When the app developer starts the server
  Then the app developer sees the start fail before the app listens, with "A local app server needs a port: --port <n>. Set "localRun.portFlag" to "--port" in the app's manifest, and admin-web passes one."

  Examples:
    | port                                  |
    | no `--port` argument and no `PORT`    |
    | `--port abc`                          |
    | `--port 0`                            |
    | `--port 70000`                        |
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-009] An app developer finds the local server reachable only from this computer
  Given an app developer's server starts with `serveLocal`
  When the app developer sends a request to the app's port from another device on the same network
  Then the request gets no answer, because the app listens on 127.0.0.1 only
```

- **Notes:** The request checks that refuse a rebinding page or a page from another site are ACCESS-168, ACCESS-170, and ACCESS-172. LDS-084 states the same rule for the local data server.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-010] An app developer who copies the example app gets the platform's local server, with every local check
  Given an app developer copies the example app and starts the copy from admin-web
  When the app developer sends the copy's local server a write that carries `Origin: null` and no `Sec-Fetch-Site` header, as a browser without fetch metadata does for an opaque origin
  Then the write fails with a 403 and "This app refuses requests from other sites."
```

- **Notes:** Implementation gap: the example's `web/src/server/local.ts` builds its own guard instead of calling `serveLocal`, and the guard checks `Host` and `Sec-Fetch-Site` only, so it lets such a write through. Probe's `test-apps/probe/src/serve.ts` already runs on `serveLocal`. ACCESS-170 states the rule for every local app.

Links: the local request checks (ACCESS-168, ACCESS-170, ACCESS-171, ACCESS-172), build files on both surfaces (CLOUD-RUN-048 to CLOUD-RUN-058), app-relative routes (CLOUD-RUN-039, CLOUD-RUN-041).

## Runtime config

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-011] An app developer gets the deployment's sign-in pool, bucket and region from the runtime config in the cloud
  Given an app developer's server serves `createRuntimeConfigHandler()` from `@starkeep/app-client`
  And the app's cloud handler lists `STARKEEP_API_GATEWAY_URL`, `STARKEEP_USER_POOL_ID`, `STARKEEP_USER_POOL_CLIENT_ID`, and `STARKEEP_IDENTITY_POOL_ID` with empty values in the manifest's `env`
  And the cloud operator installed the app in the cloud
  When the app developer opens the app's page, which fetches the runtime config
  Then the page receives the deployment's browser-facing address as `apiGatewayUrl`, its user pool, client, and identity pool ids, its files bucket, and its region
  And the app's build holds none of these values
```

- **Notes:** The installer fills each listed key that it recognizes (`packages/admin-installer/scripts/cli-install-app.ts`). The handler reads its environment on every request. `apiGatewayUrl` is usually the CloudFront address, so a page never builds the consent pages' links from it (APP-DEV-013).

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-012] An app developer finds every cloud field of the runtime config empty on a computer
  Given an app developer's server serves `createRuntimeConfigHandler()`
  When the app developer starts the app from admin-web on a computer and opens its page, which fetches the runtime config
  Then the page receives no `apiGatewayUrl`, no pool ids, no bucket, and no consent pages
```

- **Notes:** A page that finds these fields empty calls the data plane through the app's own same-origin proxy.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-013] An app developer gets consent-page links on the gateway's own address
  Given an app developer's app is installed in the cloud and serves `createRuntimeConfigHandler()`
  When the app developer opens the app's page, which fetches the runtime config
  Then the page receives `connectUrl` as `<gateway address>/connect?app=<app id>`, with the app id encoded, and `connectionsUrl` as `<gateway address>/connections`
  And both links open the platform's pages, while the same paths on the CloudFront address answer with status 404
```

- **Notes:** `<gateway address>` is the deployment's execute-api address without a trailing slash. The example app's Connection table shows both links (APP-DEV-040).

## Naming a downloaded file

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-014] An app developer gets a download header that saves the file under its own name, made safe for every browser
  Given an app developer's server answers a file with the header from `contentDisposition(<name>, { inline: <inline> })`
  When the app developer opens the file's link in a browser
  Then the answer carries `<header>`, and the browser saves the file under that name

  Examples:
    | name                 | inline | header                                                                  |
    | `report.docx`        | true   | inline; filename="report.docx"; filename*=UTF-8''report.docx           |
    | `archive.zip`        | false  | attachment; filename="archive.zip"; filename*=UTF-8''archive.zip       |
    | `Café menu.pdf`      | false  | attachment; filename="Caf_ menu.pdf"; filename*=UTF-8''Caf%C3%A9%20menu.pdf |
    | `a"b\c/d`, a carriage return and line feed, and `e.txt` | true | inline; filename="a_b_c_d__e.txt"; filename*=UTF-8''a_b_c_d__e.txt |
    | three spaces         | false  | attachment; filename="download"; filename*=UTF-8''download             |
```

- **Notes:** A quote, a backslash, a slash, or a control character becomes `_`, so a name can neither break out of the quoted value nor name a path. A browser that reads `filename*` saves the UTF-8 name, and an older one saves the ASCII fallback. Drive's file route and the cloud's public links both build their header with this helper.

## The state folder and the env files

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-DEV-015] An app developer whose test would use the real `~/.starkeep` sees the test fail before it touches the folder
  Given an app developer's test runs under Vitest, or under a Playwright harness that sets `STARKEEP_TEST_GUARD=1`
  And <setting>
  When the test calls an `@starkeep/app-client` helper that finds Starkeep's state folder, such as `configPath()`
  Then the test fails with "Refusing to use the operator's real Starkeep state directory (<home>/.starkeep) under a test runner: STARKEEP_DIR resolved to <resolved>. Point STARKEEP_DIR at a throwaway directory (e.g. an mkdtemp dir or the e2e-aws/.run/<prefix> dir)."
  And the app developer's real `~/.starkeep` stays unchanged

  Examples:
    | setting                                                | resolved                  |
    | the test leaves `STARKEEP_DIR` unset                   | <home>/.starkeep          |
    | the test sets `STARKEEP_DIR` to `~/.starkeep`          | <home>/.starkeep          |
    | the test sets `STARKEEP_DIR` to `~/.starkeep/scratch`  | <home>/.starkeep/scratch  |
```

- **Notes:** `<home>` is the app developer's home folder. A throwaway folder passes, and so does a sibling whose name only starts the same way, such as `~/.starkeep-scratch` (`packages/app-client/__tests__/paths.test.ts`). Outside a test runner the default stays `~/.starkeep`.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-016] An app developer can read downloaded app assets from the real `~/.starkeep` in a test
  Given an app developer's app keeps downloaded, re-fetchable files, such as model weights, under `starkeepAssetsDir()`
  And the app developer's test runs under a test runner with `STARKEEP_DIR` unset
  When the test calls `starkeepAssetsDir()`
  Then the test receives `<home>/.starkeep/app-assets` and can read the files already downloaded there
```

- **Notes:** The helper joins the `app-assets` segment itself, so a caller cannot use it to reach any other part of the real state folder. App-owned user data under `app-local/<appId>` stays behind the guard of APP-DEV-015.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-017] A member finds that `.env.local` wins over `.env`, and `.env` fills the gaps
  Given the member's checkout holds a `.env` that sets `STARKEEP_DIR` and `STARKEEP_PORT`
  And the checkout's `.env.local` sets only `STARKEEP_DIR`, to another folder
  And the member's shell exports neither variable
  When the member starts the data server from the checkout
  Then the member finds the data server's state in the folder that `.env.local` names
  And the member reaches the data server on the port that `.env` names
```

- **Notes:** The CLIs, admin-web, and the shell scripts read the same two files at the checkout's root, found by walking up to `pnpm-workspace.yaml`, so every tool targets the same instance. The data folder outcome is LDS-080. Several instances are LDS-081 to LDS-083.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-018] A member who exports `STARKEEP_DIR` finds that it wins over both env files
  Given the member's checkout holds a `.env.local` and a `.env` that each set `STARKEEP_DIR`
  When the member runs `STARKEEP_DIR=<folder> pnpm dev` from the checkout
  Then the member finds the data server's state in `<folder>`
  And the folders that the two env files name stay unchanged
```

- **Notes:** The shell scripts follow the same order (`packages/app-client/__tests__/load-env-shell.test.ts`).

## Testing an app on a local platform

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-DEV-019] An app developer gets core's e2e harness linked from the checkout named, or else the nearest one
  Given an app developer's app copies `scripts/link-core-harness.mjs` from the example app
  And <situation>
  When the app developer runs `pnpm test:e2e`
  Then the output reads "Linked the e2e harness from <core>"
  And the run's Playwright suite imports `@starkeep/e2e` and `@starkeep/e2e-aws` from `<core>`

  Examples:
    | situation                                                                       | core                                  |
    | `STARKEEP_CORE_DIR` names a core checkout with dependencies installed            | the folder `STARKEEP_CORE_DIR` names   |
    | `STARKEEP_CORE_DIR` is unset and the app sits inside a core checkout             | that enclosing checkout               |
    | `STARKEEP_CORE_DIR` is unset and a `starkeep-core` checkout sits beside the app's repository | that sibling checkout     |
```

- **Notes:** The harness boots the platform from that checkout's source, so an app's e2e run tests the app against core as the checkout holds it. The app itself still installs `@starkeep/app-client` from npm (APP-DEV-001).

```gherkin
@local
@intent:confirmed
Scenario Outline: [APP-DEV-020] An app developer without a usable core checkout gets one message naming the path tried and the fix
  Given an app developer's app copies `scripts/link-core-harness.mjs` from the example app
  And <situation>
  When the app developer runs `pnpm test:e2e`
  Then the command exits with an error before any test runs
  And the output reads "<message>"

  Examples:
    | situation                                                                  | message |
    | `STARKEEP_CORE_DIR` is unset and no core checkout encloses or sits beside the app | The e2e suites need a starkeep-core checkout. Looked in <path> and found no e2e/package.json naming @starkeep/e2e. Set STARKEEP_CORE_DIR to a starkeep-core checkout, or run pnpm install there. |
    | `STARKEEP_CORE_DIR` names a folder that is not a core checkout              | The e2e suites need a starkeep-core checkout. Looked in <path> and found no e2e/package.json naming @starkeep/e2e. Point STARKEEP_CORE_DIR at a starkeep-core checkout, and run pnpm install there. |
    | `STARKEEP_CORE_DIR` names a core checkout where `pnpm install` never ran     | The e2e suites need a starkeep-core checkout with dependencies installed. Looked in <path> and found no e2e/node_modules/@starkeep/testkit. Point STARKEEP_CORE_DIR at a starkeep-core checkout, and run pnpm install there. |
```

- **Notes:** `<path>` is the one folder the script tried. A set `STARKEEP_CORE_DIR` is the only place the script looks, so a wrong value never falls back to another checkout.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-021] An app developer finds the e2e run's admin-web listing the app from the folder that holds it, as on a local operator's computer
  Given an app developer's e2e setup calls `startPlatformStack({ appParentDirs: [<the folder holding the app>] })`
  When the app developer runs `pnpm test:e2e`
  Then the run's admin-web lists the app from its root manifest
  And the app developer's suite can install the app through admin-web's consent flow and start it from admin-web, as a local operator would
```

- **Notes:** `startPlatformStack` refuses to start without `appParentDirs`, with "startPlatformStack needs appParentDirs: name the parent dir holding the apps under test (core's suites pass CORE_FIXTURE_APPS_DIR; an app's own suite passes its checkout)." The example app's `e2e/global-setup.ts` passes the folder that holds the app.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-022] An app developer runs e2e tests from an empty library while the real `~/.starkeep` stays untouched
  Given an app developer's own computer runs a data server with a full library in `~/.starkeep`
  When the app developer runs `pnpm test:e2e`
  Then the app under test starts with no records and no rows
  And after the run the app developer's own library, config, and running data server are unchanged
```

- **Notes:** The harness boots the data server and admin-web in throwaway temporary folders on free ports, and points admin-web's own daemon ports and app port range away from the defaults. The example's Playwright config sets `STARKEEP_TEST_GUARD=1`, so any process that would still resolve the real state folder fails instead (APP-DEV-015).

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-023] An app developer gets an e2e platform even when another program takes the data server's first port
  Given another program on the app developer's computer takes the free port the harness picked for the data server, before the data server binds it
  When the app developer runs `pnpm test:e2e`
  Then the app developer sees the tests run against a data server on another free port
```

- **Notes:** The harness tries up to three free ports, and retries only when the data server dies with `EADDRINUSE` (`packages/testkit/__tests__/integration/local-data-server-harness.test.ts`). A fixed port gets one attempt.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-024] An app developer whose e2e platform fails to start sees the data server's own output
  Given the data server in the app developer's core checkout crashes on startup
  When the app developer runs `pnpm test:e2e`
  Then the run fails before any test with "local-data-server on http://127.0.0.1:<port> exited (code <code>, signal <signal>) before becoming healthy (attempt <n> of <max>)."
  And the message continues with "--- output ---" and everything the data server printed
```

- **Notes:** A data server that stays up without answering its health check fails with "did not become healthy within <ms>ms" in place of the exit clause.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-025] An app developer who interrupts an e2e run finds no data server left running
  Given an app developer's e2e run has booted its platform
  When the app developer kills the test runner before teardown runs
  Then within ten seconds the run's data server has exited, and its port is free again
```

- **Notes:** The harness starts every data server with `STARKEEP_EXIT_WITH_PID` set to the test process, and the server checks for that process every five seconds. A data server that admin-web restarts inherits the setting, so the replacement exits too.

## Testing an app on a real cloud

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-026] An app developer who has not switched cloud tests on sees the cloud suite skip every step with no AWS call
  Given an app developer's shell does not set `STARKEEP_AWS_TESTS=1`
  When the app developer runs `pnpm test:e2e:cloud`
  Then the output reads "[app-cloud-run] STARKEEP_AWS_TESTS is not 1; the cloud run is skipped."
  And the suite reports every step as skipped
  And the app developer's AWS account shows no new stack, user, or app
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-027] An app developer sees each cloud run start as a new user with an empty library, even on a stack kept up
  Given an app developer's earlier cloud run kept the test stack up, with files and rows from that run
  When the app developer runs `STARKEEP_AWS_TESTS=1 pnpm test:e2e:cloud` again
  Then the output reads "[app-cloud-run] <app id> is ready at <app address> for <run user>", naming a user created for this run alone
  And the suite's first page load shows the app with no files and no rows
```

- **Notes:** The run brings the test stack up to date, installs the cloud data server, Drive, and the app, signs the new user in through a real browser, and creates a `read` and a `readwrite` delegation token for the app's MCP route. Every user's records and rows are their own, so an earlier run's data never changes a count.

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DEV-028] An app developer whose cloud run passes finds the run's user deleted and the stack torn down as the teardown setting says
  Given an app developer runs the cloud suite with `STARKEEP_AWS_TEARDOWN` <setting>
  When every step of the app developer's cloud suite passes
  Then the app developer finds the run's user gone from the user pool
  And <what stays>

  Examples:
    | setting           | what stays                                                                                         |
    | unset             | the whole test stack is torn down, as `scripts/teardown-bootstrap.sh` does                           |
    | set to `apps`     | the cloud data server and the apps are torn down, and the bootstrap stack stays up                   |
    | set to `none`     | the output reads "[app-cloud-run] STARKEEP_AWS_TEARDOWN=none; leaving the stack up", and every app stays installed |
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-029] An app developer whose cloud run fails finds the user and the stack left up for debugging
  Given an app developer runs the cloud suite with any `STARKEEP_AWS_TEARDOWN` setting
  When a step of the app developer's cloud suite fails
  Then the output reads "[app-cloud-run] the suite failed; leaving the stack and <run user> up for debugging (password in <run file>). To tear down by hand, preview the teardown, then run it without --dry-run: STARKEEP_DIR=<run data folder> scripts/teardown-bootstrap.sh --dry-run --prefix <prefix> --region <region>"
  And the app developer can sign in to the app as the run's user with the password in the run file
```

- **Notes:** A run whose preparation failed before writing the run file prints "[app-cloud-run] prepare wrote no run file, so it failed or never ran; leaving the stack as it is." and changes nothing.

## Checking the cloud bundle

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-030] An app developer who builds the bundle without its two settings gets a message naming both
  Given an app developer's copy of the example app has its bundle script
  When the app developer runs `pnpm bundle` without `STARKEEP_APP_BASE_PATH` or without `STARKEEP_BUNDLE_OUT`
  Then the command exits with an error and "pnpm bundle needs STARKEEP_APP_BASE_PATH (such as /apps/example-app) and STARKEEP_BUNDLE_OUT (an absolute path for dist.zip). The installer sets both."
  And the app developer finds no bundle written
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-031] An app developer gets a bundle that holds both handlers and the built page under the app's mount
  Given an app developer's copy of the example app
  When the app developer runs `STARKEEP_APP_BASE_PATH=/apps/example-app STARKEEP_BUNDLE_OUT=<path>/dist.zip pnpm bundle`
  Then the output reads "Bundle written: <path>/dist.zip (<n> KB)"
  And the zip holds `index.mjs` for the `static` handler, `api.mjs` for the `api` handler, and the built page in `assets/`
  And every asset address in the built page starts with `/apps/example-app/`
```

- **Notes:** The installer sets both variables when it runs `pnpm bundle` during a cloud install. Every package is bundled in, because the function runtime provides none.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-032] An app developer sees the smoke check load the bundle as the cloud would and report each check
  Given an app developer built the example app's bundle
  When the app developer runs `pnpm bundle:smoke <path>/dist.zip`
  Then the output lists each check with "ok", covering: both handlers export `handler`, `GET /` answers the shell, the shell names a content-hashed asset under the mount, the asset answers and is cached as immutable, the runtime config answers JSON, an anonymous data proxy call is refused with a 401, `POST /mcp` answers 401 with a `Bearer` challenge, and `POST /api/echo` echoes its message
  And the output ends with "The bundle loads and answers."
```

- **Notes:** The check feeds each handler gateway-shaped events with no cloud reachable, so it sends only requests that answer without one. The script names the example's app id and mount, so a renamed copy edits `APP_ID` in `web/scripts/bundle-smoke.mjs`.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-033] An app developer whose bundle is broken sees the smoke check exit with an error and the count of failed checks
  Given an app developer's bundle lacks the `api` handler's `handler` export
  When the app developer runs `pnpm bundle:smoke <path>/dist.zip`
  Then the output reads "FAIL api.mjs exports handler: undefined"
  And the command exits with an error after "1 bundle check(s) failed."
```

## The example app as a reference

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-034] An app developer finds a working call for every app-facing route in the example app, on both surfaces
  Given an app developer reads the example app to learn how an app calls the platform
  When the app developer looks for the example's call to an app-facing data route that a plaintext file can reach
  Then the app developer finds that call in `web/src/browser/` or `web/src/server/`, through the signing proxy
  And the example's own end-to-end suite drives the call on a computer and in the cloud
```

- **Notes:** Implementation gap: the example never calls `GET /data/records/:id/content-url`, `POST /data/records/:id/re-upload`, the local `GET /events` stream, or the cloud's thaw route for an archived file, and the platform's route sweep in `e2e/src/route-sweep.ts` skips them too. The fidelity report and the stand-in backlog apply only to photo and video types, which the example's `example/plaintext` type cannot reach. The authoring guide (`docs/authoring-an-app.md` › "The example app") says the browser half "calls every data-plane route through the signing proxy".

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-035] An app developer cannot start a renamed copy while the manifest and the shared names disagree
  Given an app developer copied the example app and changed `id` in `starkeep.manifest.json` to "my-app"
  And the copy's `common/src/ids.ts` still names "example-app"
  When the app developer starts the copy
  Then the start fails with "starkeep.manifest.json names my-app; @example-app/common names example-app"
  And the copy's `pnpm test` fails in `common/__tests__/manifest.test.ts`, which checks that `ids.ts` names the manifest's id, type, label keys, jobs, and tables
```

- **Notes:** The cloud function imports the same module, so a copy deployed with mismatched names fails on its first request. The example's README › "Copying it" lists every name to rename.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-036] A member sees a file's lines and words counted by one rule wherever the file was written
  Given a member uses the example app
  When the member creates an example file whose text is <text>
  Then the member sees <lines> under Lines and <words> under Words for the file

  Examples:
    | text                                                   | lines | words |
    | "one two", a line break, and "three"                   | 2     | 3     |
    | "one two", a line break, "three", and a line break     | 2     | 3     |
    | "  spaced", a tab, and "out  "                         | 1     | 2     |
```

- **Notes:** The browser and the server's outside-client tools both count with `common/src/text-metrics.ts`, which also counts characters as Unicode code points. Every later flavor must share the rule, because the platform syncs the metadata row and a flavor that counted differently would overwrite the counts.

## The example app: Connection

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-037] A member sees which surface the example runs on and who is signed in
  Given a member opens the example app <where>
  When the member reads the Connection table
  Then the member sees Surface "<surface>", Data server "<data server>", and Session "<session>"

  Examples:
    | where                                     | surface | data server                                 | session                 |
    | on a computer, started from admin-web     | local   | local-data-server, through the app's proxy  | none needed locally     |
    | in the cloud, signed in as <email>        | cloud   | <the deployment's browser-facing address>   | signed in as <email>    |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-038] A member who runs the grant check reads "403 refused, as it should be"
  Given a member opens the example app, whose manifest grants only `example/plaintext`
  When the member clicks "Run grant check", which tries to create a `text/txt` file
  Then the member sees "403 refused, as it should be" in the Connection table's "Grant check (write text/txt)" row
  And the Activity table shows `POST /data/records` with status 403
```

- **Notes:** The refusal itself is the data server's grant rule (users-and-access.md). Any other status shows as "unexpected <status>".

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-039] A member who calls the example's own token-checked route reads "200, echoed"
  Given a member opens the example app, signed in when it runs in the cloud
  When the member clicks "Call the JWT route"
  Then the member sees "200, echoed" in the Connection table's "JWT route (POST /api/echo)" row
  And in the cloud the Activity table shows `GET /api/session/token` with status 200 before `POST /api/echo` with status 200
```

- **Notes:** Locally the route is same-origin and needs no token. In the cloud the page fetches a short-lived token and sends it as a Bearer credential. The gateway's refusals are ACCESS-140 and ACCESS-141.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-040] A member finds the Connect and Connections pages linked in the cloud, and "none locally" on a computer
  Given a member opens the example app <where>
  When the member reads the Connection table
  Then the member sees <connect> in the "Connect page" row and <connections> in the "Connections page" row

  Examples:
    | where            | connect                                                      | connections                                       |
    | on a computer    | "none locally", with no link                                 | "none locally", with no link                      |
    | in the cloud     | a link to `<gateway address>/connect?app=example-app` that opens the platform's consent page | a link to `<gateway address>/connections` |
```

- **Notes:** The links come from the runtime config (APP-DEV-013).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-041] A member refreshes the example's session and stays signed in
  Given a member is signed in to the example app in the cloud
  And the member's short-lived token has expired, while the session is still valid
  When the member clicks "Refresh session"
  Then the member sees "Refresh session: done." in the status line
  And the Connection table still reads "signed in as <email>", and the page's next data call succeeds
```

- **Notes:** Sign-out is ACCESS-045 and ACCESS-046.

```gherkin
@cloud
@intent:unclear
Scenario: [APP-DEV-128] A member whose session refresh fails sees the failure in the status line
  Given a member has the example app open in the cloud
  And the member's session has ended, so a refresh is refused
  When the member clicks "Refresh session"
  Then the member sees "Refresh session failed: <reason>" in the status line
  And the Connection table reads "signed out"
```

- **Notes:** Implementation gap: the page ignores the refresh's answer, so a refused refresh still reports "Refresh session: done." (`example-app/web/src/browser/api.ts` `refreshSession`).

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-042] A member reads in the status line what each action did, or why it failed
  Given a member opens the example app
  When the member <action>
  Then the member sees "<what>…" in the status line while the action runs
  And then the member sees "<outcome>"

  Examples:
    | action                                              | what              | outcome                                                  |
    | clicks "Count files"                                | Count             | Count: done.                                             |
    | clicks "Create collection" with Collection name empty | Create collection | Create collection failed: name the collection first    |
```

- **Notes:** A failure from the platform reads "<what> failed: <error>: <detail>", from the answer's `error` and `detail` fields, or "<what> failed: HTTP <status>" when the answer names neither.

Links: sign-out (ACCESS-045, ACCESS-046), the token-checked route at the gateway (ACCESS-140, ACCESS-141).

## The example app: example files

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-043] A member loads the sample data and sees nine sample files, their notes and three collections
  Given a member's example app holds no sample files
  When the member clicks "Load sample data"
  Then the member reads "9 sample files, their notes and three collections." beside the button
  And the Example files list shows all nine files labelled `example-app/sample`, with `poem-upper.skexample` also labelled `example-app/derived=uppercase`
  And the Collections table lists "Recipes", "Reading list", and the archived "Old drafts"
```

- **Notes:** The set repeats tags across files, gives notes dates days apart, and puts files in overlapping collections, so every panel on the page has something to show (`example-app/common/src/sample-data.ts`).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-044] A member who loads the sample data again gets nothing new and reads why
  Given a member loaded the sample data, and at least one sample file is still in the library
  When the member clicks "Load sample data" again
  Then the member reads "Sample files already exist; delete them to load the set again."
  And the Example files list and the Collections table are unchanged
```

```gherkin
@local @cloud
@intent:unclear
Scenario: [APP-DEV-045] A member who deleted a sample collection does not get it back from a later load
  Given a member loaded the sample data, deleted the "Recipes" collection, and then deleted every sample file
  When the member clicks "Load sample data"
  Then the member reads "9 sample files, their notes and three collections."
  And the Collections table lists "Reading list" and "Old drafts" but no "Recipes"
  And no sample file lists "Recipes" among its collections
```

- **Notes:** The load writes each sample collection only when no row with its id exists or ever existed, so a deleted one stays deleted.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-046] A member creates a file from text and sees its line and word counts in the list
  Given a member opens the example app
  When the member types "hello.skexample" in File name and "Hello, Starkeep.", a line break, and "This file is an example." in Content
  And the member clicks "Create file"
  Then the member sees "hello.skexample" in the Example files list with Bytes 41, Lines 2, and Words 7
  And the Open file panel shows the file, with Size "41 bytes" and its text
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-047] A member uploads a file and sees it open with its counts
  Given a member opens the example app
  When the member picks "uploaded.skexample", holding three lines of one word each, in "Upload a file"
  Then the member sees "Upload: done." in the status line
  And the Example files list shows "uploaded.skexample" with Lines 3 and Words 3, and the Open file panel shows it
```

- **Notes:** The page uploads the bytes straight to the address the platform signs, so a large file never passes through the data server's request body. Upload order and files awaiting upload are in uploads-and-file-bytes.md.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-048] A member makes an uppercase copy, named with "-upper" and marked as a copy
  Given a member's example app lists "hello.skexample"
  When the member clicks "Copy uppercase hello.skexample"
  Then the member sees "hello-upper.skexample" in the list, with "yes" under Copy of and `example-app/derived=uppercase` under Labels
  And the Open file panel shows the copy's text in capitals, and its Copy of row names the original's id
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-049] A member filters the files to originals, to copies of the open file, or to one tag
  Given a member's example app holds "hello.skexample", its copy "hello-upper.skexample", and "notes.skexample" tagged "draft"
  And the member opened "hello.skexample"
  When the member picks "<show>" in Show, types "<tag>" in Tag, and clicks "Apply filter"
  Then the member sees only <files> in the Example files list

  Examples:
    | show                        | tag   | files                                    |
    | Originals only              |       | "hello.skexample" and "notes.skexample"  |
    | Copies of the selected file |       | "hello-upper.skexample"                  |
    | Tagged…                     | draft | "notes.skexample"                        |
    | All                         |       | all three files                          |
```

- **Notes:** With no file open, "Copies of the selected file" fails with "Filter failed: select a file first".

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-050] A member pages through more files than one page of ten holds
  Given a member's example app holds twelve files
  When the member clicks "Apply filter" with All selected
  Then the member sees the ten newest files and a "Next page" button
  And after "Next page" the member sees the two oldest files, a "Previous page" button, and no "Next page" button
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-051] A member counts every example file without paging
  Given a member's example app holds twelve files, more than one page shows
  When the member clicks "Count files"
  Then the member reads "12" in the File count
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-052] A member fetches links for the files on the page and opens each one
  Given a member's example app lists three files on the current page
  When the member clicks "Fetch URLs for this page"
  Then the member reads "3 URLs" beside the button, above one link per file named by its file name
  And each link opens that file's own text
```

- **Notes:** The page asks for every link in one call.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-053] A member deletes a file, and its copies leave the list with it
  Given a member's example app lists "hello.skexample" and its copy "hello-upper.skexample"
  And "hello.skexample" carries a note
  And the member has "hello-upper.skexample" open
  When the member clicks "Delete hello.skexample"
  Then the member sees neither file in the Example files list, and both in the Deleted files table
  And the Open file panel reads "Select a file with its Open button."
  And the file's note still appears in the Notes table
```

- **Notes:** The platform rule is SHARED-107. Restore is APP-DEV-113 and SHARED-116.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-054] A member with no files reads how to add one
  Given a member's example app holds no example files
  When the member opens the example app
  Then the Example files list reads "No example files. Create one above, or drop a .skexample file into a watched folder."
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-055] A member finds a `.skexample` file from a watched folder in the example app
  Given a member watches a folder on the computer and has the example app open
  When the member saves "trip.skexample" into the folder and clicks "Apply filter"
  Then the member sees "trip.skexample" in the Example files list
  And after opening it the member sees the source file's dates under Original created and Original modified
```

- **Notes:** The platform types a `.skexample` file as `example/plaintext`, the example's own type. The source dates are SHARED-019.

Links: the type a record gets (SHARED-006), watched-file dates (SHARED-019), deletes taking derived copies (SHARED-107), restore (SHARED-116), labels on create (SHARED-063).

## The example app: Open file

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-056] A member opens a file and sees its record, content, metadata, labels, note and collections
  Given a member's example app lists "grocery-list.skexample" from the sample data
  When the member clicks "Open grocery-list.skexample"
  Then the Open file panel shows the rows Id, Name, Size, Record created, Record updated, Original created, Original modified, Copy of, Labels, Metadata, Note, and Collections
  And the Note row reads "Check the pantry before shopping (pinned)", and the Collections row reads "Recipes"
  And the panel shows the file's text below the table
```

- **Notes:** A file made in the app has no source file, so Original created and Original modified read "—". Labels read as `<app>/<key>=<value>`, or `<app>/<key>` for a flag without a value. An archived collection reads "<name> (archived)".

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-057] A member saves a note on the open file and finds it in Notes
  Given a member has "hello.skexample" open, with no note
  When the member types "first note" in Note, ticks Pinned, and clicks "Save note"
  Then the Open file panel's Note row reads "first note (pinned)"
  And the Notes table lists "first note" with "yes" under Pinned, and Pinned notes reads "1"
```

- **Notes:** "Delete note" in the panel removes the note, and the Note row then reads "none". The note lives in the app's own table, which syncs between every place the app runs.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-058] A member cannot overwrite a note that changed in another tab since the file was opened
  Given a member has "hello.skexample" open in one tab
  And <change elsewhere> in another tab after the member opened the file
  When the member clicks "<button>" in the first tab
  Then the member reads "<message>" in the status line
  And after opening the file again the member sees the other tab's note

  Examples:
    | change elsewhere                                     | button      | message                                                                                |
    | the member edited the file's note                    | Save note   | Save note failed: the note changed since the file was opened; open it again           |
    | the member edited the file's note                    | Delete note | Delete note failed: the note changed since the file was opened; open it again         |
    | the member added a note to the file, which had none  | Save note   | Save note failed: a note was added since the file was opened; open it again           |
```

- **Notes:** The page sends the note's stamp with an edit and asks for a create only if absent, so a write from another tab is never silently overwritten. The conditional-write rules are in app-data.md.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-059] A member recomputes a file's wrong counts and sees them corrected
  Given a member's "hello.skexample" holds two lines and seven words, but its counts read Words 99, as an older build of the app could write them
  When the member opens the file and clicks "Recompute metadata"
  Then the member sees Lines 2 and Words 7 for the file in the Example files list
  And the Open file panel's Metadata row shows `"word_count":7`, and the Metadata totals follow
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-060] A member whose open file was deleted elsewhere sees the panel empty
  Given a member has a file open in the example app
  And the member deleted the same file from another tab or through an outside client
  And the Notes table lists another file's note
  When the member clicks that note's Pin button
  Then the Open file panel reads "Select a file with its Open button."
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-061] A member who opens a file whose bytes are missing on this computer sees the read error, and the panel stays
  Given a member's computer holds an example file's record but has lost the file's bytes, as after the member removed them from the data folder by hand
  And the computer does not sync with a cloud
  When the member clicks the file's Open button
  Then the member reads "Open failed: File not on this node, and this node does not sync with a cloud" in the status line
  And the Open file panel keeps what it showed before the click, and does not read "Select a file with its Open button."
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-062] A member adds the open file to a collection and removes it again
  Given a member has "haiku.skexample" open, which sits only in the archived "Old drafts"
  And the member created an empty collection "Favorites"
  When the member clicks "Add to Favorites"
  Then the Open file panel's Collections row reads "Favorites, Old drafts (archived)", and Favorites counts 1 file
  And the panel offers "Remove from Favorites" and "Remove from Old drafts", and no "Add to Old drafts", because an archived collection takes no new files
```

- **Notes:** "Remove from Favorites" takes the file out again, and Favorites counts 0.

## The example app: Metadata and Labels

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-063] A member sees the example category's metadata, largest files first, with totals
  Given a member's example app holds "hello.skexample" and its uppercase copy, with seven words each, and "uploaded.skexample", with three
  When the member reads the Metadata section
  Then the Metadata table lists Words 7, 7, 3 in that order, with each file's Lines and Characters
  And the Metadata totals read files 3, words 17, and longest 3
```

- **Notes:** The table shows the ten files with the most words. The totals cover every example file.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-064] A member adds tags and the reviewed flag to the open file and reads them as app, key and value
  Given a member has "hello.skexample" open
  When the member types "draft, idea" in Tags, ticks Reviewed, and clicks "Add tags"
  Then the Open file panel's Labels row shows `example-app/tag=draft`, `example-app/tag=idea`, and `example-app/reviewed`
  And the Example files list shows the same labels for the file
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-065] A member sets tags exactly, retracts some, or retracts them all
  Given a member has "hello.skexample" open, tagged "draft" and "idea"
  When the member types "<typed>" in Tags and clicks "<button>"
  Then the member sees the file's tags as <tags>

  Examples:
    | typed        | button              | tags                  |
    | draft        | Retract these tags  | "idea" only           |
    | idea, final  | Set tags exactly    | "idea" and "final"    |
    | idea         | Set tags exactly    | "idea" only           |
    |              | Retract all tags    | none                  |
```

- **Notes:** "Retract reviewed" removes the reviewed flag and leaves the tags.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-066] A member sees each tag's file count and every app's declared label keys
  Given a member loaded the sample data
  When the member reads the Labels section
  Then the Tag counts table lists each tag with its number of files, such as "kitchen" with 2
  And the Declared label keys table lists each app's keys with their descriptions, including the example's `tag`, `reviewed`, `derived`, `sample`, `keyword`, and `indexed`
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-067] A member who changes labels with no file open reads "select a file first"
  Given a member has no file open in the example app
  When the member clicks "<button>"
  Then the member reads "<what> failed: select a file first" in the status line

  Examples:
    | button              | what              |
    | Add tags            | Add tags          |
    | Set tags exactly    | Set tags          |
    | Retract these tags  | Retract tags      |
    | Retract all tags    | Retract all tags  |
    | Retract reviewed    | Retract reviewed  |
```

## The example app: Collections

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-068] A member creates a collection, and it lists with a count of 0
  Given a member opens the example app
  When the member types "Favorites" in Collection name and clicks "Create collection"
  Then the Collections table lists "Favorites" with Files 0
  And the contents table below reads "Favorites holds no files. Open a file and add it."
```

- **Notes:** With no collections at all, the table reads "No collections. Create one above, or load the sample data."

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-069] A member who creates or renames a collection without a name is told to type one
  Given a member's example app lists the collection "Favorites"
  And the Collection name box is empty
  When the member clicks "<button>"
  Then the member reads "<message>" in the status line

  Examples:
    | button             | message                                                         |
    | Create collection  | Create collection failed: name the collection first             |
    | Rename Favorites   | Rename collection failed: type the new name in Collection name  |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-070] A member renames, archives and unarchives a collection
  Given a member's example app lists the collection "Favorites"
  When the member types "Keepers" in Collection name and clicks "Rename Favorites", then clicks "Archive Keepers", then "Unarchive Keepers"
  Then the Collections table lists "Keepers" in place of "Favorites"
  And "yes" shows under Archived after the archive and is gone after the unarchive
```

- **Notes:** An archived collection keeps its files, but it leaves the "Also in" column (APP-DEV-071) and the Open file panel's Add buttons (APP-DEV-062).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-071] A member shows a collection's files with each file's note and the other open collections that hold it
  Given a member loaded the sample data
  When the member clicks "Show Recipes"
  Then the contents table lists the three Recipes files with File, Note, Also in, and Added
  And "grocery-list.skexample" shows the note "Check the pantry before shopping", "pancakes.skexample" shows "Reading list" under Also in, and "bread.skexample" shows note "none" and an empty Also in, because its other collection is archived
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-072] A member deletes a collection, and its files stay
  Given a member's collection "Favorites" holds "haiku.skexample"
  When the member clicks "Delete collection Favorites"
  Then the Collections table no longer lists "Favorites"
  And "haiku.skexample" stays in the Example files list, and its Collections row no longer names Favorites
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-073] A member finds a deleted file still in its collections, and named again after the restore
  Given a member shows the sample "Recipes" collection, which holds "bread.skexample"
  When the member deletes "bread.skexample" and then restores it from the Deleted files table
  Then while the file sits in the Trash, Recipes still counts 3 files, and its contents list the file as "<id> (deleted)"
  And after the restore the contents list "bread.skexample" by name again
```

- **Notes:** The platform leaves an app's own rows alone when a record goes to the Trash (APP-DATA-076, SHARED-123).

Links: an app's own rows through trash and restore (APP-DATA-076, SHARED-123), joins (APP-DATA-053 to APP-DATA-068).

## The example app: Notes and Analysis

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-074] A member pins and unpins a note, and the pinned count follows
  Given a member's example app lists the pinned note "first note" in the Notes table, and Pinned notes reads "1"
  And the member has the note's file open
  When the member clicks "Unpin first note"
  Then the Notes table shows an empty Pinned cell for "first note", and Pinned notes reads "0"
  And the member can still save an edit to the note from the Open file panel
```

- **Notes:** "Pin <note>" pins it again. Pinned notes list ahead of the others, and each group lists newest first.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-075] A member deletes a note from the Notes list
  Given a member's example app lists the notes "first note" and "50% off_now"
  When the member clicks "Delete note 50% off_now"
  Then the Notes table lists only "first note"
  And the file the note belonged to stays in the Example files list
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-076] A member searches notes by text, by prefix, or by edit date
  Given a member's example app holds the notes "first note" and "50% off_now"
  When the member types "<search>" in Search, picks "<match>" in Match, types "<since>" in Edited since, and clicks "Search notes"
  Then the Notes table shows <result>

  Examples:
    | search             | match       | since                     | result                          |
    | %                  | Contains    |                           | only "50% off_now"              |
    | _                  | Contains    |                           | only "50% off_now"              |
    | first              | Contains    |                           | only "first note"               |
    | nothing like this  | Contains    |                           | "Nothing yet."                  |
    | note               | Starts with |                           | "Nothing yet."                  |
    | first              | Starts with |                           | only "first note"               |
    |                    | Contains    | 2999-01-01T00:00:00.000Z  | "Nothing yet."                  |
    |                    | Contains    | 2000-01-01T00:00:00.000Z  | both notes                      |
```

- **Notes:** `%` and `_` match as the characters themselves, never as wildcards.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-077] A member narrows a note search to files on the page, off the page, in no collection, or in one collection
  Given a member loaded the sample data, and the Example files list shows its newest page
  When the member picks "<files>" in Files and clicks "Search notes"
  Then the Notes table shows <result>

  Examples:
    | files                    | result                                                                                                     |
    | Files on this page       | the notes of the files the Example files list shows                                                        |
    | Files not on this page   | "Nothing yet.", because the newest page holds every sample file                                            |
    | Files in no collection   | "Send the summary on Friday", and not "Check the pantry before shopping"                                    |
    | Files in Reading list    | "Double the batch for guests", "Ask the library about the sequel", and "Second stanza needs work", in that order |
```

- **Notes:** The Files choices list one "Files in <name>" entry per collection.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-078] A member finds notes past the first page in a note search
  Given a member's example app holds 26 unpinned notes that contain "paging note"
  When the member types "paging note" in Search and clicks "Search notes"
  Then the Notes table lists all 26 notes
```

- **Notes:** The page reads 25 rows per request and follows the page token.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-079] A member sees notes per day in the member's own time zone
  Given a member's browser runs in a time zone five hours behind UTC, with no daylight-saving change since the note was saved
  And the member saved a note at 02:00 UTC on 10 March, which was 21:00 on 9 March in the member's zone
  When the member clicks "Refresh analysis"
  Then the Notes per day table lists the note under the day 9 March, with its Notes, Pinned, and Average length counts
  And the member reads beside "As of" the time the table's numbers were loaded
```

- **Notes:** A note without an edit date lists under "undated".

```gherkin
@local @cloud
@intent:unclear
Scenario: [APP-DEV-129] A member sees a note from before a daylight-saving change counted on the day the member saw
  Given a member's browser runs in a zone that moved its clocks forward one hour last week
  And the member saved a note at 23:30 local time on a day before the change
  When the member clicks "Refresh analysis"
  Then the Notes per day table lists the note under the day the member saved it
```

- **Notes:** Implementation gap: the page sends only its current offset from UTC, so a note from before the change shifts by an hour and can land on the next day (`example-app/web/src/server/analysis.ts`).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-080] A member who clicks Refresh analysis sees a new note counted
  Given a member's Notes per day table loaded before the member saved a note
  When the member clicks "Refresh analysis"
  Then the Notes per day table counts the note
  And "As of" shows a time after the note was saved
```

- **Notes:** In the cloud each warm function keeps its own copy, and the Refresh floor reaches whichever copy answers. The snapshot rules are APP-DATA-077 to APP-DATA-079.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-131] A member on a computer sees Analysis keep its earlier numbers after saving a note
  Given a member opened the example app on a computer less than five minutes ago, and the Notes per day table shows its counts
  When the member saves a note on the open file
  Then the Notes per day table does not yet count the note, and "As of" keeps its earlier time
```

- **Notes:** The Analysis section says a saved note "appears here after Refresh or once the snapshot expires", and the snapshot lives five minutes. In the cloud a request can reach a function whose copy loaded after the save, so the cloud may count the note at once.

Links: the snapshot's age and Refresh floor (APP-DATA-077 to APP-DATA-079).

## The example app: Note exports

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-081] A member saves every note as a private export file and opens it
  Given a member's example app holds the note "first note"
  When the member clicks "Save export", and then "Open exports/notes-<time>.json" in the Note exports table
  Then the Note exports table lists one row with Sub-key `exports/notes-<time>.json`, its Bytes, and its Created time
  And the page shows the export's JSON, which holds "first note"
```

- **Notes:** An export is one of the app's own files, which only this app can read.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-082] A member sees every export, past the first page
  Given a member's example app holds 31 exports
  When the member clicks "Save export"
  Then the Note exports table lists all 32 exports
```

- **Notes:** A page of the listing holds 30 files, so the page follows the page token.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-083] A member fetches every export's link at once and opens each one
  Given a member's example app holds two exports
  When the member clicks "Get export URLs"
  Then the member reads "2 URLs fetched in one call." above one link per export, each named by the export's sub-key
  And each link opens that export's JSON
```

- **Notes:** The page asks for the first 200 exports' links only, the most one call takes.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-084] A member without exports who asks for links reads "no exports yet"
  Given a member's example app holds no exports
  When the member clicks "Get export URLs"
  Then the member reads "Get export URLs failed: no exports yet" in the status line
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-085] A member deletes an export, and it leaves the list
  Given a member's example app holds one export
  When the member clicks "Delete exports/notes-<time>.json"
  Then the Note exports table reads "Nothing yet."
```

## The example app: Background jobs

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-086] A member on a computer reads that background jobs need a cloud
  Given a member opens the example app on a computer
  When the member reads the Background jobs section
  Then the member reads "Background jobs need a cloud. No job runs on this computer."
  And the section offers no Run now button
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DEV-087] A member sees each job's state, schedule, next run and last run in the cloud
  Given a member opens the example app in the cloud
  And <setup>
  When the member reads the Background jobs table
  Then the member sees State "<state>", Schedule "<schedule>", and Last run "<last run>" for the digest job
  And the Next run cell shows <next run>

  Examples:
    | setup                                                        | state | schedule                               | last run                                                | next run                         |
    | the member never turned digest on                            | off   |                                        | never                                                   | nothing                          |
    | the member, whose browser runs in Europe/Paris, turned digest on at 07:00 in Europe/Paris | on | every day at 07:00, Europe/Paris | never                                | the date and time of the next 07:00 |
    | the member turned digest on for "Only when I ask", stored no provider token, and ran it | on | only when you ask        | ok: Wrote digest-<date>.skexample; no provider token stored | nothing          |
```

- **Notes:** While a run is in progress, State reads "on, running".

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-088] A member turns a job on from the example's link and returns to the example
  Given a member's digest job is off
  When the member clicks "Turn on digest", picks "Only when I ask" on the platform's consent page, clicks "Sign in and turn the job on", and then follows "Back to" the app
  Then the member is back on the example app's page
  And the digest row reads State "on" and Schedule "only when you ask", with a "Change digest" link in place of "Turn on digest"
```

- **Notes:** The link opens `<gateway address>/connect/job?app=example-app&job=digest&tz=<the browser's zone>&return=/apps/example-app/`. The consent page and its choices are APP-DATA-093 to APP-DATA-101.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-089] A member who clicks Run now sees the run's outcome once it ends
  Given a member turned the digest job on
  When the member clicks "Run digest now"
  Then the member reads "Run digest…" in the status line while the table redraws as the run proceeds
  And once the run ends the member reads "Run digest: done.", and the Last run cell shows the run's message
  And the Example files list shows the digest file the run wrote
```

- **Notes:** The page queues one run and checks on it every two seconds.

```gherkin
@cloud
@intent:unclear
Scenario: [APP-DEV-090] A member who clicks Run now on a job that is off reads why it failed
  Given a member's digest job is off
  When the member clicks "Run digest now"
  Then the member reads "Run digest failed: not-enabled" in the status line
  And no run starts, and the Last run cell keeps its value
```

- **Notes:** The platform's refusal is APP-DATA-122.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-091] A member whose Run now ends in a failed run reads the run's message
  Given a member turned the digest job on
  And the next digest run fails, for example because the cloud cannot read the member's vault
  When the member clicks "Run digest now"
  Then the member reads "Run digest failed: the run ended failed: <the run's message>" in the status line
  And the Last run cell reads "failed: <the run's message>"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-092] A member whose Run now the cloud postpones sees the postponed run's outcome without asking again
  Given a member turned the digest job on
  And the deployment is busy when the member asks, so the platform postpones the run to its next five-minute tick
  When the member clicks "Run digest now"
  Then the status line keeps reading "Run digest…" while the Last run cell shows the postponed run
  And when the tick runs the job, the member reads "Run digest: done." and the run's message, without the page having asked for a second run
```

- **Notes:** While a run is postponed the page checks every ten seconds instead of every two.

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DEV-130] A member whose Run now outlasts seven minutes is told to use Refresh jobs
  Given a member turned the digest job on
  And <situation>
  When the member clicks "Run digest now" and waits more than seven minutes
  Then the member reads "Run digest failed: <message>" in the status line
  And a later "Refresh jobs" shows the run's outcome once it has one

  Examples:
    | situation                                                                  | message                                                                       |
    | the platform postponed the run and has not run it seven minutes later      | the cloud was busy, and the platform has not run the job yet; use Refresh jobs |
    | the platform reports neither a postponement nor an outcome for the run seven minutes later | the run has not finished yet; use Refresh jobs                  |
```

- **Notes:** The page waits 420 seconds, which covers a postponed run and the next five-minute tick. The example's job handler stops after ten seconds, so the second row arises when the platform loses the run before it starts, not from a slow run.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-093] A member who turns both jobs off on the Connections page can no longer run them
  Given a member turned the digest and keywords jobs on
  When the member opens the Connections page from the Connection table and clicks "Turn off" on both jobs' rows
  Then after returning to the example app the member sees State "off" for both jobs
  And a click on "Run digest now" or "Run keywords now" shows a failure in the status line, and no run starts
```

- **Notes:** The Connections page is APP-DATA-102 to APP-DATA-110. The failure's wording is APP-DEV-090.

Links: the consent page and its choices (APP-DATA-093 to APP-DATA-101), Run now refusals (APP-DATA-122 to APP-DATA-127), "Only when I ask" first (APP-DATA-095), the Connections page (APP-DATA-102 to APP-DATA-110).

## The example app: Vault

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-094] A member on a computer reads that the vault needs a cloud, and a save fails with the same reason
  Given a member opens the example app on a computer
  When the member types "local-token" in Provider token and clicks "Save provider token"
  Then the Vault section reads "The vault needs a cloud. This computer keeps no secrets."
  And the member reads "Save provider token failed: The vault needs a cloud" in the status line
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-095] A member stores the provider token and sees its name and time, never its value
  Given a member's vault reads "No secrets stored."
  When the member types a token in Provider token and clicks "Save provider token"
  Then the Vault table lists "provider-token" with the time it was updated
  And the token's value appears nowhere on the page, and the Provider token box is empty again
```

- **Notes:** Only a run of one of the app's jobs reads the value back (APP-DATA-141 to APP-DATA-153).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-096] A member who saves without typing a token reads "type a token first"
  Given a member opens the example app
  And the Provider token box is empty
  When the member clicks "Save provider token"
  Then the member reads "Save provider token failed: type a token first" in the status line
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-097] A member deletes the provider token, and the vault reads "No secrets stored."
  Given a member's vault lists "provider-token"
  When the member clicks "Delete provider-token"
  Then the Vault section reads "No secrets stored."
  And the next digest run's Last run ends in "; no provider token stored"
```

Links: vault rules (APP-DATA-141 to APP-DATA-153).

## The example app's digest job

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-098] A member whose digest job runs finds a digest file of the member's counts, tagged digest
  Given a member turned the digest job on, and holds 12 example files and 5 notes, 2 of them pinned
  When the member clicks "Run digest now", or the job runs at the member's chosen time
  Then the member finds a new file `digest-<UTC date>.skexample` in the Example files list, labelled `example-app/tag=digest`
  And opening it shows "Example files: 12" and "Notes: 5, 2 pinned", with the run's time and id
```

- **Notes:** The file count is taken before the digest file is written. The date in the name is the run's UTC date.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-099] A member who stored a provider token sees each digest run report only the token's rotation number
  Given a member stored a provider token in the example's vault and turned the digest job on
  When the member runs the digest job twice
  Then the first run's Last run reads "ok: Wrote digest-<date>.skexample; provider token rotation 1"
  And the second run's Last run ends in "; provider token rotation 2"
  And neither the Last run cell nor the digest file shows the token's value
```

- **Notes:** The example plays a provider that issues a new token on every use: each run appends `#1` to a typed token, or raises the number after `#`, and stores the new value before doing anything else.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-100] A member with no provider token stored sees the digest run say so and still write the file
  Given a member turned the digest job on and stored no provider token
  When the member runs the digest job
  Then the Last run reads "ok: Wrote digest-<date>.skexample; no provider token stored"
  And the digest file reads "Provider token: none stored"
```

```gherkin
@cloud
@intent:unclear
Scenario: [APP-DEV-101] A member who runs the digest job twice in one day gets a second digest file under the same name
  Given a member's digest job already wrote `digest-<date>.skexample` today
  When the member runs the digest job again on the same UTC day
  Then the Example files list shows two files named `digest-<date>.skexample`
```

- **Notes:** Each file's text carries its run's id, so the second file never matches the first one's content.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-102] A member whose digest run cannot read the vault sees the run fail with nothing written
  Given a member stored a provider token and turned the digest job on
  And the cloud fails the run's read of the member's vault
  When the member runs the digest job
  Then the Last run reads "failed: Reading the provider token failed: <reason>"
  And no new digest file appears, and the next successful run reports the rotation number that follows the last one reported
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-103] A member whose digest run fails after the rotation keeps the rotated token
  Given a member's last digest run reported "provider token rotation 3"
  And the platform refuses the run's write of the digest file
  When the member runs the digest job
  Then the Last run reads "failed: The data server answered <status>: <reason>"
  And the member's next successful run reports "provider token rotation 5", because the failed run stored rotation 4 before it failed
```

- **Notes:** The run stores the rotated token first, because a provider that rotates on every use expires the old token as soon as it answers. A failure to store it fails the run with "Storing the rotated provider token failed: <reason>".

## The example app's keywords job

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-104] A member whose keywords job runs sees each unread file labelled with up to three of its most frequent words
  Given a member turned the keywords job on
  And an earlier run read every other example file
  And the member created a file whose text is "Lanterns and harbors.", a line break, "The lanterns guide ships; the harbors shelter them.", a line break, and "Lanterns."
  When the member runs the keywords job
  Then the member sees the file labelled `example-app/keyword=lanterns`, `example-app/keyword=harbors`, `example-app/keyword=guide`, and `example-app/indexed`
  And the Last run reads "ok: Read 1 file; none left"
```

- **Notes:** The job runs in `read` mode, which reads everything and writes labels only. A file labelled again gets exactly its new keywords, never an addition to old ones.

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DEV-105] A member sees keywords picked by frequency, leaving out short and common words
  Given a member turned the keywords job on
  When the member creates a file whose text is "<text>" and runs the keywords job
  Then the member sees the file's keyword labels as <keywords>

  Examples:
    | text                                                           | keywords                         |
    | Flour and water. More flour, then water, then flour. Salt.     | "flour", "water", and "more"     |
    | The cat sat with THAT Kettle; the kettle hums.                 | "kettle" and "hums"              |
    | Don't panic. Crème brûlée, crème fraîche.                      | "crème", "don't", and "panic"    |
    | a b c 1234 the cat                                             | none, with the `indexed` flag    |
```

- **Notes:** A keyword is a word of four or more letters, in lowercase, that is not one of 27 common words such as "that" and "with". A tie goes to the word that appears first.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-106] A member sees a keywords run read at most 25 files, oldest first, and say that more remain
  Given a member turned the keywords job on and holds 30 example files that no run has read
  When the member runs the keywords job
  Then the member sees keyword labels and the `indexed` flag on the 25 oldest files only
  And the Last run reads "ok: Read 25 files; more remain for the next run"
  And the next run reads the remaining five and ends in "; none left"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-107] A member sees the keywords job read each file only once
  Given a member's keywords run already read every example file
  And the member then created one new file
  When the member runs the keywords job
  Then the Last run reads "ok: Read 1 file; none left"
  And the files read earlier keep their keyword labels unchanged
```

- **Notes:** The `indexed` flag marks a file as read, because a file may have no keywords.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-108] A member whose file is still uploading sees the keywords job label it on a later run
  Given a member turned the keywords job on, and an earlier run read every other example file
  And the member's computer is still uploading the bytes of one new example file to the cloud
  When the member runs the keywords job
  Then the Last run reads "ok: Read 0 files; 1 could not be read; none left"
  And the file gets no keyword labels and no `indexed` flag, and a run after the upload finishes labels it
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-109] A member whose file the cloud fails to fetch sees the file read on a later run
  Given a member turned the keywords job on, and an earlier run read every other example file
  And the member then created two new files
  And the cloud fails to fetch one file's text during the next run
  When the member runs the keywords job
  Then the Last run reads "ok: Read 1 file; 1 could not be read; none left"
  And the file that failed gets no `indexed` flag, and the member's next run reads it and labels it
```

```gherkin
@cloud
@intent:unclear
Scenario: [APP-DEV-110] A member whose file's bytes will never reach the cloud sees the file skipped without keywords, and newer files still read
  Given a member turned the keywords job on
  And one example file's bytes never reached the cloud and no device is uploading them, as after the only computer that held them was lost
  When the member runs the keywords job
  Then the Last run includes "1 has no bytes to read"
  And the file gets the `indexed` flag and no keywords, so later runs move on to newer files
```

- **Notes:** Implementation gap: the cloud names every file whose bytes it lacks as awaiting upload, because it cannot tell a lost computer from one that is offline, so each run counts such a file under "could not be read" and leaves it unflagged.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-111] A member whose keywords job finds no new files reads "ok: No new files"
  Given a member's keywords run already read every example file
  When the member runs the keywords job
  Then the Last run reads "ok: No new files"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-112] A member whose keywords run the platform refuses sees the platform's reason
  Given a member turned the keywords job on
  And the platform refuses the run's listing of the member's files
  When the member runs the keywords job
  Then the Last run reads "failed: The data server answered <status>: <reason>"
  And no file gains a keyword label or the `indexed` flag from that run
```

## The example app: Deleted, Types and Public links

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-113] A member sees the files deleted in the last day and restores one
  Given a member deleted "uploaded.skexample" within the last day
  When the member reads the Deleted files table, which starts from 24 hours ago, and clicks "Restore uploaded.skexample"
  Then the member first sees "uploaded.skexample" in the Deleted files table with the time it was deleted
  And after the restore the file is back in the Example files list and gone from the Deleted files table
```

- **Notes:** The member can type another instant in "Deleted since" and click "Reconcile". A file moved to the Trash by an outside client appears here too (APP-DEV-122). The platform rules are SHARED-112 and SHARED-116.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-114] A member sees how many days a deleted file stays restorable, or that this computer does not know
  Given a member opens the example app <where>
  When the member reads the Trash table under Deleted
  Then the member sees "Retention window" with the value "<value>"

  Examples:
    | where                                                              | value                     |
    | on a deployment that keeps the platform's default window            | 30 days                   |
    | on a computer that cannot read its deployment's trash settings      | unknown on this machine   |
```

- **Notes:** The platform rules are SHARED-114 and SHARED-115.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-115] A member sees record counts for every type the example may read
  Given a member created example files in the example app
  When the member reads the Types section
  Then the Types table lists `example/plaintext` with the number of example files under Records
  And the table lists no type the example may not read
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-116] A member on a computer without a cloud reads that public links need a cloud
  Given a member's computer is not signed in to a cloud
  When the member opens the example app
  Then the Public links section reads "Public links are unavailable here (HTTP <status>). They need a cloud."
```

- **Notes:** The platform rule is SHARED-201.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-117] A member shares a file, and the link opens signed out until the member revokes it
  Given a member's example app lists "paged-9.skexample" in the cloud
  When the member clicks "Share paged-9.skexample"
  Then the Public links table lists the file with a link `<the app's address>/public-shares/<token>/file/paged-9.skexample` and Expires "never"
  And the link opens the file's text in a browser that is not signed in
  And after "Revoke paged-9.skexample" the table reads "Nothing yet.", and within two minutes the link answers "Not found"
```

- **Notes:** The cloud's cache can serve a revoked link for up to a minute. The platform rules are SHARED-138 and SHARED-148.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DEV-118] A member on a computer signed in to a cloud sees each link under the cloud's address
  Given a member's computer is signed in to a cloud whose address is `https://cloud.example.test`
  And the member shared an example file from the computer
  When the member reads the Public links table on the computer
  Then the member sees the link as `https://cloud.example.test/public-shares/<token>/file/<name>`, never under the computer's own address
```

- **Notes:** The example reads the cloud's address from the computer's `config.json` on each request: `publicBaseUrl`, or else `apiGatewayUrl`, when it starts with `https://`.

Links: public-link rules (SHARED-138, SHARED-148, SHARED-201), deletes since an instant (SHARED-112), the trash window (SHARED-114, SHARED-115).

## The example app: Activity

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-119] A member sees every request the page made, newest first, up to 100
  Given a member opens the example app and clicks "Count files"
  When the member reads the Activity table
  Then the newest row shows the method GET, the path `/data/records?aggregate=…`, its status 200, and its time in milliseconds
  And the table keeps the 100 newest requests, with signed file addresses shown as "GET <signed file URL>" or "PUT <presigned upload URL>"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-120] A member sees a throttled request as a 503 followed by its retry
  Given a member's deployment is busy and answers one of the page's requests with a 503
  When the member reads the Activity table
  Then the member sees that request once with status 503, and above it the same request again with the retry's status
  And the action that sent it completes, and the status line reads "<what>: done."
```

- **Notes:** The page sends at most three requests at once, and retries a 503 or a 429 after about 0.3, 1, and 3 seconds, each varied by up to half. A request that could follow work already done is never retried. The in-flight limit under load is CLOUD-RUN-020.

Links: the page's in-flight limit under load (CLOUD-RUN-020).

## The example app's tools for outside clients

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-121] A member sees the example's tools listed in an outside client
  Given a member connected an outside client, such as an MCP client, to the example app's `/mcp` address
  When the member's client lists the app's tools
  Then the client shows the tools `list_files`, `read_file`, `tag_file`, `list_notes`, `write_note`, `delete_note`, `create_file`, and `trash_file`, each with a description
  And the client shows the server's instructions "Tools over the user's Starkeep example files: plaintext files with tags, and one private note per file."
```

- **Notes:** Locally a client on the same computer needs no token (ACCESS-165). In the cloud the client signs in through the platform's consent page (ACCESS-149, ACCESS-154).

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DEV-122] A member uses an outside client to list, read, tag and create files, write and delete notes, and move files to the Trash
  Given a member's outside client is connected to the example app with read and write access
  When the member asks the client to <ask>
  Then the client shows <answer>

  Examples:
    | ask                                                                   | answer                                                                                             |
    | create a file "from-mcp" with the text "Written by an MCP client."    | the new file "from-mcp.skexample" with no tags and counts of 1 line, 5 words, and 25 characters    |
    | read that file                                                        | "Written by an MCP client."                                                                        |
    | tag that file "mcp"                                                   | "Tagged.", and a later `list_files` with tag "mcp" lists only that file                            |
    | write the note "an MCP note" on that file                             | "Saved.", and a later `list_notes` includes "an MCP note"                                          |
    | delete that file's note                                               | "Deleted.", and a later `list_notes` no longer includes it                                         |
    | move that file to the Trash                                           | "Moved to the Trash.", and the example's Deleted files table lists "from-mcp.skexample"            |
```

- **Notes:** `list_files` lists the 50 newest files. `create_file` adds `.skexample` to a name that lacks it. A later `read_file` on a trashed file shows a tool error that starts "The data server answered 404".

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-123] A member sees only the example's own tags on a file through an outside client
  Given a member's example file carries the example's tag "mcp" and a label another app wrote
  When the member's outside client lists the files
  Then the client shows the file's tags as "mcp" only
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DEV-124] A member whose outside client has read access only cannot create files, write notes, or move files to the Trash
  Given a member connected an outside client to the example app in the cloud with read access only
  When the member asks the client to create a file, write a note, or move a file to the Trash
  Then the client shows a tool error that starts "The data server answered 403"
  And the member's files and notes are unchanged
```

- **Notes:** A read token still lists, reads, and tags files. Delegation modes are ACCESS-154 to ACCESS-163.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-125] An app developer whose MCP client leaves out an argument gets a tool error naming it
  Given an app developer connects an MCP client to the example app's `/mcp` address
  When the app developer's client calls `tag_file` with a file id and no tag
  Then the client receives the tool error `"tag" is required`
  And the file's tags are unchanged
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DEV-126] An app developer whose MCP client calls an unknown tool gets a protocol error naming it
  Given an app developer connects an MCP client to the example app's `/mcp` address
  When the app developer's client calls a tool named `no_such_tool`
  Then the client receives the protocol error -32602 with "Unknown tool: no_such_tool"
```

Links: tokens and discovery (ACCESS-140, ACCESS-141, ACCESS-149), the local client without a token (ACCESS-165), delegation modes (ACCESS-154 to ACCESS-163).
