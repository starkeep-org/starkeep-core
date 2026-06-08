# Systematic test coverage across the codebase

Test coverage is uneven and partly absent. Audit and fill gaps **topic-first, package-second**, using the meta-doc topic list as the primary axis.

## State today

Test-file counts in `packages/*`:

| Package | Test files |
|---|---|
| sync-engine | 13 |
| protocol-primitives | 5 |
| storage-adapter | 2 |
| access-control, iam-permission-tests, query-orchestrator, sdk, shared-space-api, storage-fs, storage-s3, storage-sqlite | 1 each |
| **admin-installer, admin-manifest, app-client, aws-bootstrap, storage-aurora-dsql** | **0** |

Real depth exists only in `sync-engine` and `protocol-primitives`. The five zero-test packages additionally fail `pnpm test` outright (vitest exits 1 on "No test files found") — the CI signal isn't merely thin for them, it's red.

`apps/local-data-server` and the photos app under `starkeep-apps` are not in the table above; both also need their own pass.

## Approach: topic-first, package-second

Audit by top-level meta-doc topic (`shared-data`, `data-sync`, `cloud-data-server`, `local-data-server`, `app-specific-data`, `drive`, `cloud-overview-and-bootstrap`, etc.), not by package. For each topic:

1. **Enumerate load-bearing behaviors** that need test coverage. The functional docs already registered under most topics are the right starting point — they describe what the topic *does*.
2. **Identify the modules implementing each behavior.** Use the meta-doc module assignments where they exist; fall back to grep.
3. **Audit what tests exist for that behavior, regardless of which package they live in.** Cross-cutting behaviors (residency derivation, watermark advancement, type-confinement at the cloud broker, Drive single-channel custody) are routinely tested only on one side of their boundary; topic-first surfaces this.
4. **Author tests, prioritizing by surface area × risk.** Early candidates from the zero-test list:
   - `storage-aurora-dsql` query builder (correctness of generated SQL against the actual `shared.records` schema).
   - `aws-bootstrap` CFN template generation (the four install-time roles' trust policies, the five permissions boundaries, the Manager allow-list — already tracked in [[todo-cloud-overview-and-bootstrap-aws-bootstrap-tests]]).
   - `admin-installer` orchestrator step-skip/resume semantics and DSQL DDL.
   - `app-client` wire-format / signing.
   - `admin-manifest` schema validation.

## Policy

Keep `passWithNoTests` strict (vitest exits 1 on no tests) so per-package gaps remain visible while the audit is in progress. Don't silence the signal that surfaced this todo in the first place.

For new packages going forward, the minimum bar is "tests exist and the test command succeeds" — not a percentage target.

## Connections

- [[todo-cloud-overview-and-bootstrap-aws-bootstrap-tests]] (doc id 13) — package-specific instance of this audit's first authoring task. Stays as its own tracker; this todo subsumes the general pattern.
- The original "Pre-existing test failures" section in `TODO-transfer-state-machine.md` named specific bugs (`aws-bootstrap` missing imports; `storage-aurora-dsql` `shared.records` schema mismatch); those failure modes are obsolete because the test files were *deleted*, not fixed. This todo replaces that fragment.
