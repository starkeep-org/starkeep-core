---
"@starkeep/protocol-primitives": minor
"@starkeep/admin-manifest": patch
---

Add `PROTOCOL_VERSION`, the version of the contract between the platform and an app, with `parseProtocolVersion` and `protocolSatisfies`. A minor bump marks an addition an app can depend on; a major bump marks a breaking change. `protocolMinVersion` in a manifest must now be a `major.minor.patch` version.
