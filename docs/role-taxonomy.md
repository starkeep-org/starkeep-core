# Role Taxonomy

Starkeep uses a layered IAM role hierarchy. Every credential that touches user data flows through this chain — nothing accesses DSQL or S3 directly with broad permissions.

## Roles

### admin-app role (`${stackPrefix}-admin-app-role`)

The entry point for human-operator actions. Federated from Cognito — you log into admin-web with your Cognito credentials, and the identity pool exchanges them for temporary credentials scoped to this role.

**Grants:**
- `sts:AssumeRole` on the Manager role (one hop only)
- CodeBuild start/stop for CI deployments
- `cognito-idp:*` on the Starkeep User Pool
- `s3:*` on `apps/admin/*` prefix of the files bucket
- `dsql:DbConnect` (not Admin) — operator DSQL access if needed

**Does NOT have:** direct Lambda management, IAM mint/revoke, broad S3, `dsql:DbConnectAdmin`.

---

### Manager role (`${stackPrefix}-manager-role`)

A pure delegation role — it can mint and revoke per-app roles, and nothing else. The admin-app role assumes it to perform install/uninstall operations. The protocol-core Lambda also assumes it as the first hop when acquiring per-app credentials.

**Grants:**
- `iam:CreateRole`, `iam:DeleteRole`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy` on `${stackPrefix}-app-*` — conditional on `iam:PermissionsBoundary` being set to the app permissions boundary
- `sts:AssumeRole` on `${stackPrefix}-app-*`

**Does NOT have:** data-plane access of any kind.

---

### Per-app role (`${stackPrefix}-app-${appId}-role`)

One role per installed app. Scoped by the permissions boundary and further by its inline policies.

**Trust:** Lambda service (for compute handlers) + Manager role (for STS assumption).

**Inline policies:**
- `runtime` — permanent, derived from the app's manifest `infraRequirements`
- `temp-install` — attached only during install, detached immediately after
- `temp-uninstall` — attached only during uninstall, detached immediately after

**Runtime policy grants (derived from manifest):**
- `s3:GetObject/PutObject/DeleteObject/ListBucket` on `apps/${appId}/*` (own prefix)
- `s3:GetObject` (+ write if `access: readwrite`) on `shared/${typeId}/*` for each declared type
- `dsql:DbConnect` — signs DSQL tokens as the app's PG role (`${stackPrefix}_app_${appId}`)
- `lambda:InvokeFunction` on own Lambda functions
- Log writes on own log groups
- `sts:AssumeRole` on `${stackPrefix}-app-*` if `brokerPower: true`

**Capped by:** the app permissions boundary (see below).

**Storage prefix rule.** The S3 key prefix is determined by *what* is being stored, not by *who* is writing it:

- `kind: "data"` record blobs always land in `shared/<typeId>/<2-char>/<hash>`, regardless of which app produced them. An app with `readwrite` on a type writes there; an app with `read` on the same type can resolve the same key under its own role.
- Everything else an app stores (private state, derived artifacts, raw blobs uploaded through `/files/*`) lives under `apps/<appId>/<...>`; the app organizes its own subtree.

This is what allows a single object to be authored by one app and read by another via the per-type grants above — the routing namespace (`/apps/{appId}/...` in the API) and the storage namespace are decoupled.

---

### App permissions boundary (`${stackPrefix}-app-permissions-boundary`)

A managed policy attached to every Manager-minted role. Caps the maximum possible permissions regardless of what inline policies say.

**Boundary allows:**
- S3 access conditioned on `aws:PrincipalTag/starkeep:appId` matching the key prefix
- Pulumi state bucket (full CRUD, temp-only period)
- SSM passphrase read (temp-only period)
- `dsql:DbConnect` (never Admin)
- Log writes scoped to own log group
- Lambda self-invocation

**Explicit Deny:** `iam:*` — apps can never modify IAM.

---

### User Data Owner role (`${stackPrefix}-user-data-owner-role`)

Reserved for future Drive integration. Currently has no trust policy (no principal can assume it) and empty inline policies. Placeholder only.

---

## Credential Chain (typical request)

```
Browser (Cognito identity) 
  → admin-app role          (Cognito identity pool exchange)
    → Manager role          (sts:AssumeRole, first hop)
      → per-app role        (sts:AssumeRole, second hop)
        → DSQL as ${stackPrefix}_app_${appId}  (DbConnect token)
        → S3 under apps/${appId}/              (app-scoped)
```

For protocol-core Lambda (runtime, per-request):
```
Lambda execution role (= admin-app role for data-server)
  → Manager role            (sts:AssumeRole, cached ~14 min)
    → per-app role          (sts:AssumeRole, cached ~14 min per appId)
      → DSQL as ${stackPrefix}_app_${appId}
      → S3 under apps/${appId}/
```

## Why Three Hops?

The three-hop chain — admin-app → Manager → per-app — exists because:

1. **Separation of concerns.** The admin-app role is for operators and can be revoked per-user. The Manager role is for delegation and has no data access. App roles have data access but can't modify IAM.

2. **Blast radius containment.** If an app role is compromised, it can only access its own prefix. It cannot assume other app roles (unless `brokerPower: true`), modify IAM, or access `dsql:DbConnectAdmin`.

3. **Auditability.** Every `sts:AssumeRole` call is logged in CloudTrail with the caller's ARN. The chain makes the access path unambiguous.
