# Mobile flavor (reserved)

This folder is reserved for the example app's React Native flavor, `@example-app/mobile`. The flavor gets its own plan.

The structure already commits to three things:

- The flavor shares the app id `example-app` and the root `starkeep.manifest.json`. The manifest gains a `mobile.android` block for it.
- The Android identity is reserved: package `app.starkeep.example`, callback scheme `starkeep-example`.
- The flavor imports the data contract from `@example-app/common`, which holds no DOM or Node imports so that Metro can bundle it.

The platform syncs the app's notes and snapshots between the phone, the cloud and every computer with the example installed, on the app's own channel.
