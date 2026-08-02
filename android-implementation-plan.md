# Phase 2 — the Android app

Companion to `media-implementation-plan.md` §Phase 2 (items 10–16). This is the working plan for
that phase; the media plan remains authoritative for *what* is being built and why.

Item 10 (narrowing `getRawDatabase()` to an interface) is **done**. Everything below is open.

---

## 1. What was verified before designing against it

Three assumptions underpinned Phase 2 and all three were checked against current package APIs rather
than assumed. Two held; one held with a caveat that changes the adapter's shape.

### op-sqlite can satisfy `RawDatabase` — but not through prepared statements

```ts
executeSync: (query: string, params?: Scalar[]) => QueryResult   // synchronous, parameterised
prepareStatement: (query: string) => PreparedStatement
PreparedStatement = { bind, bindSync, execute: () => Promise<QueryResult> }  // execute is async only
```

`executeSync` is genuinely synchronous *and* takes bind parameters, so the synchronous constraint
`RawDatabase` imposes is satisfiable. But `PreparedStatement.execute()` is **async only**, so
`prepare(sql)` cannot map onto a real prepared statement. The adapter implements `prepare` by
capturing the SQL string and calling `executeSync(sql, params)` at `run`/`get`/`all` time.

**What that costs:** no statement reuse, so SQLite re-parses per call. That is a performance
property, not a correctness one — parameters are still bound rather than interpolated, so nothing
about injection or type handling changes. Worth measuring on a 60k-row library before deciding it
matters; worth *not* pre-optimising into an async interface, because async is the thing the
change-log write ordering cannot tolerate (see `raw-database.ts`).

**The synchronous requirement is the real risk of this phase.** `executeSync` blocks the JS thread.
On a laptop that is invisible; on a phone, a sync round that walks thousands of rows synchronously is
a dropped-frames problem. The mitigation is that sync work happens in a background task rather than
during interaction — which the constrained-execution model below already requires for other reasons.

### expo-file-system can satisfy `ObjectStorageAdapter`

`expo-file-system` 57's class-based API provides exactly the shapes the adapter needs:

| Adapter needs | expo-file-system |
|---|---|
| `getStream(key)` | `File.readableStream(): ReadableStream<Uint8Array>` |
| `getStream(key, range)` | `File.open(mode)` → `FileHandle` with `offset` + `readBytes(length)` |
| `putStream(key, body)` | `File.writableStream(): WritableStream<Uint8Array>` |
| `stat(key)` | `File.size`, `File.exists` |

This retroactively vindicates the item 2 decision to type the adapter in **web** `ReadableStream`
rather than Node streams, on the argument that "the same adapter interface has to be implementable on
React Native". It is, without a shim.

### The toolchain is present

Android SDK, `adb`, emulator and JDK 17 are all installed. Maestro is not yet. So this phase can be
built, typechecked, unit-tested and — unlike everything before it — actually run.

---

## 2. Where the app lives, and why

`starkeep-apps/photos-mobile`. **Revised 2026-08-02 — it was `starkeep-core/apps/mobile`.**

The original argument was that the phone is a platform node that happens to carry a UI, not an app
consuming the platform through the SDK: it embeds the sync engine, owns a local database and object
store, and makes its own residency decisions — the same list that puts `local-data-server` in
`starkeep-core/apps`. That description is still accurate. It just does not decide where the code
belongs.

What decides it is that living inside core's workspace let the app reach into internals nothing
forced it to respect. `getRawDatabase()` returning `node:sqlite`'s concrete `DatabaseSync` was
exactly that, and it sat there as item 10 precisely because no consumer ever felt it. From
`starkeep-apps`, against published packages, every such reach is a compile error instead of a
judgement call. The layout is what enforces the seam, so the app is on the far side of it.

The consequence to be honest about: on iOS a phone cannot run a node as a separate process for other
apps to connect to — there is exactly one foreground app, so a client and a server that must both be
running cannot both be running. The node is therefore linked into the app as a library, and
`createMobileNode` moves with the app. That is a fusion of node and viewer in one binary, and it is
deliberate rather than incidental. If a second Starkeep app ever lands on a handset, the iOS-viable
answer is a shared container — both apps mapping the same database and object store, each linking
the engine — not a local client/server.

