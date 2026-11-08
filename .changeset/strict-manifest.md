---
"@starkeep/admin-manifest": minor
---

`validateManifest` rejects any key the schema does not declare, at every level, and suggests a declared key when the spelling is close (`unknown key "localrun" (did you mean "localRun"?)`). The schema now declares `description`, which admin-web shows on app cards.
