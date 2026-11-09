# Desktop flavor (reserved)

This folder is reserved for a desktop flavor of the example app, such as an Electron app, `@example-app/desktop`. The flavor gets its own plan.

That plan decides one question: whether the desktop app talks to local-data-server the way the local web flavor does, or embeds a store and syncs the way the phone does.

Either way, the flavor shares the app id `example-app`, the root `starkeep.manifest.json` and the data contract in `@example-app/common`.