**What must not follow the app across.** The engine itself. `@starkeep/sync-engine` and
`@starkeep/protocol-primitives` are consumed as published packages and are never copied or forked
for mobile. `src/node.ts` says why: a second implementation "for mobile" is how two nodes come to
disagree about what they hold, and that failure is silent rather than loud.

**`photos-ui` is not reused.** The media plan says so and it is right: it is React DOM with inline
CSS strings, and React Native has neither. The *logic* in `photos-lib` — the ladder, variant
selection, the import loop — is platform-free and is reused.

---

## 3. The four constraints everything is built to

From the media plan, and non-negotiable because they are iOS's constraints applied to Android
deliberately, so the second platform is a port rather than a rewrite:

1. **No sync round may be assumed to complete.** Every exchange is resumable from its watermark.
2. **No work item may assume more than a few seconds.** Derivation is per-record, not per-library.
3. **Byte transfer is delegated to an OS-managed mechanism that survives app death.**
4. **Nothing is scheduled that depends on the app being open.**

Consequence worth stating up front: there is **no foreground service** and no persistent background
execution. A phone that is asked to sync 60k records does it across many short windows over days,
not in one run. Anything that quietly assumes otherwise is a bug even if it works on a dev handset
plugged into a laptop.

---

## 4. Order of work

| # | Item | State |
|---|---|---|
| 11a | `RawDatabase` + `DatabaseAdapter` over op-sqlite | **Done** — and the real `SqliteDatabaseAdapter` runs through it unchanged |
| 11b | `ObjectStorageAdapter` over expo-file-system | **Done** — ranged reads verified by sabotage |
| 12 | Sync peer + residency | **Done** — a real exchange runs on the phone's adapters; a real budget elides |
| 16 | Motion Photo XMP extraction | **Done** (parser) — capture path needs a device |
| 14 | `WorkManager` job graph | **Policy done**; the binding needs a device |
| 12b | Expo dev-client shell + optional Cognito sign-in | **Done** — bundles, opens without an account, signs in for sync, keeps the session across restarts; unrun on hardware |
| 13a | `MediaStore` — reading the device's own camera roll | **Done via `expo-media-library`** — no hand-written module needed; unrun on hardware |
| 13b | `ImageDecoder` / `MediaCodec` — decode and derivation | Open — needs a device, and native code `expo-media-library` does not cover |
| 15a | Grid + viewer against the existing ladder logic | Open — a recent-media grid exists; the *library* grid needs the import loop and the `photos-lib` split |
| 15b | Residency inspector + retention matrix | Open — reuses the census/projection work |

Deliberately **not** in the order the media plan lists them. Items 13 and 14 are the ones that cannot
be verified without a handset, so they come after the shell exists to host them — building native
modules against a shell that does not yet run is how you accumulate code nobody has executed.

**Item 13 moved ahead of 15a** once the shell stopped gating on sign-in — it was the only thing
between this app and being useful with no account and no network. It then **split in two**, which is
the more useful shape: reading the media store is a solved problem that `expo-media-library` covers
(its SDK 57 `Query` API returns metadata cheaply and resolves URIs per asset), while decode and
derivation genuinely do need native code. Only the second half is a module anyone has to write.

The app now shows the device's recent photos and videos with no account, no cloud and no network —
just the OS permission, which is the whole of the access control for media the user already has.

---

## 5. Testing

**Unit tests** for anything platform-free: adapters against fake drivers, the Motion Photo parser,
any selection logic. These run in the existing vitest setup.

**Maestro** for e2e, once there is a UI to drive (item 15a). Flows live in
`starkeep-apps/photos-mobile/.maestro/`.

What Maestro is for here, specifically — the things unit tests structurally cannot reach:

- **A record whose bytes are elided renders a placeholder and fetches on demand.** `Elided` is the
  state the phone exists to validate, and it has never been exercised against a real budget.
- **A sync interrupted mid-round resumes without duplicating or losing records.** Constraint 1, which
  is untestable anywhere the process cannot actually be killed.
- **The grid stays responsive while a sync round runs.** The `executeSync` risk above, measured
  rather than argued about.
- **Auth survives an app restart.**

Maestro is not yet installed; that is a prerequisite for item 15a, not for the adapters.

