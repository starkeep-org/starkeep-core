# @starkeep/admin-manifest

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
