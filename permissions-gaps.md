# Permissions Gaps — Working Doc

Tracking finalized decisions on gaps between the implementation and `desired-state-roles-and-permissions.md`. Items land here once the approach is settled; open discussion stays in chat.

---

## TODO LATER

Items that are not strictly permissions-model gaps but came up while reviewing the model. Capture here so they're not forgotten; defer implementation.

### `User Data Owner` IAM role (reserved-but-unassumable)

**Context.** The older `desired-state-roles-and-permissions.md` describes a `${StackPrefix}-user-data-owner-role` declared at bootstrap with an empty trust policy (`Statement: []`) and tagged `starkeep:reserved-for-drive=true` — defined but structurally unassumable until a future Drive-style app ships and flips the trust on. The role name is meant to be reserved up front so nothing else accidentally claims it, and the "User Data Owner remains unassumable" property is meant to be testable today.

**Current state.** The bootstrap template does not declare this role. A PG role named `user_data_owner` exists in DSQL DDL but that is a database role, not an IAM identity, and does not satisfy the reservation.

**Desired future state.** Add `${StackPrefix}-user-data-owner-role` to the bootstrap CloudFormation template with an empty trust-policy statement list, the reserved tag, and (optionally) the inline policy the future Drive app would inherit. No principal can assume it; the inline policy is dormant until trust is flipped.

**Why deferred.** Intentionally deferred previously — the role serves no function until Drive (or its equivalent) is on the roadmap. The cost of adding it now is small, but so is the value, and the unassumability invariant can be added as part of the broader work when Drive lands.

### Registered-but-not-deployed app state (sync without cloud compute)

**Context.** Currently, an app must be fully installed in the cloud (IAM role + PG role + schema + grants + Pulumi compute stack) before sync from local can land any records of that app's types. If a user installs photos locally but never installs it in the cloud, sync pushes of `originAppId=photos` are rejected with 409 because `...-app-photos-role` doesn't exist for the broker to assume. By design, there is no fallback identity — keeping per-app attribution intact.

**Desired future state.** Split the cloud-side app lifecycle into two states:
- **Registered.** IAM role + per-app permissions boundary + PG role + app-private schema + `shared.access_grants` rows all exist. Sync can write records attributed to this app. No Lambda/API Gateway resources.
- **Deployed.** All of the above plus the app's Pulumi compute stack (Lambda functions, routes, integrations).

A user who installs an app locally would get the app registered in the cloud automatically (or via a lightweight admin-web prompt) so sync works immediately; deploying the cloud-side compute is a separate, explicit step.

**Why deferred.** Does not affect the permissions model — every byte still gets attributed to the originating app's IAM identity. Strictly a lifecycle/UX improvement on top of the existing model. Worth implementing once the basic install flow is solid.