**What cannot be tested here at all:** anything depending on Doze, on real background scheduling
windows, or on the OS killing the app. An emulator will not reproduce a phone's scheduler. Those
remain honest gaps until this runs on hardware.

---

## 5b. What is true so far

Six of the nine items are done and 144 tests cover them, all running in Node
against fakes. Six findings worth carrying forward:

- **`SqliteDatabaseAdapter.init()` called Node's `mkdirSync` unconditionally.**
  A phone has no Node filesystem. Moved into the driver, where "how a connection
  comes into being" already lived. Invisible until something that is not Node
  tried to open a database — which is what the seam was built to surface.
- **The residency manager was in `apps/local-data-server` and was always
  portable** — no Node imports at all. Moved into the sync engine rather than
  copied, because a second copy of "which bytes may this node hold" is how two
  nodes come to disagree about what they have.

- **Cognito is reached over `fetch`, not the AWS SDK.** `InitiateAuth`,
  `RespondToAuthChallenge` and the refresh are unsigned JSON posts, so the SDK
  would be carried for its request builder alone — a megabyte and a polyfill
  hunt into a React Native bundle. The wire format lives in
  `src/auth/cognito.ts` and is asserted against a fake `fetch`, and the same
  request shape was checked against the live pool.
- **There is no sign-in gate, and there must not be one.** The app opens into
  the node; signing in is an action taken from inside it. The photos and videos
  on a handset are the user's, they are already there, and Android's permission
  is *the* access control for them — a Cognito login in front of them would be
  a second, weaker gate in front of a door the user already holds the key to,
  and one that fails shut when the network does. Sign-in buys exactly one
  thing: **sync**. A device with no session is a complete Starkeep node that
  happens to be the only one that knows what it holds.

  This was got wrong twice, in the same direction both times, which is worth
  recording because the pull is clearly strong. First the whole app sat behind
  a login. Then, with the login still in place, the session *refresh* sat in a
  `try`/`catch` whose `catch` cleared the stored token — so one launch without
  a connection signed the device out permanently, a revoked credential and a
  tunnel being the same event from inside a `catch`.

  What the shape now guarantees: nothing awaits the network before a screen is
  chosen, the session is a file read, and the refresh can only promote a
  session to live or — on a 4xx from the pool and nothing else — end it. The
  policy is in `src/auth/session-manager.ts` as three cases over a fake client,
  and `CognitoError` carries an HTTP status precisely so the two can be told
  apart. Sabotaging the 4xx test to clear unconditionally fails four tests.

- **The camera roll needed no native module.** `expo-media-library` 57 exposes
  a query builder whose `exeForMetadata()` returns everything the grid needs
  except the URI — and on Android an asset id *is* its `content://` URI, so the
  per-asset resolve is a fallback rather than the path. Declared structurally in
  `src/media/device-library.ts` like every other adapter here, so the sort
  order, the field mapping and the permission states are Node tests. What still
  needs hardware: whether a `content://` URI renders in an `Image`.

- **The phone cannot reach the cloud data plane at all yet.** Every
  `/apps/{appId}/*` route is HMAC-signed with a per-app secret held in SSM, and
  nothing yet gives a handset one. So the shell signs in and stops there; the
  home screen says so rather than showing an empty library, which is what an
  unauthorised node and a synced-but-empty one would otherwise look like.
  **This is the blocker for item 15a**, ahead of the `photos-lib` split.

**The phase's stated purpose is now demonstrated in principle**: a node with a
budget smaller than its library keeps every record and declines some bytes,
asserted in both directions so that neither "ignores the budget" nor "declines
everything" passes. What remains untested is that this holds on hardware, with a
real 60k-item library and a real 8 GB budget.

## 6. Recorded risks

- **`executeSync` blocks the JS thread.** The likeliest source of a janky-feeling app, and the
  reason sync must never run during interaction.
- **`prepare()` does not really prepare.** Re-parsing per call on a 60k-row library may or may not
  matter; measure before caring.
- **No foreground service means sync is slow by construction.** This is a design choice, not a
  defect, and the UI has to say so or it reads as broken.
- **`photos-lib` may not be as platform-free as assumed.** It is written for Node — `node:crypto`,
  `node:fs`, `sharp`. The ladder arithmetic and variant selection are pure, but the import loop and
  derivation are not. Expect to split it before item 15a rather than during.
