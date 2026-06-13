# TODO: PATCH /config restart respawns without the tsx loader

`restartProcess()` in `apps/local-data-server/server.ts` (the PATCH /config
path) respawns the server with `process.execPath` + `process.argv.slice(1)`.
Under tsx, `process.execPath` is plain `node` and the argv slice does not
carry the `--import tsx` loader flags, so the replacement process crashes
with `ERR_MODULE_NOT_FOUND` on the repo's `.js`-suffixed TypeScript imports.
The restart "works" only in a hypothetical compiled deployment; in every
environment the server actually runs in today (tsx via `pnpm start` /
admin-web daemon spawn), PATCH /config kills the server and the replacement
dies immediately.

Options: re-exec via the original argv0 chain (`process.argv[0]` +
execArgv), spawn through the package's own `start` script, or drop
self-restart entirely and let the supervisor/operator restart (admin-web
already knows how to start the daemon).

Surfaced while writing the Tier-1 config-lifecycle test (2026-06-11/12
session): the test pins exit+persist only ("assert exit, not survival" per
the test plan, doc 43) precisely because survival is currently broken.
The pinned test should be tightened to assert successful respawn when this
is fixed.

Revisit when: anyone touches server lifecycle / config handling, or a user
reports the local server disappearing after a settings change.
