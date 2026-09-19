# The post-reinstall refill fails because one broker container holds a dead session

**Date:** 2026-09-19
**Answers:** `findings-step27-refill-from-cloud-2026-09-19.md`, whose section 4
listed two hypotheses. Neither is the cause.
**Corrects:** section 7 of
`~/projects/starkeep/decision-reinstall-keep-data-rebind-vs-keep-role-2026-09-19.md`, which recorded
the step-26 failure as concurrency-correlated. The two failures share one cause.
**Stack:** `sktest`, account 026090522855, region us-east-2.
**Status:** fixed and unit-tested. Not yet confirmed by a live Tier-3 run.

## 1. The problems found

1. **The broker keeps using an AWS session whose principal has been deleted.** `getAppCreds` caches
   one assumed-role session per app per Lambda container and replaces it only when it expires.
   Deleting an app's IAM role invalidates every session assumed from it, and the keep-data uninstall
   deletes that role while the reinstall recreates it under the same name with a new principal id. A
   warm container goes on presenting the dead session for up to fifteen minutes.
2. **DSQL reports the dead session with the same code as an unpropagated mapping, and the retry
   policy treats both as transient.** `AppDsqlClientFactory` captured the session once and retried
   the connect six times against it. Waiting cures an unpropagated mapping and never cures a dead
   session, so every request spent roughly fifteen seconds and then answered 500.
3. **The broker answered a bare 500, so the condition reached the caller as an unexplained fault.**
   This is finding 3 of `~/projects/starkeep/findings-app-reinstall-dsql-mapping-2026-09-19.md`,
   still open until now.
4. **`POST /sync/now` reported a channel that threw every round as an ordinary quiet success.** The
   supervisor catches a per-engine failure so one broken channel cannot stop the others, and the
   response carried only `applied`, `shipped` and `complete`. A caller polling for rows therefore
   could not tell "nothing was owed" from "every round threw".
5. **The journey had a facility for exactly this and never called it.** `JourneyApp.ldsLogs()` exists
   to dump the local data server's log when a wait for rows runs out, and no step used it. Step 27
   failed as a bare timeout quoting an empty result set.

## 2. The evidence

CloudTrail (global IAM events, us-east-1) records the app role's churn during the run:

```
19:23:18Z  DeleteRole      sktest-app-probe-role     (step 24, the keep-data uninstall)
19:23:26Z  CreateRole      sktest-app-probe-role     (step 25, the reinstall)
```

Step 25 passed, so the install's rebind bound the DSQL mapping to the new principal correctly. The
mapping was not the problem.

CloudWatch on `/aws/lambda/sktest-app-cloud-data-server-api` shows every refusal of step 27's window
arriving on **one** log stream, while three other streams served requests in the same window with no
refusal at all. Log streams are per execution environment, so the stream names the container:

| Stream | First event | Behaviour 19:25:13Z – 19:27:13Z |
| --- | --- | --- |
| `…5982a02c` | 19:20:44Z | every `/sync/exchange` refused, six attempts, 500 |
| `…791c1ad8` | 19:20:00Z | served requests, no refusal |
| `…9c6d9ae3` | 19:20:44Z | served requests, no refusal |
| `…0f1ec402` | 19:20:44Z | served requests, no refusal |

`5982a02c` started before the role was deleted and held a session assumed from the principal the
delete destroyed. The other three never connected to DSQL as `probe` in that window, so they never
presented one.

The local data server drove `/sync/now` serially, and Lambda hands a sequential request to the
container that most recently went idle, which is why every exchange for two minutes landed on the one
broken container.

The step-26 failure recorded as concurrency-correlated has the identical shape. At 19:06:10Z five
sibling invocations connected as `probe` successfully on stream `…9c999ef4` while the sixth was
refused on stream `…692ace28`. Both containers started at 18:55:44Z; they differ in whether their
cached `probe` session predated the previous run's role deletion at 19:01:01Z. Concurrency is a
coincidence of that moment, not the cause.

## 3. Why the earlier hypotheses do not hold

- **The HMAC secret was not stale.** The local registry and `.run/sktest/app-creds/probe.json` both
  hold `34a8b091…`, and the Tier-3 suite runs the broker with `HMAC_CACHE_TTL_MS=0`, so the verifier
  re-reads SSM on every request. The one `Invalid signature` line at 19:24:27Z is the expected gap
  between the local reinstall and the install CLI's re-mirror, and it stops there.
- **The supervisor's pull targets are re-read after an install.** `/admin/apps/install` calls
  `supervisor.rescan()`, which starts the new engine before the route answers.
- **The missing `probe:*` rows in `sync_state` are a consequence, not a clue.** A round writes its
  watermarks at the end, so a round that throws writes nothing. Sixty consecutive 500s leave no key
  behind.

## 4. The fix

In `starkeep-core/packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts`:

- **`getAppCreds` takes `forceRefresh`**, and a new `invalidateAppCreds` drops an app's cached
  session so the next call assumes the role again.
- **`AppDsqlClientFactory` takes a credentials provider rather than a session.** The first refused
  connect discards the cached session and the attempt that follows presents a freshly assumed one.
  Once per request, not per attempt: a refusal that survives a new session is propagation, which is
  what the remaining attempts are for.
- **An exhausted retry budget throws `DsqlConnectDeniedError`**, which the handler maps to 503 naming
  the condition and the repair, instead of falling through to the generic 500.
- **The S3 adapter takes the same provider** through `credentialProvider`, so a request whose DSQL
  connect replaced the session does not sign its blob half with the session that just failed.

In `starkeep-core/apps/local-data-server`:

- **`exchangeAll` returns `errors`**, naming every channel whose round threw and the message it threw.
  `/sync/now` passes it through and still answers 200, because one broken channel is not a reason to
  fail a request that drove the others.

In `starkeep-core/e2e-aws/src/journey.ts`:

- **Step 27 asserts `errors` is empty on every poll** and dumps the local data server's log when the
  wait runs out. The two failures look identical from the row side, and only one of them is the
  step's subject.

## 5. Tests

- `builtin-apps/cloud-data-server/__tests__/dsql-connect-retry.test.ts` — four cases over the real
  retry policy with a faked connect: the re-assume on first refusal, the fact that it happens once
  rather than per attempt, the named error when the budget runs out, and no retry and no re-assume
  for a failure that is not an auth denial. The backoff is injected, so the file runs in milliseconds.
- `apps/local-data-server/__tests__/sync-orchestration.test.ts` — a channel failing every exchange is
  named in the `/sync/now` body, with the status the cloud answered, and a recovered round reports no
  errors.

The workspace's 33 test tasks and 35 typecheck tasks pass. `dist.zip` is rebuilt, which the journey's
`CodeSha256` check at step 3 requires before the next live run.

## 6. What is not done

The fix is verified against unit tests only. Confirming it live means a Tier-3 run that reaches step
27 with a warm broker container — which is the ordinary case, since the container that serves steps 1
through 23 is the one the uninstall's role deletion strands.
