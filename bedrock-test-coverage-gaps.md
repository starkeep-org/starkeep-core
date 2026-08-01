# Bedrock capability-broker branches — test coverage evaluation

Date: 2026-07-24

Branches evaluated:
- `starkeep-core` → `plan/cloud-capability-broker-bedrock`
- `starkeep-apps` → `capability-broker-image-models`

## Scope

**starkeep-apps** (`capability-broker-image-models`): one manifest entry (photos declares `bedrock.invoke` with 4 models, $20/mo budget, `input:megapixels`). Nothing testable beyond manifest validation, which core covers. There's also an *uncommitted, unrelated* `photos/infra/build-bundle.ts` change (OpenNext entry rename) with no test — flagging it since it's sitting in the working tree.

**starkeep-core** (`plan/cloud-capability-broker-bedrock`): ~11.6k lines. Existing capability tests: 35 (protocol-primitives) + 30 (capability-handler) + 14 (async-handler) + 17 (app-client) + 9 (manifest validate) + 5 (consent) + 4 (dsql-ddl) + 4 (IAM boundary) + 3 (models-server) + 2 always-on e2e + 4 gated live e2e. All green.

The pure decision core is genuinely well tested. The gaps cluster in **everything between the pure core and AWS**.

---

## P0 — Untested code that is load-bearing for spend or security

**1. `capability-store.ts` (521 lines) has zero tests.** No test file exists. This is the entire ledger SQL layer:

- `sumForGate` (`:233`) — builds the gate SUM with a hand-ordered parameter list; the code itself carries a comment about a placeholder-shift hazard that forced dropping `COALESCE`. Nothing asserts the emitted SQL or parameter order. Also untested: SQL-`NULL`→0 for an empty window, and the `string → Number` coercion of the SUM result.
- `reconcile` (`:263`) — the update-then-count-then-insert dance for post-call-only dimensions (`output:bytes`). Subtle and unverified.
- `rowToGate` (`:485`) — burst with `null` seconds → 0, calendar with `null` period → `"month"`, `limit_value` string coercion, null scope columns → wildcard. A wrong default here silently changes a limit.
- `loadModelOverrides` (`:155`) — `inference_profile_cleared` vs `inference_profile_id`, `vision: false` vs `null`, malformed JSON → `undefined`.
- `release` / `commitReservation` / `markAsyncJobStatus` — the `WHERE status = 'reserved'` / `'running'` guards that make double-poll idempotency work.
- `loadAsyncJob` / `lookupInvocation` — the `app_id` filter is the *only* thing preventing cross-app reads on a PUBLIC-SELECT table.

**2. The gate time window is never exercised below `windowStartMs`.** The in-memory DB in `capability-handler.test.ts:100` ignores the `ts >= startIso` predicate entirely and ignores `timeZone`. So: no test of a burst-window gate, a calendar-month rollover, rows aging out of a window, or the non-UTC `STARKEEP_CAPABILITY_TZ`. Everything proven about windows is proven only in the pure function.

**3. No concurrency test.** Reserve-on-ledger exists specifically to bound concurrent overage (plan §3.5), and nothing tests interleaved requests — reserve A → reserve B → both SUM. The harness supports it trivially; the design's central claim is unverified.

**4. `getCapabilityBrokerCreds` (`api-handler.ts:324`) is untested.** This constructs the inline session policy — the single-key `GetObject` / single-prefix `PutObject` downscoping that the whole S3-location design rests on. Untested: the JSON document shape, that Bedrock verbs are re-Allowed (a session policy is an intersection, so omitting them denies the invoke), that `bedrockAsync` adds the async verbs *and* the `async-invoke/*` resource, and — most importantly — **the caching branch**: `needsSessionPolicy === false` caches under a fixed key while the scoped path must never cache. A regression that cached a scoped credential, or returned the unscoped cached one for a scoped request, would silently remove the downscoping and no test would fail.

**5. `streamHandler` (`api-handler.ts:2067`) is entirely untested.** The streaming plane's app identity is the in-handler HMAC verifier (IAM only authorizes *reaching* the function). Untested: path/method routing, HMAC rejection, base64 body handling, in-band `error`-frame mapping of pre-flight rejections, `finally` cleanup.

