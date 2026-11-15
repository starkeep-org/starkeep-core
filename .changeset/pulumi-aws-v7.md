---
"@starkeep/admin-installer": minor
---

The installer deploys with `@pulumi/aws` 7. The 6.x provider has no Node 24 Lambda runtime. The first cloud update after this release downloads the 7.x AWS provider plugin and upgrades each stack's provider in place. The S3 resources keep their `*V2` types, so no bucket changes identity.
