# Todo: auto-generate the Pulumi state passphrase at bootstrap (option C′)

Replace the bootstrap-time placeholder `REPLACE_WITH_RANDOM_32_BYTE_VALUE` in
`/${StackPrefix}/pulumi/passphrase` with a per-deployment value that is generated
automatically without operator action and never leaks into CloudFormation
template bodies or CloudTrail `CreateStack` events.

This resolves two items from `functional-doc-cloud-overview-and-bootstrap-2026-06-04.md`
(doc id 10):

- Part 1 Open question: "Initial Pulumi passphrase rotation — who actually does this?"
- Part 2 Missing behaviors: "The Pulumi passphrase is a literal placeholder."

The selected approach (option C′) was chosen after evaluating four options;
see the conversation history of the processing session for the comparison.
Option A (Secrets Manager + `GenerateSecretString`) is the runner-up and a
fallback if C′ becomes unworkable.

## Approach: option C′ — admin-web rotates immediately post-create, SecureString

1. **Bootstrap template** (`packages/aws-bootstrap/src/bootstrap/bootstrap-template.ts`):
   change the `PulumiPassphrase` SSM resource to `Type: SecureString` (or leave
   as `String` — the value will be overwritten by SecureString PutParameter; check
   whether CFN tolerates the type change on overwrite, otherwise start as
   SecureString in the template). Placeholder value can stay.

2. **admin-web post-deploy step** (somewhere in the CloudSetupWizard "stack
   reached CREATE_COMPLETE" hook):
   - Generate 32 random bytes (`crypto.randomBytes(32).toString('base64url')`).
   - Call `ssm:PutParameter` under the federated AdminAppRole with
     `Name=/${StackPrefix}/pulumi/passphrase`, `Type=SecureString`, `Overwrite=true`.
   - Discard the local copy immediately; no UI display, no clipboard.
   - On retry / re-entry: only PutParameter if `GetParameter` returns the
     placeholder string; otherwise leave alone (rotation post-Pulumi-up would
     break existing stacks — see "must stay stable" below).

3. **IAM grants** (5 files):
   - `admin-app-policy.ts` (or wherever AdminAppRole's inline policy lives):
     add `ssm:PutParameter` + `kms:Encrypt` on the SSM passphrase ARN and the
     SSM-default KMS alias (`alias/aws/ssm`).
   - `install-infra-boundary.ts:49` and
     `foundational-permissions-boundary.ts:149`: add `kms:Decrypt` on
     `alias/aws/ssm` (the existing `ssm:GetParameter` stays).
   - `admin-installer/src/temp-policies.ts` (3 hits): add `kms:Decrypt`
     alongside the existing `ssm:GetParameter`.
   - `admin-installer/src/compute-stack.ts`: change `GetParameter` call to
     pass `WithDecryption: true`.

4. **Verification**: spin up a fresh bootstrap deployment, confirm the SSM
   parameter ends up SecureString with a non-placeholder value, confirm a
   subsequent app install succeeds end-to-end, confirm the CloudTrail
   `CreateStack` event for the bootstrap stack has no recognizable passphrase
   substring in `requestParameters.templateBody`, confirm the `PutParameter`
   event redacts `value` in `requestParameters`.

## Important invariant: the passphrase must stay stable

Pulumi encrypts secret state slices with a key derived from this passphrase.
Changing it after any `pulumi up` has run against the deployment's S3 backend
will break every subsequent `up` / `destroy` against the pre-existing stacks.
So the admin-web rotation must be a one-time write at bootstrap time only —
detect-then-skip on every subsequent run.

## Out of scope here

- Replacing the SSM-backed passphrase with KMS-backend Pulumi state encryption
  (a more invasive Pulumi backend swap).
- Mid-deployment passphrase rotation (requires walking every stack file,
  exporting/decrypting/re-encrypting/importing).
- Auditing CloudTrail to confirm `Type: String` PutParameter calls are also
  value-redacted (this todo standardizes on SecureString, sidestepping the
  question).

## Pointer back

Source review: doc id 10 (`functional-doc-cloud-overview-and-bootstrap-2026-06-04.md`),
Part 1 Open questions ("Initial Pulumi passphrase rotation") and Part 2
Missing behaviors ("The Pulumi passphrase is a literal placeholder").

## Revisit trigger

Before the first app is installed against any deployment that is intended to
hold non-throwaway data. Until this is done, every deployment shares the
literal placeholder passphrase and Pulumi state secrets are effectively
plaintext to anyone with read on the state bucket.