**6. No route-level tests for any capability route.** `routes-db.test.ts` / `handler-auth.test.ts` exist and contain zero `capabilit` matches. Untested: all six route regexes, `/capabilities/:name/report` body validation, malformed-JSON 400s, `writeSyncOutput` key construction + invocationId sanitization (`api-handler.ts:1804`), `resolveOutputTarget` (`:1862`), `headOutput` list-and-total.

**7. `makeCapabilityContentReader` (`api-handler.ts:445`) is untested** — the by-reference authorization path. Untested: deleted record → 404, `canRead` denial → 403, the `parseObjectKey` re-authorization belt on a record-derived key, `head` → null → 404, `mimeToImageFormat` returning null → *text-only fallthrough with no bytes sent*, and the `INLINE_MAX_BYTES` threshold that decides inline-vs-S3-location (i.e. decides whether a session policy is attached at all).

**8. `handleCapabilityReport` (`capability-handler.ts:635`) has no test.** The entire app-reported output reconciliation route — including the filter that only `output:` + declared + non-generic + finite values are recorded.

**9. `createCapabilityBrokerRole` / `deleteCapabilityBrokerRole` (`iam.ts:~560/675`) are untested**, despite `create-app-role.test.ts` already having the fake-IAM harness. Untested: boundary attachment, trust policy, the `capability-invoke` inline policy contents (Bedrock resources with `accountId`; S3 scoped to `${prefix}-files-*/*`), the `EntityAlreadyExists` → trust-heal path, the `MalformedPolicyDocument` propagation-retry loop and its 120s ceiling, and delete idempotency.

---

## P1 — Meaningful behavior with no test

- **`maxTokens` clamping is untested.** `HARD_MAX_TOKENS = 8192` / floor of 1 / default 1024 (`capability-handler.ts:304`) is an unconditional cost ceiling that holds even with no gates configured. Nothing tests it.
- **`appReports` filtering in `prepareInvoke` (`:289`) untested** — undeclared key, generic key, `NaN`/`Infinity`, non-number. This is the hostile-app input path.
- **Consent gate values are never asserted.** `dsql-ddl.test.ts` only checks that a statement *contains* `capability_gates`. Nothing asserts `id = consent:photos:bedrock.invoke`, `cost`/`usd`, `calendar`/`month`, `scope_app_id`, `limit_value = 20`, `origin = app-consent`. The budget→gate translation is the primary cost limit and is effectively untested. Same for `models_json`/`reports_json` values, the no-budget→no-gate case, and reinstall upsert.
- **Uninstall's `scope_app_id` filter untested** — that operator global/provider gates survive an app uninstall.
- **The `alwaysRun` regression isn't locked in.** `orchestrator.ts` made `run_dsql_ddl` + its temp-policy bracket `alwaysRun` because a redeploy silently kept stale grants. The redeploy test (`orchestrator.test.ts:307`) asserts `uploadAppBundle` / `installComputeStack` / `attachTempInstallInfraPolicy` re-run — but not `runAppInstallDdl` or `attachTempInstallDdlPolicy`. Nor does anything assert `ir.capabilities` reaches `runAppInstallDdl`.
- **`deniedCapabilities` → `STARKEEP_DENIED_CAPABILITIES` untested** (`cloud-install/route.ts`), even though `apps-install.test.ts` tests that route. The pure `applyCapabilityDenials` is well tested; the CLI glue in `cli-install-app.ts` (abort on denied-required, manifest mutation) is not.
- **`bedrock-client.ts` response parsing untested.** The pure body builders are covered; the AWS-facing halves are not: `buildContent` (inline vs `s3Location`, `bucketOwner`), Converse text-block joining / missing usage → 0, `converseStream` delta+metadata parsing, `makeImageInvoker`'s `decoded.error` throw and empty-images throw, `startAsync`'s missing-ARN throw, and `normalizeAsyncStatus` — whose unknown→`InProgress` fallback is a deliberate fail-safe against spurious `Completed`.
- **`reportCapabilityOutput` (app-client `capability.ts:637`) is exported and untested.**
- **app-client stream edge cases**: `InvokeComplete.ErrorCode` → synthetic error event, malformed-frame skipping, `no_stream`, `empty_stream`. (Cross-chunk frame reassembly *is* covered — the helper chunks at 7 bytes.)
- **`dsql-schema-init.ts` has no tests at all**, including the 5 new capability tables' columns, PUBLIC SELECT grants, and the three ledger indexes backing the SUM.
- **Admin-web routes untested**: `capabilities/models/route.ts` and `override/route.ts` — `MODEL_ID_RE`, the half-pricing 400, the operator-defined-needs-provider 400, and the empty-override→DELETE branch. Plus `dsql-admin.ts`'s five error branches.
- **No React component tests exist in admin-web** (no `@testing-library/react`). So `CapabilityConsent.tsx`, `CapabilityModelsSection.tsx` (509 lines), and `CloudAppsSection`'s consent phase are untested — including that required capabilities can't be toggled off, that `denied` resets on modal reopen, and `reportLabel`'s app-reported/best-effort classification.
- **e2e: no live gate denial.** The 4 gated live tests cover happy paths (sync invoke, stream, image gen, video gen) plus 403/404 auth. Nothing exercises a 429 against real DSQL, nothing inspects ledger state after an invoke, nothing covers `/report`. Given real-SQL window/SUM semantics are exactly what the in-memory fake doesn't model, this is the highest-value e2e addition.

