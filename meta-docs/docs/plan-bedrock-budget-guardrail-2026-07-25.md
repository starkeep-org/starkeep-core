# Plan — Structural Bedrock spend guardrail (action-enabled AWS Budget)

**Date:** 2026-07-25
**Revised:** 2026-07-26 — every open question resolved (§9); all names made
Bedrock-specific rather than "capability"-generic (the budget's cost filter is Bedrock-only, so a
future non-Bedrock capability needs its own budget, not a rename of this one); §8 expanded into the
real automated-test plan.
**Status:** Not started.
**Scope topic:** cloud-apps / roles-and-permissions / cloud-overview-and-bootstrap
**Related:** `plan-cloud-capability-broker-bedrock-2026-07-22` (§3.5 gates, §3.3 capability role),
`todo-cloud-dos-cost-amplification-2026-06-30`

---

## 1. Problem and decision summary

The capability broker's gate framework (Bedrock plan §3.5) is a **software** ceiling: it holds only
as long as the broker code is correct and is on the path. Every failure mode it cannot cover ends in
the same place — the user's AWS bill. A ledger-arithmetic bug, a gate-scope bug, a leaked app HMAC
secret driving a flood of in-grant requests, or a runaway loop in a first-party app all spend real
money that no in-process check will stop once the check itself is what's wrong.

This plan adds the **structural backstop**: an action-enabled AWS Budget scoped to Bedrock spend
that, on breach, attaches a `Deny` IAM policy to the capability-broker role. After that attach, the
role cannot invoke Bedrock **regardless of what the broker code does** — including for STS sessions
minted before the freeze, since identity policies are evaluated at request time.

Decisions taken:

- **The freeze target is the capability-broker role, and that is sufficient.** It is the only
  identity in the deployment that carries any `bedrock:*` verb — the CDS's own foundational boundary
  and every per-app boundary omit Bedrock entirely (Bedrock plan §3.3). One `AttachRolePolicy` cuts
  100% of Starkeep-originated Bedrock spend.
- **Not account-wide, because account-wide isn't reachable here.** The SCP action type requires AWS
  Organizations; the IAM-policy action type can only name IAM users/groups/roles and can never
  constrain the account root user. "Account-wide" is therefore not on offer for a standalone account —
  what we can promise is "every Starkeep identity that can spend on Bedrock", which for this
  deployment is the same set. Say that plainly in the UI rather than implying more.
- **On by default, operator-disableable.** Created during the cloud-data-server foundational install
  (the same phase that mints the capability-broker role and submits the Bedrock use-case form), and
  toggleable from admin-web Settings. AWS gives the first **two** action-enabled budgets free per
  month ($0.10/day beyond), so the default costs nothing and leaves one free slot.
- **IAM primitives in the bootstrap CFN; the budget itself via API.** The `Deny` managed policy and
  the Budgets service role must exist before any budget action can reference them, and creating IAM
  privilege belongs in the auditable bootstrap stack, not at runtime. The Budget + BudgetAction are
  created via the Budgets API so the operator can toggle and re-price them without a stack update.
- **AWS is the state; no new table.** "Enabled" means the budget exists; the limit and the
  month-to-date spend come from `DescribeBudget`. Only the operator's *preference* (so a re-install
  doesn't resurrect a deliberately-deleted budget) is persisted locally, in `~/.starkeep/config.json`.
- **This is a backstop, not a control loop.** Budgets evaluate on Cost Explorer data that refreshes a
  few times a day, and Bedrock usage takes hours to land in billing. Realistic overshoot past the
  threshold is on the order of a day of spend. The §3.5 gates remain the primary, immediate control;
  the budget is what survives them being wrong.
- **Ship the two layers together, with coherent defaults.** The install also seeds one global monthly
  `cost` gate at **80% of the budget limit's default** (§4.6): the in-database gate is the first line
  of defence and denies within milliseconds of the spend happening, the budget is the second and trips
  a day late but doesn't depend on our code being right. Defaults that cohere ($20 gate under a $25
  budget) mean the fast layer is normally the one that acts, and the structural one is what's left when
  the fast layer is the thing that's broken.

**Out of scope:** SCP/Organizations support; **any use of the second free action-budget slot** — no
account-total budget, no non-Bedrock budget, nothing else (that stays with
`todo-cloud-dos-cost-amplification`, which is where the trade-off belongs); any un-freeze logic of our
own beyond the operator's `Resume` — AWS's own period reset is assumed to clear the freeze at the
month boundary (§3), and we neither reimplement nor second-guess it.
Also out of scope by nature: AI spend an app reaches *without* going through Bedrock (a first-party
app calling a provider API directly on its own credentials). This guardrail covers Bedrock-billed
spend, which is the only path the platform brokers; see §6.

---

## 2. Alignment with `data-roles-and-permissions.md`

- **Principle 1 (data stays confined):** untouched. Nothing here reads or writes user data. The
  freeze policy denies Bedrock verbs only; the broker role's `s3:GetObject`/`PutObject` on the files
  bucket is left alone (it is unusable without an invoke, and revoking it would strand the async
  output path mid-flight).
