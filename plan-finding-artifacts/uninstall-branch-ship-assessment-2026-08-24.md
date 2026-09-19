# Ship assessment: `uninstall-data-destruction-warnings`

Date: 2026-08-24. Branch: `uninstall-data-destruction-warnings`, now rebased onto
`origin/main` (`f61d1a7`) and sitting one commit ahead as `e8bd147`.

## What I did to the branch

The branch was one commit ahead of `origin/main` and eight behind. Because both
starkeep repos are configured rebase-only, I integrated main by rebasing rather
than by creating a merge commit; with a single commit on the branch the result is
identical in content and keeps the history linear. The rebase applied cleanly
with no conflicts, and the branch has not been pushed, so `origin` still points
at the pre-rebase commit and the update will need a force-push.

## Verification after the rebase

| Check | Result |
| --- | --- |
| `apps/local-data-server` `__tests__/admin-apps.test.ts` | 12 passed, including the 4 new preview cases |
| `apps/admin-web` `__tests__/apps-uninstall.test.ts` | 4 passed, including the 2 new preview cases |
| `pnpm typecheck` (workspace) | fails in `@starkeep/sync-engine` |
| `eslint` on the changed files | clean |

The typecheck failure is not this branch's. It is three errors in
`packages/sync-engine/__tests__/eviction.test.ts:34` and
`packages/sync-engine/__tests__/residency-exchange.test.ts:349,409`, all about
`heldEver` and `original_filename` optionality. This branch touches eight files
and none of them is in `packages/sync-engine`, so the errors arrived with one of
the eight commits pulled in from main. They are worth fixing before anything
merges, but they are a `main` problem, not a branch problem.

## What the branch actually delivers

The design note `uninstall-data-destruction-2026-08-22.md` proposed four items.
The branch implements one and a half of them.

- **Item 1, rewrite the local confirmation: done, and done well.** The
  `window.confirm()` is replaced by a dialog backed by a new
  `GET /admin/apps/:appId/uninstall-preview` endpoint that reports live row
  counts and up to three real sample values per table, plus file count and total
  bytes. The decisions in `uninstall-preview.ts` are the right ones and each is
  explained where it is made: tombstoned rows are excluded so the warning is not
  inflated against data the user already discarded, a table missing from the
  database reports zero rather than failing the whole preview, samples skip the
  primary key and the HLC columns so the operator sees a caption rather than a
  ULID, and file samples are ordered largest-first. The preview failing is
  surfaced as an alert rather than being swallowed into an empty "nothing will be
  lost", which was the specific failure mode worth guarding against.
- **Item 2, typed confirmation: implemented, but not as specified.** The note
  asked for typed confirmation only when the preflight finds data, so that "an
  app with nothing to lose should stay a one-click uninstall so the common case
  does not get noisier." The branch requires the operator to type
  `uninstall <appId>` unconditionally, including for an app the dialog has just
  reported as holding nothing. This is a deliberate-looking deviation but it is
  not called out in the commit message, and it makes the empty case strictly more
  annoying than before. Either honor the note or say why it was overruled.
- **Item 3, the cloud CLI destructive gate: not done.** The commit message is
  honest about this. It is also the item the note itself called "the most
  valuable of them, since that is the irreversible path."
- **Item 4, correct the three docstrings: not done.** This is the cheap one.

## The finding that should gate the merge

The new preview endpoint returns the user's own record content — caption text,
note bodies, original filenames — from a route in `LOOPBACK_AUTHORIZED_PATTERNS`,
which is matched by `/^\/admin(\/|$)/` in `apps/local-data-server/server.ts:917`.
That set has an explicit stated principle, recorded in
`meta-docs/docs/functional-doc-local-data-server-2026-06-01.md:181`: skipping
HMAC is justified "only when those routes carry no per-app user data."

That principle was enforced, not merely written down. On 2026-06-01 the `/browse`
route was deleted outright and the `/events` SSE payload was reduced to a
payload-less kick, both for exactly this reason: they exposed record-level user
data to any loopback caller. This branch reintroduces the same category of
disclosure on the same route set, and does so without acknowledging the
precedent. `/browse` returned filenames and sizes; `uninstall-preview` returns
the text the user typed.