---

## P2 — Completeness in the well-covered areas

- `gates.ts`: multi-breach completeness (no short-circuit) is documented but not asserted; `windowStartMs` calendar branch not called directly; negative burst `seconds` clamp; week-start when today *is* Monday; `projectReservation` with no modality / zero cost / `output:`-prefixed appReports (silently dropped); `reconcileMeasurements` accepting `credits:` but rejecting `requests:image`.
- `dimensions.ts`: `lookupDimensionUnit` and the entire `Timing` axis (`pre`/`estimated`/`post`) are untested.
- `models.ts`: `estimates`, `vision`, `provider`, and non-null `inferenceProfileId` overrides untested (only pricing + null-clearing are); duplicate override rows; no registry-invariant test (unique ids, pricing keys are known `dimension:unit` pairs) — such a test would catch typos as models are added.
- Only 4 of 10 platform models are touched; `amazon.nova-lite` is untested despite being in the photos manifest.
- Manifest schema defaults (`required: true`, `reports: []`), negative budget, empty `models[]`.
- `capability-broker` is in `RESERVED_APP_IDS` but the test at `app-id-gates.test.ts:11` enumerates ids by hand and wasn't updated.
- `capability-models-server.ts`: malformed JSON in `parseObj`, and the partial-pricing case where only one of in/out is set → `pricing_json` silently becomes `null`.

---

## Two functional findings surfaced while reading

Not test gaps, but they change what tests you'd want:

1. **There is no operator gate management anywhere.** No admin-web UI, no API route, no CLI writes `shared.capability_gates` outside the install-time consent gate. `dsql-ddl.ts` says the operator "can later tighten or supplement" it — they currently can't. So the only cost limit that can exist is the one the app asked for in its own manifest. If you want thorough cost-limit coverage, this is a build-then-test item, not a test-only one.

2. **The model-override UI can only express token pricing.** `overrideInputToColumns` writes `pricing_json` from `input:tokens`/`output:tokens` only, and `OverrideRow` in `capability-models-server.ts` omits `output_modality` entirely. Consequences: Nova Canvas (`requests:image`) and Nova Reel (`output:duration_s`) pricing isn't operator-overridable, an operator-defined model added via the UI is always `text` modality, and saving any override through the UI overwrites `pricing_json` — dropping non-token pricing keys set by another path.

---

## Suggested starting point

`capability-store.ts` and the session-policy builder (`getCapabilityBrokerCreds`) have the worst risk-to-effort ratio — both are pure-ish, both are load-bearing, and neither has a single line of coverage today.