- **Principle 2 (powerful permissions centralized, bounded, ephemeral):** the new AWS-assumable
  service role holds `iam:AttachRolePolicy`/`DetachRolePolicy` — a genuine escalation verb. AWS's own
  example policy for it uses `Resource: "*"`; we do **not**. Ours is scoped to the single
  capability-broker role ARN **and** conditioned on `iam:PolicyARN` equalling the one freeze policy,
  so the worst a compromise of that role achieves is freezing (or unfreezing) Bedrock. Its trust
  policy carries the documented confused-deputy conditions (`aws:SourceAccount`, `aws:SourceArn` on
  `arn:aws:budgets::<acct>:budget/${stackPrefix}-*`).
- **Principle 3 (layered ceilings):** this adds a fourth, outermost ceiling below the three in
  Bedrock plan §3.5 — IAM ceiling → grants/registry → per-request gates → **budget freeze**. It is
  the only one of the four that does not depend on broker code being correct.
- **Admin is not a superuser:** budget management goes through **Manager**, not the admin-app role.
  Manager is already the deployment's hub for account-global foundational setup (it submits the
  Bedrock use-case form) and holds no data-plane power; budgets verbs are cost-governance, not
  data-plane, so this doesn't widen the admin role at all. admin-web assumes Manager for these calls,
  which its policy already permits.

---

## 3. What AWS actually gives us (and what it doesn't)

Verified against AWS docs 2026-07-25:

- **Action types:** apply an IAM policy, apply an SCP (Organizations only), or stop EC2/RDS
  instances. IAM policy is ours.
- **Free tier:** "Your first two action-enabled budgets are free (regardless of the number of actions
  you configure per budget) per month"; $0.10/day each beyond that. Plain budgets and their
  notifications are free and unlimited.
- **Execution role:** a service role trusted by `budgets.amazonaws.com` holding
  `iam:AttachRolePolicy` / `iam:DetachRolePolicy` (the full AWS example also lists group/user/SCP
  variants — we grant only the role pair).
- **Approval model:** `AUTOMATIC` (fires on breach) or `MANUAL` (fires on operator approval). We use
  `AUTOMATIC` — a guardrail that waits for a human on a laptop is not a guardrail.
- **Action lifecycle:** `Standby` → `Requires approval` (MANUAL only) → `Completed` → `Reversed`.
  Reversal is an explicit operator/API act (`ExecuteBudgetAction` with
  `ExecutionType: REVERSE_BUDGET_ACTION`); once reversed, **Budgets stops evaluating that action for
  the remainder of the period** (a `Reset` re-arms it).
