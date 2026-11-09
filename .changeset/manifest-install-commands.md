---
"@starkeep/admin-manifest": minor
---

The manifest gains two optional fields, `installDependencies` and `bundle`, each `{ command, args, cwd }`. admin-web runs `installDependencies` in the app's folder at Install, and the cloud installer runs `bundle` to build the cloud bundle. Each must match the installer's approved command list. Omitted, the installer infers the command from the app's lockfile.
