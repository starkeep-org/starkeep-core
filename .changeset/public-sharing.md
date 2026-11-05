---
"@starkeep/admin-manifest": minor
---

`infraRequirements.publicSharing` declares that an app may publish records to public links. It defaults to `false`, and the validator refuses it for an app whose `targets` omit `"cloud"`, because the cloud serves public links. The person approves the capability at install.
