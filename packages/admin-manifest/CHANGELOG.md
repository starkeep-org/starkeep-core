# @starkeep/admin-manifest

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
