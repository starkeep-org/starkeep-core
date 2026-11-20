# @starkeep/admin-manifest

## 0.12.0

### Minor Changes

- 1a883ca: Scheduled jobs. A manifest may declare `infraRequirements.jobs`, up to eight jobs of `{ name, handler, mode, defaultTime, description }`, which the platform runs in the cloud once per user who turns each one on. An app with jobs needs `protocolMinVersion` `1.1.0`, compute and the `cloud` target, and `PROTOCOL_VERSION` is now `1.1.0`. `@starkeep/app-client` adds `verifyJob` and `jobRefusal` for the job route at `/_starkeep/jobs/<name>`, and `listJobs`, `runJobNow` and `jobConsentUrl` for the app's server. `verifyDelegation` now refuses any token that is not on the `app` channel, so a job's token never opens a route meant for outside clients. `verifyDelegationToken` returns the token's `channel` and, for a job token, its `job`. `@starkeep/protocol-primitives` adds the `job` delegation channel, the `sk_job` and `sk_run` claims, and the job routes and constants.

### Patch Changes

- Updated dependencies [1a883ca]
  - @starkeep/protocol-primitives@0.13.0

## 0.11.0

### Minor Changes

- 00a78b5: The app row query gains a `join` parameter, column operands (`{"eq":{"col":"<table>.<column>"}}`), `exists` and `not_exists` subqueries, `in` and `not_in` with a subquery, an explicit `eq` and a literal `not_in`. Joined columns come back under qualified keys such as `"tasks.title"`, and a query with `join` must name its columns in `select`. `order` gains a JSON spelling, `[{"col":"tasks.due","dir":"desc","nulls":"first"}]`, which can name a joined column. The flat spelling, `due.desc`, still parses for columns of the queried table, but it is deprecated: both data servers answer it with a `Deprecation` header and log one line per app. `flatOrderDeprecation` and `isFlatOrder` are new exports of `@starkeep/shared-space-api`. The manifest validator refuses the column names `exists` and `not_exists`, two tables with one name, and two columns with one name in one table. `parseQuery` takes an optional `{ tables }` argument that enables the multi-table forms; without it, they are refused.

## 0.10.1

### Patch Changes

- Updated dependencies [4838b92]
  - @starkeep/protocol-primitives@0.12.0

## 0.10.0

### Minor Changes

- 380bb3f: Outside clients, such as MCP clients and scripts, can reach one app's data with a delegation token the user creates on the platform's consent page. A manifest route declares `"auth": "delegated"` for such a client, and `verifyDelegation(req)` in `@starkeep/app-client` tells the route whose request it is. Pass the returned token to `signedFetch` (`delegation`) or `proxyToDataServer` (`delegationToken`) so the platform applies the token's mode and revocation to each data call. On the local surface a loopback caller passes with no token.

  The manifest validator refuses `auth: "public"` on a handler or a route, and accepts a `publicPaths` entry only when it is a platform page or one of the handler's `staticAssetPaths`. A manifest that used either must move the route to `"delegated"` or drop it.

- 170d2f7: A manifest handler's `runtime` now accepts only `"nodejs24.x"` and defaults to it, because Starkeep's cloud Lambdas run on Node 24. A manifest that names `"nodejs22.x"` now fails validation.
- 5ec8f08: Refuse a manifest with a `session` handler when no handler lists `/sign-in` in `publicPaths`. The platform sends every signed-out visitor to `/sign-in`, so such an app strands them on a page the gateway refuses. `SIGN_IN_PATH` is exported for the installer's post-install probe, which now also warns when the deployed page answers with an error status.

### Patch Changes

- Updated dependencies [380bb3f]
- Updated dependencies [1460d5c]
  - @starkeep/protocol-primitives@0.11.0

## 0.9.0

### Minor Changes

- 26ed6d3: In the cloud, CloudFront now serves each web app's `/_immutable/*` and `/_static/*` files from S3, so no request for them reaches the app's Lambda. The change is breaking for cloud deployments and for web apps.
  - A compute handler takes a new `bundleAssetsDir` field: the directory inside `dist.zip` that holds the build output. The installer copies the files under `<bundleAssetsDir>/_immutable/` and `<bundleAssetsDir>/_static/` that `staticAssetPaths` declares into the bootstrap stack's new app assets bucket.
  - `validateManifest` refuses a handler that declares `staticAssetPaths` without a `bundleAssetsDir`, so the installer can copy the S3-served files and check the size of every file the Lambda serves. Add the field and reinstall the app.
  - The installer refuses a bundle whose Lambda would serve a static file over 4 MB, which a Lambda response cannot carry, and names the file.
  - `@starkeep/app-client/web` exports `IMMUTABLE_CACHE_CONTROL` and `REVALIDATE_CACHE_CONTROL`, the headers both surfaces send for the two prefixes.

- f635451: The manifest gains two optional fields, `installDependencies` and `bundle`, each `{ command, args, cwd }`. admin-web runs `installDependencies` in the app's folder at Install, and the cloud installer runs `bundle` to build the cloud bundle. Each must match the installer's approved command list. Omitted, the installer infers the command from the app's lockfile.
- d5f0ae7: `validateManifest` rejects any key the schema does not declare, at every level, and suggests a declared key when the spelling is close (`unknown key "localrun" (did you mean "localRun"?)`). The schema now declares `description`, which admin-web shows on app cards.

### Patch Changes

- a3a8ca5: Add `PROTOCOL_VERSION`, the version of the contract between the platform and an app, with `parseProtocolVersion` and `protocolSatisfies`. A minor bump marks an addition an app can depend on; a major bump marks a breaking change. `protocolMinVersion` in a manifest must now be a `major.minor.patch` version.
- 51a404f: The `localRun.portFlag` documentation says that admin-web keeps an app on one port, so the app keeps one browser origin across restarts. The port changes only when the app is reinstalled or the operator moves it off a port that another program holds.
- Updated dependencies [a3a8ca5]
  - @starkeep/protocol-primitives@0.10.0

## 0.8.1

### Patch Changes

- Updated dependencies [8dbd1c4]
  - @starkeep/protocol-primitives@0.9.0

## 0.8.0

### Minor Changes

- 5e8767b: `infraRequirements.publicSharing` declares that an app may publish records to public links. It defaults to `false`, and the validator refuses it for an app whose `targets` omit `"cloud"`, because the cloud serves public links. The person approves the capability at install.

### Patch Changes

- Updated dependencies [39e3d86]
  - @starkeep/protocol-primitives@0.8.0

## 0.7.0

### Minor Changes

- 18b7a5f: A manifest can declare its mobile builds. `mobile.android` names the package, its signing-certificate SHA-256 digests and the sign-in callback scheme, and validation checks each. `mobileSchema`, `androidIdentitySchema`, `MobileBuilds` and `AndroidIdentity` are exported.

### Patch Changes

- Updated dependencies [18b7a5f]
  - @starkeep/protocol-primitives@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [fcd80e9]
  - @starkeep/protocol-primitives@0.6.0

## 0.6.0

### Minor Changes

- Column types, declared indexes and stand-in categories in the manifest schema.

### Patch Changes

- Updated dependencies
  - @starkeep/protocol-primitives@0.5.0