The exposure is wider than "any process on the machine", because
`apps/local-data-server/server.ts:885` sets `Access-Control-Allow-Origin: *`
unconditionally, before any authorization runs, and nothing anywhere in the file
inspects `Origin`, `Referer`, or `Sec-Fetch-Site`. A plain cross-origin `GET` to
`http://127.0.0.1:9820/admin/apps/photos/uninstall-preview` therefore returns a
readable body to script on any page the operator has open. The app id is
guessable and the port is a constant.

One honest mitigation: Chrome's Private Network Access rules block a public page
from making subresource requests to loopback unless the server opts in via a
preflight, and this server does not send `Access-Control-Allow-Private-Network`.
So in current Chrome this is blocked. It is not blocked by anything in this
codebase, it is not blocked uniformly across browsers and versions, and it is not
what the loopback bind is documented as relying on.

## Reachability pass

Per `CLAUDE.md`, this branch touches a privileged operation, so the table is the
deliverable.

| Capability | Where it lives | Least-authenticated reachable caller |
| --- | --- | --- |
| Reads and returns the user's app-specific record content and filenames | `apps/local-data-server/uninstall-preview.ts`, served at `GET /admin/apps/:appId/uninstall-preview` | any web page the operator has open, via `ACAO: *` with no `Origin` check (browser PNA permitting); otherwise any process on the machine |
| Same, proxied | `apps/admin-web/app/api/apps/[appId]/uninstall-preview/route.ts` | any process on the machine that can reach the admin-web port |
| Drops the app's syncable tables and `rm -rf`s its syncable filespace, and syncs the teardown to peers | `DELETE /admin/apps/:appId` on the local-data-server | any web page the operator has open — `OPTIONS` is answered `204` with `Access-Control-Allow-Methods` including `DELETE` and `ACAO: *`, so the preflight passes (browser PNA permitting) |
| `DROP SCHEMA app_<appId> CASCADE` plus wipe of the app's S3 prefix | `packages/admin-installer/src/dsql-ddl.ts:474`, `orchestrator.ts:444` | anyone who can run the CLI with valid admin AWS credentials, with no destructive confirmation and none at all under `--non-interactive` |

Rows three and four are pre-existing and are not this branch's doing. Row three
is worth writing down anyway, because it is the destructive counterpart of the
route this branch adds and it is the reason the new read is more than an
information leak: the same caller that can enumerate what an app holds can also
destroy it. Row four is the note's deferred item 3.

## Answering the note's open question about item 3

The note ended by saying it had not checked whether anything calls
`cli:uninstall-app --non-interactive`. Something does.
`e2e-aws/src/installers.ts:64` appends `--non-interactive` to every install-CLI
invocation unconditionally, and `e2e-aws/src/journey.test.ts:1291` uninstalls
`photos` through it. So item 3's proposed `--delete-cloud-data` opt-in would
require updating that call site as part of the same change.

## Recommendation

The work that is here is good and I would not ask for it to be redone. The
question is only what has to accompany it.

Blocking, in my view:

- Decide the loopback disclosure question before merge. The cheapest resolution
  that keeps the feature intact is to drop `Access-Control-Allow-Origin: *` for
  the `/admin/*` routes, or to require a non-simple header on them so that no
  cross-origin `GET` succeeds without a preflight the server declines. That also
  closes the pre-existing cross-origin `DELETE`, which is the more serious of the
  two. If the decision instead is that samples are acceptable on this surface,
  that is defensible but it needs to be written into
  `functional-doc-local-data-server-2026-06-01.md`, because it weakens a
  principle that document currently states without exception.

Not blocking, but I would do them now:

- Item 4, the three docstrings. It is a few minutes and it is the same defect the
  branch exists to fix, just in prose.
- Reconcile the unconditional typed confirmation with item 2, in the code or in
  the commit message.
- Register items 3 and 4 as todos. Right now they survive only as prose in a
  committed design note, which is not a tracked surface.

Independent of this branch: fix the three `@starkeep/sync-engine` typecheck
errors on `main`.

---

## Addendum, 2026-08-24: the dialog copy is factually wrong

The `DialogDescription` claims the deletion "syncs to every other node, so there
is no copy left to restore from." It does not, and there is. `DROP TABLE` writes
no tombstone, the namespace is deregistered so the tables stop being a sync scope,
and the per-app channel is torn down before anything could ship. A local uninstall
destroys data at that location only.

This supersedes the recommendation above: the branch should not ship as written,
independent of the loopback question. Full trace and the suggested replacement
copy in `uninstall-sync-propagation-check-2026-08-24.md`.
