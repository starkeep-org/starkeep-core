# TODO: `@starkeep/sdk` naming is misleading

The package `@starkeep/sdk` (`packages/sdk`, with `createStarkeepSdk`) is
**not** an app-development client library. It is the internal facade that
wires together storage-adapter, sync-engine, access-control,
query-orchestrator, etc.; the local-data-server instantiates it to do its
work. Calling it "SDK" implies it is the library third-party (or first-party)
local apps should reach for, which is the opposite of the truth — local apps
are always thin HTTP clients against the data-server, and embedding the engine
in-process bypasses `shared_app_registry`, the supervisor, and access-grant
enforcement.

Surfaced during processing of doc id 21 (Developing a local app for Starkeep —
Functional Review, 2026-06-08), Part 1 Open questions.

Possible resolutions to consider:

- Rename the package to something engine-flavored (e.g. `@starkeep/engine`,
  `@starkeep/core-runtime`, `@starkeep/data-engine`) — biggest blast radius
  but fixes the confusion at the source. Affects the `sdk` topic in the
  meta-doc index too.
- Keep the name but document prominently in the package README that this is
  an internal engine, not a client SDK, and direct app developers to the
  HTTP surface.
- Introduce a real `@starkeep/app-client` package (cross-references the
  "no platform-provided app client / SDK" item in doc 21 Part 2) and let
  that absorb the "SDK" mental model, leaving `@starkeep/sdk` for the engine.

Revisit when: either the app-client package is being designed (option 3
becomes natural at that point), or someone is otherwise touching the
`packages/sdk` exports.