- **Period rollover (assumed, to be confirmed in use):** a restrictive IAM policy applied by a budget
  action is **automatically detached at the start of the next budget period**, and the action's status
  resets from `Completed` back to `Standby` for the new cycle. Independent research says so; AWS's own
  docs don't state it plainly, so this plan **assumes it** and the first real freeze confirms it. The
  design is unchanged either way — only copy and expectations differ:
  - A freeze is **self-clearing at the month boundary**; `Resume` exists to lift it *early*, not as
    the only way out. Say that in the UI ("Bedrock is frozen until the new billing month begins on
    <date>, or until you resume it now") rather than implying a permanent state.
  - The banner must therefore be driven by **live `DescribeBudgetActionsForBudget` status**, never by
    a locally-cached "we froze it" flag — otherwise a self-cleared freeze leaves a stale banner
    claiming apps are broken when they aren't.
  - It also means a runaway that trips the guardrail resumes spending automatically next month. That
    is the right default (the operator isn't stranded), and it is exactly why the §4.6 soft gate — a
    calendar-month gate that also resets, but denies immediately — is the layer expected to do the
    real work.
- **Budgets is a global service** — all API calls go to `us-east-1`, and budget names are immutable
  (a rename is a delete + create).

---

## 4. Components to build

### 4.1 Bootstrap CloudFormation (`packages/aws-bootstrap`)

Two new resources plus two outputs in `bootstrap-template.ts`:

1. **`BedrockFreezePolicy`** — `AWS::IAM::ManagedPolicy`,
   `${StackPrefix}-bedrock-freeze-policy`. A single `Deny` statement. The action list is
   deliberately **not** `bedrock:*`, but it *is* written with wildcards so a Bedrock spend verb
   introduced after this plan is denied without a policy edit (§9 Q5):

   ```
   Deny: bedrock:Invoke*, bedrock:Converse*, bedrock:StartAsync*,
         bedrock:Retrieve*, bedrock:Rerank*
   Resource: "*"
   ```

   `bedrock:GetAsyncInvoke` and `bedrock:ListAsyncInvokes` are **left allowed on purpose** (and the
   patterns above are chosen not to swallow them): a video job already submitted will run and bill
   whether or not we freeze, and denying the poll would strand the ledger with an unreconciled
   reservation and the app with a job it can never collect. Freezing stops new spend; it must not
   corrupt accounting of spend already committed. Breadth is safe here because the role's permissions
   boundary is already Bedrock-invoke-only — a wider `Deny` cannot deny anything the role was ever
   going to legitimately do outside invoke.
   New statements go in a dedicated `bedrock-freeze-policy.ts` beside the boundary modules, so
   `policies.test.ts` picks it up under the same size assertions.

2. **`BedrockBudgetActionRole`** — `AWS::IAM::Role`, `${StackPrefix}-bedrock-budget-action-role`
   (43 chars at `MAX_STACK_PREFIX_LENGTH` = 16, well inside IAM's 64). Trust: service
   `budgets.amazonaws.com`, `StringEquals aws:SourceAccount = ${AWS::AccountId}`,
   `ArnLike aws:SourceArn = arn:aws:budgets::${AWS::AccountId}:budget/${StackPrefix}-*`. Inline
   policy: `iam:AttachRolePolicy` + `iam:DetachRolePolicy` on
   `arn:aws:iam::${AWS::AccountId}:role/${StackPrefix}-app-capability-broker-role`, conditioned
   `ArnEquals { "iam:PolicyARN": <BedrockFreezePolicy ARN> }`. No permissions boundary (it is
   bootstrap-created, like Manager and admin-app).

   The `Resource` list is the **enumerated** role ARNs from `bedrockFreezeTargetRoleNames` (§4.3) —
   one entry today, one line per future Bedrock role — never a `-app-*-role` wildcard. A wildcard
   would let a compromise of this role attach the freeze policy to any app role: harmless in effect,
   but wider than the job needs, and the narrow version costs nothing. §4.3 owns the list; this
   resource and §4.2 consume it.

Outputs: `BedrockFreezePolicyArn`, `BedrockBudgetActionRoleArn`. Both are also name-derivable, so
`deriveInstallerArns()` gains defaults for them and no wizard plumbing is needed — but a bootstrap
stack predating this plan won't *have* the resources. Follow the existing precedent for the
capability-broker boundary: attempt, catch `NoSuchEntity`, log "update the bootstrap stack to enable
the Bedrock spend guardrail", continue. The install must not fail over a missing guardrail.

### 4.2 Manager policy (`manager-policy.ts`)

Three new statements:

- `budgets:ViewBudget`, `budgets:ModifyBudget`, `budgets:CreateBudgetAction`,
  `budgets:UpdateBudgetAction`, `budgets:DeleteBudgetAction`, `budgets:DescribeBudgetAction*`,
  `budgets:ExecuteBudgetAction` on `arn:aws:budgets::*:budget/${stackPrefix}-*` (the action ARNs are
  children of the budget ARN).
- `iam:PassRole` on `${stackPrefix}-bedrock-budget-action-role`, conditioned
  `StringEquals { "iam:PassedToService": "budgets.amazonaws.com" }`. Manager holds no other PassRole
  today; this is the narrowest possible addition.
- `iam:AttachRolePolicy` / `iam:DetachRolePolicy` on the capability-broker role, conditioned on
  `iam:PolicyARN` = the freeze policy (identical to the budget action role's grant). This is what
  powers the manual **Freeze now / Resume** controls and, importantly, makes the whole freeze path
  deterministically testable without waiting on a real budget breach (§8).

Manager's inline policy is well under the 10,240-char inline limit; only the managed *boundaries*
sit near 6,144, and none of them change.

### 4.3 Shared spec builders (`@starkeep/aws-bootstrap`)

`src/bedrock-budget-spec.ts`, exported from the package index — pure functions, no SDK:

- `bedrockBudgetName(stackPrefix)` → `${stackPrefix}-bedrock-spend`
- `bedrockBudgetSpec({ stackPrefix, limitUsd })` → the `Budget` shape: `COST`, `MONTHLY`,
  `CostFilters: { Service: ["Amazon Bedrock"] }`, `BudgetLimit: { Amount, Unit: "USD" }`
- `bedrockFreezeTargetRoleNames(stackPrefix)` → the roles the freeze applies to. Today
  `[`${stackPrefix}-app-capability-broker-role`]`, exactly one entry, derived from
  `CAPABILITY_BROKER_APP_ID`. **This constant is the single place a future Bedrock-spending role gets
  added** (§9 Q5), and it is what §4.1's IAM resource scope, §4.2's Manager grant, and the action's
  `Roles[]` are all built from — so adding an entry propagates to all four with one edit plus a
  reinstall (§4.4 reconciles a live action's `Roles[]` against it). Carry a comment at the definition
  site saying so.
- `bedrockBudgetActionSpec({ stackPrefix, accountId })` → `ActionType: APPLY_IAM_POLICY`,
  `ApprovalModel: AUTOMATIC`, `NotificationType: ACTUAL`, threshold `100` (`PERCENTAGE`),
  `Definition.IamActionDefinition: { PolicyArn, Roles: bedrockFreezeTargetRoleNames(...) }`,
  `ExecutionRoleArn: <bedrock budget action role>`

Note what "automatic" can and cannot mean here: `IamActionDefinition.Roles` takes literal role
names, not patterns, so nothing AWS-side auto-discovers a new role. The two mechanisms that *do*
auto-cover future Bedrock capabilities are the wildcard action patterns in §4.1 (a new spend verb on
the same role needs no change at all) and this shared constant + reconcile-on-install (a genuinely
new role needs one line). A live `iam:ListRoles` sweep at ensure-time was considered and rejected:
it needs a new Manager verb and turns an exact target list into a heuristic one.

Both admin-installer and admin-web already depend on `@starkeep/aws-bootstrap`, and neither may
depend on the other — this is the one place both can share a definition, which matters because a
drifted `CostFilters` between the create path and the update path silently produces a budget that
tracks the wrong spend.

`limitUsd` at the AWS boundary is dollars-as-decimal-string; internally keep micros
(`protocol-primitives/capabilities/money.ts`) and convert only here.

### 4.4 Installer (`packages/admin-installer/src/bedrock-budget.ts`)

New module (`@aws-sdk/client-budgets` dependency), all calls region `us-east-1`, all idempotent,
taking Manager creds exactly like `iam.ts` does:

- `ensureBedrockBudget({ stackPrefix, accountId, limitUsd, managerCreds })` — `DescribeBudget`;
  create budget + action if absent, `UpdateBudget` if the limit drifted, `CreateBudgetAction` if the
  budget exists but has no action (the half-built state a failed run can leave), and
  `UpdateBudgetAction` if the live action's `Roles[]` differs from
  `bedrockFreezeTargetRoleNames(stackPrefix)` (§4.3 — this is the reconcile that makes adding a
  future Bedrock role a one-line change).
- `deleteBedrockBudget(...)` — delete action then budget; `NotFound` is a no-op.
- `describeBedrockBudget(...)` — returns `{ exists, limitUsd, actualSpendUsd, forecastedSpendUsd,
  actionStatus, lastExecuted, frozenRoleNames }` for the UI.
- `freezeBedrock(...)` / `resumeBedrock(...)` — resume prefers
  `ExecuteBudgetAction(REVERSE_BUDGET_ACTION)` when the action reports as executed (keeps Budgets'
  own state machine coherent), and falls back to a direct `DetachRolePolicy`; freeze is always the
  direct `AttachRolePolicy`. Both iterate `bedrockFreezeTargetRoleNames`, so they stay correct if the
  list grows.

Wire into `builtin-installs.ts` as **step 1d**, right after 1c (Bedrock use-case form) and after 1b
minted the broker role — the action's `Roles: [...]` target must already exist. Best-effort with a
warning on failure, matching 1c: no guardrail is a reason to warn loudly, not to fail the install.
Wire `deleteBedrockBudget` into the cloud-data-server teardown path beside
`deleteCapabilityBrokerRole`.

### 4.5 Operator preference (`~/.starkeep/config.json`)

```jsonc
"bedrockBudget": { "enabled": true, "limitUsd": 25 }
```

The key is **`bedrockBudget`**, not `capabilityBudget`: the budget's cost filter is
`Service = Amazon Bedrock` and nothing else, so a generic name would promise coverage of any future
non-Bedrock capability that it structurally cannot give. A second provider brokered later gets its
own key and its own budget, not a re-interpretation of this one.

Absent ⇒ treated as `{ enabled: true, limitUsd: 25 }`, so existing configs get the guardrail on the
next install. Step 1d skips creation when `enabled === false`. admin-web writes this file when the
operator toggles, *and* performs the AWS mutation — the file is only the "should a future install
recreate it" record; AWS is the live truth. Known and acceptable limitation for a local-only,
single-operator admin app: a second machine with a fresh config.json would recreate a disabled
budget on its next install. (Fail-safe direction — the guardrail comes back, it doesn't vanish.)

### 4.6 Seeded soft ceiling: a global monthly `cost` gate at 80% of the budget default

The two layers only cohere if the software ceiling trips *first* — an immediate 429 beats a day-late
freeze. So the install seeds one global (all scope keys NULL) monthly `cost`/`usd` gate at **80% of
the budget default**, i.e. `$20` against the `$25` budget (§5).

Implementation is deliberately the cheap version, because the expensive version is a reconciliation
engine nobody asked for:

- Seeded in `initializeSharedSchema` (`dsql-schema-init.ts`), immediately after the
  `shared.capability_gates` table create, under the installer PG role that already holds INSERT.
  Takes a new option `defaultBedrockCostGateUsd` threaded from `bedrockBudget.limitUsd × 0.8`.
- Id `operator:bedrock-monthly-cost`, `origin: "operator"` — so it appears in, and is fully editable
  and deletable by, the existing `CapabilityGatesSection` UI (the `operator:` prefix is what
  `/api/capabilities/gates/edit` requires, per its own comment).
- **`ON CONFLICT DO NOTHING`, never an upsert.** An operator's edited limit must survive every
  reinstall. The one accepted wart: a *deleted* gate is re-seeded by the next install — the same
  fail-safe direction as §4.5's `enabled: false` (the ceiling comes back; it never silently
  vanishes), and stated in the UI copy.
- **No live coupling to the budget limit.** Editing the budget to `$100` does not move the gate, and
  editing the gate does not move the budget. It is the *defaults* that cohere, not the values. This
  is what keeps the feature a seed instead of a reconciliation loop, and §4.7 pays for it by
  displaying both numbers together so any divergence is visible rather than inferred.

### 4.7 admin-web

- `src/lib/bedrock-budget-server.ts` — assume Manager via `@aws-sdk/client-sts` with the session's
  admin creds (a small helper; admin-web has not needed one before but the admin role already permits
  the assume), then call the Budgets API. Same in-process shape as `/api/costs` and
  `/api/capabilities/gates`, not a spawned installer subprocess.
- `app/api/capabilities/bedrock-budget/route.ts` — POST → status (`describeBedrockBudget` + the
  config.json preference).
- `app/api/capabilities/bedrock-budget/edit/route.ts` — POST `{ action: "enable" | "disable" |
  "set-limit" | "freeze" | "resume", limitUsd? }`.
- `src/components/BedrockBudgetSection.tsx` — rendered in Settings **above** `CapabilityGatesSection`
  (the hard ceiling should read before the soft ones). Shows: on/off toggle, monthly limit,
  MTD Bedrock spend against it, the current global `cost` gate limit beside the budget limit (§4.6 —
  the two are independent, so showing them together is the only thing that makes a divergence
  legible), and — when frozen — a loud state with the date it fired, the date the freeze self-clears
  (the start of the next billing month, per §3), and a **Resume** button framed as "lift it now".
  Frozen-ness is read from live action status on every load, never from a cached local flag (§3).
  Copy must state the honest caveats: this covers Bedrock spend Starkeep brokers, not the whole
  account and not an app that calls a provider directly; billing lag means real spend can exceed the
  limit by roughly a day's worth before the freeze lands; and a deleted global gate returns on the
  next install.
- The frozen state deserves a banner outside Settings too (apps silently losing a capability with no
  visible reason is the bad outcome) — smallest version: surface it on the dashboard page.

### 4.8 Broker error mapping (cloud-data-server)

Today a frozen role produces a Bedrock `AccessDeniedException` that `capability-handler.ts` maps to
a generic `502 invoke_failed` — an opaque fault for something that is actually an intended,
operator-visible state. Map Bedrock `AccessDeniedException` on invoke to
**`503 capability_frozen`**, message pointing at the spend guardrail. The broker cannot cheaply
*prove* the cause is the freeze (checking attached policies per request is not affordable), so the
message says "capability unavailable — likely frozen by the Bedrock spend guardrail; check admin
Settings", and admin-web is where it is confirmed. Reservation release on this path already works
(the existing `release()` calls cover it) — assert it in a test rather than assuming.

Apps that declared the capability `required: false` degrade exactly as they do on a denied consent,
which is the behaviour we already wanted.

---

## 5. Defaults

| Knob | Default | Rationale |
| --- | --- | --- |
| Enabled | on | The whole point; free within AWS's two-action-budget allowance. |
| Limit | **$25/month** | Comfortably above hobby-scale captioning/tagging, low enough that a runaway loop is caught inside one billing lag window. Editable. |
| Seeded global `cost` gate | **$20/month** (80% of the budget) | The soft ceiling must trip first: an immediate 429 from the broker beats a day-late structural freeze, and the gate is the layer that can act on spend the moment it happens. 80% leaves headroom for the gate to be the thing that stops a runaway before AWS ever notices. Independent of the budget limit thereafter (§4.6). |
| Threshold | 100% of ACTUAL | Forecast-based firing would freeze on a projection, which is too twitchy for a hard cut. |
| Approval | AUTOMATIC | See §3. |
| Scope | `Service = Amazon Bedrock`, all regions | Matches what the capability role can spend. |

Optional, cheap, recommended as a follow-on rather than a blocker: a free **80% email notification**
on the same budget, addressed to the operator's Cognito email. Notifications are free and do not
consume the action-enabled slot, and an early warning is worth more than the freeze in the common
case.

---

## 6. What this does not protect against

State these in the doc and in the UI; a guardrail that is believed to do more than it does is worse
than none.

- **Non-Bedrock spend.** Lambda/DSQL/S3 volumetric abuse is untouched — that's
  `todo-cloud-dos-cost-amplification`. The second free action slot remains unused and out of scope
  here; whether to spend it is that todo's decision, not this plan's.
- **AI spend that doesn't go through Bedrock.** The filter is `Service = Amazon Bedrock`, and the
  freeze denies `bedrock:*` verbs on the broker role. An app that reaches a model provider some other
  way — a direct provider API on its own credentials — is invisible to both layers. Accepted: the
  platform brokers Bedrock, that is the spend it can be responsible for, and the guardrail should not
  imply otherwise in the UI.
- **The overshoot window.** Cost data lags; expect up to roughly a day of spend past the threshold.
- **Anything root does.** IAM policy actions cannot constrain the account root user.
- **Spend already committed.** In-flight async jobs complete and bill (by design, §4.1).
- **A hostile operator.** Anyone who can reach admin-web can disable the guardrail. It defends
  against bugs and runaway apps, not against the account owner.

---

## 7. Build steps

1. **Bootstrap resources** — `bedrock-freeze-policy.ts`, the two CFN resources, the two outputs,
   `deriveInstallerArns` defaults. Update `policies.test.ts` (rendering + size at
   `MAX_STACK_PREFIX_LENGTH`).
2. **Manager policy** — the three statements in §4.2, with assertions in `policies.test.ts` that the
   `iam:PolicyARN` and `iam:PassedToService` conditions are present (they are the whole security
   argument; a test that only checks the verbs would pass on a dangerously wide policy).
3. **Shared spec builders** in `@starkeep/aws-bootstrap` (`bedrock-budget-spec.ts`, including
   `bedrockFreezeTargetRoleNames`) + unit tests on the emitted shapes.
4. **Installer module** `bedrock-budget.ts` + `aws-sdk-client-mock` tests: create-if-missing, limit
   drift, half-built repair, `Roles[]` drift reconcile, delete idempotence, freeze/resume paths.
5. **Install/teardown wiring** — step 1d and the CDS teardown call; test that a missing freeze policy
   (old bootstrap stack) warns and continues.
6. **Config plumbing** — `bedrockBudget` through `StarkeepConfig` / `app-cli-config.ts` /
   `builtin-installs.ts` / the CLI script, including the absent-means-enabled default.
7. **Seeded global cost gate** — §4.6: the `defaultBedrockCostGateUsd` option on
   `initializeSharedSchema`, the insert-if-absent statement, and its tests.
8. **Broker error mapping** — §4.8 + tests (mapping, and reservation release on the frozen path).
9. **admin-web** — Manager-assume helper, two routes, `BedrockBudgetSection`, dashboard banner;
   route tests and a component test.
10. **`scripts/teardown-bootstrap.sh`** — delete the budget + action by derived name (CloudFormation
    does not own them, so stack deletion leaves them behind). Keep in lockstep with the resources
    added in step 1, since that script owns everything CFN doesn't.
11. **Live verification** in the real account — the two items in §8.3 only.

Steps 1–2 must land together (the policy is useless without the role that attaches it, and the
`policies.test.ts` size assertion covers both). 3–9 are independent of 11.

---

## 8. Tests

**Explicit non-goal: no test that breaches a real AWS Budget.** Whether Budgets fires an action at
100% of actual spend is AWS's function, not ours; a test for it would cost real money, take a day to
produce a verdict, and assert something we cannot fix if it fails. What *is* ours — the policy
contents, the specs we hand AWS, the reconcile logic, the config defaults, the seeded gate, the
broker's behaviour under a frozen role, and the UI — is covered exhaustively below, all of it
mocked/offline except §8.3.

### 8.1 Automated, offline (the bulk of the coverage)

**`packages/aws-bootstrap/__tests__/policies.test.ts`** (extend; existing rendering + size
assertions at `MAX_STACK_PREFIX_LENGTH` pick the new documents up automatically):

- The freeze policy is `Effect: Deny` and denies each of the five action patterns.
- It does **not** match `bedrock:GetAsyncInvoke` / `bedrock:ListAsyncInvokes` — assert by
  wildcard-matching the rendered patterns against those two literal action names, not by eyeballing
  the list. This is the async-reconciliation invariant of §4.1 and the pattern rewrite (§9 Q5) is
  exactly the kind of edit that would silently break it.
- It denies plausible *future* spend verbs (`bedrock:InvokeAgent`, `bedrock:ConverseStream`,
  `bedrock:StartAsyncInvoke`) via the same match helper — the automation claim of Q5, tested rather
  than asserted in prose.
- Budget-action role trust: principal is `budgets.amazonaws.com`, and **both** confused-deputy
  conditions are present with the expected values (`aws:SourceAccount`, `aws:SourceArn` ArnLike on
  `arn:aws:budgets::<acct>:budget/<prefix>-*`).
- Budget-action role inline policy: verbs are exactly attach+detach; `Resource` is exactly
  `bedrockFreezeTargetRoleNames`-derived ARNs (no `*`, no `-app-*-role` wildcard); the
  `ArnEquals iam:PolicyARN` condition names the freeze policy.
- Manager policy: the budgets verbs on `budget/<prefix>-*` only; `iam:PassRole` **carries** the
  `iam:PassedToService = budgets.amazonaws.com` condition; attach/detach **carries** the
  `iam:PolicyARN` condition. Assert the conditions positively *and* assert no unconditioned
  attach/detach or PassRole statement exists — a second, wider statement would otherwise pass a
  presence-only test.
- Name lengths for both new resources at `MAX_STACK_PREFIX_LENGTH` stay inside IAM's 64.

**`packages/aws-bootstrap/__tests__/bedrock-budget-spec.test.ts`** (new): `bedrockBudgetName`
format; `bedrockBudgetSpec` emits `COST`/`MONTHLY`/`CostFilters.Service = ["Amazon Bedrock"]` and the
dollar-string conversion from micros (including a non-integer-dollar limit and a rejected negative);
`bedrockBudgetActionSpec` emits `APPLY_IAM_POLICY` + `AUTOMATIC` + `ACTUAL` + threshold `100` and
`Roles` equal to `bedrockFreezeTargetRoleNames`; and one test that the role list is non-empty and
every entry is a bare role *name* (not an ARN — `IamActionDefinition.Roles` takes names, and an ARN
there fails only at AWS).

**`packages/aws-bootstrap/__tests__/bootstrap-template.test.ts`** (extend): both resources and both
outputs are present in the rendered template and the template still parses.

**`packages/admin-installer/__tests__/bedrock-budget.test.ts`** (new, `aws-sdk-client-mock` over
`BudgetsClient` + `IAMClient`, matching the existing installer test style):

- Region is `us-east-1` on every Budgets call regardless of `config.region` (Budgets is global —
  a us-east-2 client fails at runtime and nowhere else).
- Fresh account: `DescribeBudget` → `NotFoundException` ⇒ `CreateBudget` then `CreateBudgetAction`,
  with the spec-builder shapes.
- Already correct: no mutating call at all (idempotence, asserted as a call count of zero, not as
  "no error").
- Limit drift: live `$25`, requested `$50` ⇒ `UpdateBudget`, no `CreateBudget`.
- Half-built repair: budget exists, `DescribeBudgetActionsForBudget` empty ⇒ `CreateBudgetAction`
  only.
- `Roles[]` drift: live action targets `[old-role]`, constant says `[broker-role]` ⇒
  `UpdateBudgetAction` with the constant's list (the §4.3/Q5 mechanism).
- `describeBedrockBudget` maps `DescribeBudget` + `DescribeBudgetActionsForBudget` into the UI shape,
  including `actionStatus` for each documented lifecycle value and `exists: false` on `NotFound`.
- `deleteBedrockBudget`: deletes action *before* budget; `NotFound` on either is a no-op, not a
  throw; called twice in a row is clean.
- `freezeBedrock`: `AttachRolePolicy` for every role in the list.
- `resumeBedrock`: `ExecuteBudgetAction(REVERSE_BUDGET_ACTION)` when the action reports executed;
  falls back to `DetachRolePolicy` when it does not (or when execute fails); asserts the fallback
  fires rather than swallowing the error, because "Resume did nothing and said nothing" is the worst
  outcome of this control.

**Install/teardown wiring** (extend `packages/admin-installer/__tests__/orchestrator.test.ts` or a
sibling in the same style):

- Step 1d runs after the broker role is minted (ordering matters — the action's `Roles[]` target must
  exist), and after 1c.
- `bedrockBudget.enabled === false` ⇒ step 1d makes no Budgets call.
- Config absent ⇒ treated as enabled at `$25` (the §4.5 default; a regression here silently disables
  the guardrail for every existing install).
- A missing freeze policy (pre-plan bootstrap stack, `NoSuchEntity`) ⇒ warns and the install
  **continues**, asserted on the install's outcome, not just on a log line.
- Any other Budgets failure ⇒ warns and continues (best-effort, matching 1c).
- CDS teardown calls `deleteBedrockBudget`.

**Seeded gate** (extend `packages/admin-installer/__tests__/dsql-schema-init.test.ts`, which already
captures compiled SQL):

- One insert into `shared.capability_gates` with id `operator:bedrock-monthly-cost`, all `scope_*`
  NULL (global), `dimension`/`unit` = the `cost`/`usd` canonical pair, `window_kind: calendar` /
  `window_period: month`, `on_exceed: deny`, `origin: operator`.
- `limit_value` is `$20` **in micros** for a `$25` budget — an exact integer, via the same
  `usdDecimalToMicros` the consent path uses. Assert the number, not just its presence; an off-by-1e6
  here is a 1000× wrong ceiling.
- The statement is `ON CONFLICT DO NOTHING` and specifically **not** a `DO UPDATE` (§4.6 — an upsert
  would silently revert an operator's edited limit on every reinstall).
- `defaultBedrockCostGateUsd` absent/undefined ⇒ no insert emitted.
- The seeded id satisfies `isOperatorGateId` (import the admin-web predicate, or assert the shared
  prefix rule) — if it didn't, the gate would render in the UI as uneditable and undeletable.
- A round-trip through the pure gate logic: the seeded row, mapped to a `Gate`, matches a request from
  an arbitrary app/provider/model (it is global) and denies at the limit. That is the assertion that
  the seed is actually *enforced* rather than merely stored.

**Broker error mapping** (extend
`packages/admin-installer/builtin-apps/cloud-data-server/__tests__/capability-handler.test.ts`, using
the existing in-memory capability DB):

- Bedrock `AccessDeniedException` on invoke ⇒ `503` with code `capability_frozen` and a message
  naming the spend guardrail; the previous generic `502 invoke_failed` no longer occurs on that path.
- The ledger reservation is `released` on that path (asserted on the in-memory ledger rows, per
  §4.8's "assert it rather than assuming it").
- An `AccessDeniedException` from the *streaming* path maps the same way, and the async
  `StartAsyncInvoke` path too — three entry points, one mapping, and only one of them is the obvious
  one to remember.
- A non-AccessDenied Bedrock failure still maps to `502 invoke_failed` (no over-broad rewrite).
- A `required: false` capability degrades exactly as on denied consent.

**admin-web** (`apps/admin-web/__tests__/`, following `capability-gate-routes.test.ts` /
`CapabilityGatesSection.test.tsx`):

- `bedrock-budget/route.ts`: merges live AWS status with the config.json preference; reports
  `exists: false` distinctly from `enabled: false` (an operator who disabled it and an install that
  failed to create it must not read identically).
- `bedrock-budget/edit/route.ts`: each of the five actions calls the right installer function;
  `set-limit` validates (rejects non-numeric, zero, negative, absurdly large); an unknown `action` is
  a 400; AWS failure surfaces as a 5xx with the message, not a silent `ok: true`.
- `enable`/`disable` write config.json **and** perform the AWS mutation — assert both, since §4.5's
  whole contract is that the file is a preference and AWS is the truth.
- `BedrockBudgetSection.test.tsx`: renders the limit, MTD spend, and the global gate limit beside it;
  the frozen state renders loudly with a Resume button, the fire date, and the self-clear date; a
  `Standby` action status renders **not** frozen even after a prior freeze in the same account (the
  §3 self-clear case — this is the assertion that catches a cached-flag implementation); the caveat
  copy is present (it is a stated requirement in §4.7, so it gets an assertion); the disabled state
  offers enable.

### 8.2 Automated freeze drill (e2e-aws, cheap, no budget breach)

Because Manager holds the condition-scoped attach/detach, the *effect* of a freeze is exercisable
directly — this tests our policy, not AWS's budget evaluation: attach the freeze policy → call the
broker → assert `503 capability_frozen` and that no ledger reservation is left dangling → detach →
assert a normal invoke succeeds again. Runs in seconds and costs one small form-free-model invoke.
Include the **"a broker STS session minted before the freeze is also denied"** case explicitly — that
property is the entire reason this design is worth building, and it is the one thing no mocked test
can establish.

### 8.3 Live verification (manual, once — not part of CI)

- **Budget-plumbing check.** Create the budget + action against the real account, assert
  `DescribeBudget` / `DescribeBudgetActionsForBudget` return what the spec builders intended (this is
  where a wrong `CostFilters` service string or a rejected execution-role trust shows up), then
  delete. AWS rejecting the execution role's trust is the failure mode mocks structurally cannot
  catch.
- **Service-label check.** Confirm the Bedrock service label against the account's own CUR via the
  existing `fetchMtdCostsByService` before trusting `"Amazon Bedrock"` — third-party models billed
  through AWS Marketplace may land under a different service string, which would leave them outside
  the filter (§9 Q2).

Not testable on demand, must be observed in use: the month-rollover behaviour assumed in §3. Note the
date of the first `Completed` action, then check at the start of the following month that the policy
detached and the status returned to `Standby`. If the assumption turns out to be wrong, the fix is
copy plus an operator-driven resume — no structural change.

---

## 9. Resolved decisions (formerly open questions)

Resolved 2026-07-26. Nothing here remains open for the initial implementation.

1. **Does a `Completed` action's policy stay attached into the next budget period?** **Assume it does
   not** — independent research reports that budget-action-applied IAM policies/SCPs are automatically
   detached at the start of the next budget period and the action resets `Completed` → `Standby`. The
   implementation proceeds on that assumption and confirms it in real use (§8.3). Consequences are
   written into §3 and §4.7: the freeze is self-clearing at the month boundary, `Resume` means "lift
   it early", and the frozen banner must read live action status rather than a cached flag.
2. **Is `Service = "Amazon Bedrock"` the complete filter?** Treated as covering **all Bedrock-brokered
   model spend**, which is the guardrail's stated scope. AI spend an app arranges outside Bedrock is
   explicitly *not* covered and that is acceptable (§6). The one thing still worth a live look is the
   literal service label for marketplace/third-party models (§8.3), since a wrong string means the
   filter tracks nothing — a plumbing check, not a scope question.
3. **Should the second free action slot be used now?** **No.** Out of scope. This plan touches exactly
   one budget; the other slot's use is `todo-cloud-dos-cost-amplification`'s decision to make.
4. **Should install seed a global monthly `cost` gate at ~80% of the budget limit?** **Yes** — see
   §4.6 and the §5 defaults row. The layering rationale is the point: the in-database gate is the
   first line of defence and trips essentially immediately, while the AWS Budget is the second line —
   slower, but not dependent on our code being correct. Defaulting the first to 80% of the second
   makes them cohere ($20 gate under a $25 budget). Resolved in the cheap form the question asked
   for: **defaults** cohere, values do not stay coupled. Seed once, insert-if-absent, no
   reconciliation when the operator later edits either number; the UI shows both so divergence is
   visible.
5. **Should the freeze target future Bedrock capabilities automatically?** **Yes, in the two ways that
   are simple** (§4.1, §4.3):
   - *New spend verbs, same role* — free: the freeze policy denies wildcard action patterns
     (`bedrock:Invoke*`, `bedrock:Converse*`, `bedrock:StartAsync*`, `bedrock:Retrieve*`,
     `bedrock:Rerank*`) instead of five literals, so a Bedrock verb introduced later is already
     denied. Safe because the role's boundary is Bedrock-invoke-only. Tested, including the
     never-deny-the-async-poll invariant (§8.1).
   - *A genuinely new role* — one line: `bedrockFreezeTargetRoleNames` is the single source for the
     action's `Roles[]`, the budget-action role's IAM resource scope, and Manager's attach/detach
     scope; `ensureBedrockBudget` reconciles a live action's `Roles[]` against it on every install.
     Comment at the definition site says so.

   Not attempted, as permitted by the "only if simple" bound: live `iam:ListRoles` discovery of
   Bedrock-capable roles at ensure-time. It needs a new Manager verb and replaces an exact target list
   with a heuristic one — a bad trade for a control whose value is being exact.
