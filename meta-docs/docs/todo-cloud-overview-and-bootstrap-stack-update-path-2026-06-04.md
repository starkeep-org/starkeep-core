# Todo: support re-running / updating an existing bootstrap stack

Implement and document a supported operator path for updating an already-deployed
bootstrap CloudFormation stack — e.g., to widen a permissions boundary after a
Starkeep version upgrade, add a new SSM parameter, or pick up a fix to one of
the four IAM roles.

Today the bootstrap template is structurally idempotent (CloudFormation will
diff and apply changes), but nothing in admin-web or the README walks the
operator through updating the stack. The only documented path is the initial
`CreateStack` deep link from `getCloudFormationCreateStackUrl`. There is no
equivalent `getCloudFormationUpdateStackUrl`, no admin-web flow that detects
a stale bootstrap stack and offers to update it, and no per-Starkeep-version
record of "the bootstrap template at version X has these changes vs. version
Y" that an operator could use to decide whether to update.

This resolves the Part 1 open question in
`functional-doc-cloud-overview-and-bootstrap-2026-06-04.md` (doc id 10):
"Re-running bootstrap — whether the documented operator path supports updating
the stack versus only initial creation is not visible from this scope."

## Sketch of what's needed

1. **Update-stack deep link helper** in `aws-bootstrap`: a sibling to
   `getCloudFormationCreateStackUrl` that targets the existing stack's
   "Update" page in the CFN console, pre-filled with the new template body
   (or a URL to it).
2. **Admin-web detection**: on entry, compare the deployed bootstrap stack's
   `TemplateBody` (via `cloudformation:GetTemplate`) or a recorded template
   version tag against the bundled current template; surface a "bootstrap
   stack is out of date" state with the update-stack link.
3. **Versioning convention** for the bootstrap template itself — either a
   `BootstrapTemplateVersion` parameter or a `starkeep:bootstrap-version`
   tag — so detection in step 2 is reliable without diffing whole bodies.
4. **Documentation** in the bootstrap README of the update flow (when to
   update, what changes between versions, rollback expectations).

## Constraints to keep in mind

- The template can't be regenerated with a different randomized
  `PulumiPassphrase` value on update (see todo
  `todo-cloud-overview-and-bootstrap-pulumi-passphrase-rotation-2026-06-04.md`
  — the passphrase must stay stable across the deployment lifetime).
- CFN updates to IAM resources can fail if existing assumed-role sessions
  are mid-flight; the operator-facing docs should explain when an update is
  safe to run (typically: during a maintenance window with no apps
  installing).
- Boundary widening that affects existing roles takes effect immediately;
  boundary narrowing may strand existing role permissions and needs a
  documented "audit before update" step.

## Pointer back

Source review: doc id 10
(`functional-doc-cloud-overview-and-bootstrap-2026-06-04.md`), Part 1 Open
questions, "Re-running bootstrap".

## Revisit trigger

Whenever the next change to the bootstrap template (roles, boundaries,
buckets, or SSM resources) needs to ship to deployments that have already
run the initial bootstrap. Until then, every change to the template only
benefits new deployments.
