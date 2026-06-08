# Author real tests for `packages/aws-bootstrap`

After deleting the four stale test files in `packages/aws-bootstrap/__tests__/` (`quick-create.test.ts`, `bootstrap-template.test.ts`, `bootstrap-flow.integration.test.ts`, `self-hosted-deploy-policy.test.ts`) plus `test-helpers.ts` — all of which referenced removed source modules (`quick-create.ts`, flat `bootstrap-template.ts`, `self-hosted-deploy-policy.ts`) and a removed SaaS surface (`generateExternalId`, control-plane account id, cross-account assume, `Starkeeper*` IAM names) — the package has no automated coverage at all. The current bootstrap template (`src/bootstrap/bootstrap-template.ts` via `generateBootstrapTemplate`) is exercised by admin-web at build time but has no unit tests verifying that:

- The four IAM roles are created with the right trust policies (admin-app trusts only the Cognito identity pool; Manager trusts only admin-app; install-DDL / install-infra trust only Manager).
- The five permissions boundaries are all created and have the right ARN templates.
- The Manager role's `iam:CreateRole` boundary allow-list (3 ARNs) matches the actual set of boundaries bootstrap creates (relevant to item 6 of the cloud-overview functional review).
- The stack outputs cover everything the next phase consumes.

Pointer back: From doc id 10 (`functional-doc-cloud-overview-and-bootstrap-2026-06-04`), Part 2 — Behavioral bugs (three items, addressed by deleting the broken tests; the missing coverage they pretended to provide is now this todo).

Revisit when: bootstrap template gets its next non-trivial change, or as part of resolving Part 2 item 6 (boundary allow-list sync) — a snapshot/golden-file test would cover both.
