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

`starkeep-core/apps/mobile`.

The phone is a **platform node** that happens to carry a UI, not an app consuming the platform
through the SDK. It embeds the sync engine, owns a local database and object store, and makes its own
residency decisions — the same list that puts `local-data-server` in `starkeep-core/apps`.
`starkeep-apps` is for things that talk to a node over the data plane; the phone *is* one.

The awkwardness is real and worth naming: item 15 puts a photo grid in it, which is Photos' concern,
and `starkeep-apps/photos` is where that lives on the desktop. On a phone there is one binary, so the
node and its viewer are the same process. If that fusion later proves wrong, the UI moves and the
node stays — which is the cheaper direction, and the reason the node goes in `core` rather than the
UI going in `apps`.

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
| 12b | Expo dev-client shell + Cognito auth | Open — needs the RN toolchain installed |
| 15a | Grid + viewer against the existing ladder logic | Open — needs the shell |
| 15b | Residency inspector + retention matrix | Open — reuses the census/projection work |
| 13 | Native modules — `MediaStore`, `ImageDecoder`, `MediaCodec` | Open — needs a device |

Deliberately **not** in the order the media plan lists them. Items 13 and 14 are the ones that cannot
be verified without a handset, so they come after the shell exists to host them — building native
modules against a shell that does not yet run is how you accumulate code nobody has executed.

---

## 5. Testing

**Unit tests** for anything platform-free: adapters against fake drivers, the Motion Photo parser,
any selection logic. These run in the existing vitest setup.

**Maestro** for e2e, once there is a UI to drive (item 15a). Flows live in `apps/mobile/.maestro/`.

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

Four of the eight items are done and 99 tests cover them, all running in Node
against fakes. Two findings worth carrying forward:

- **`SqliteDatabaseAdapter.init()` called Node's `mkdirSync` unconditionally.**
  A phone has no Node filesystem. Moved into the driver, where "how a connection
  comes into being" already lived. Invisible until something that is not Node
  tried to open a database — which is what the seam was built to surface.
- **The residency manager was in `apps/local-data-server` and was always
  portable** — no Node imports at all. Moved into the sync engine rather than
  copied, because a second copy of "which bytes may this node hold" is how two
  nodes come to disagree about what they have.

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
