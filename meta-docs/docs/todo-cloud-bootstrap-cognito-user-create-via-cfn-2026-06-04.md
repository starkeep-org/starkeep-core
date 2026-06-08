# Collect admin email in Step 1 and create the Cognito user via CloudFormation

## Context

Today the bootstrap wizard splits user creation across three manual steps:

- **Step 1** collects `region` + `stackPrefix`, generates a CloudFormation template, and links to the CFN console.
- **Step 2** asks the user to copy the stack outputs (UserPoolId / UserPoolClientId / IdentityPoolId).
- **Step 3** sends the user *back* to the AWS console — the Cognito Users page — to click "Create user" and type their email so Cognito will email them a temporary password.
- **Step 4** signs in with that email + temp password and runs the `NEW_PASSWORD_REQUIRED` challenge.

Step 3 is the only step that exists purely because the bootstrap template doesn't create the admin's Cognito user itself. CloudFormation can do this in the same stack via `AWS::Cognito::UserPoolUser`, which (when `DesiredDeliveryMediums: [EMAIL]` is set and no password is supplied) drives Cognito's existing admin-invite flow — the same flow Step 3 triggers manually today. The `InviteMessageTemplate` already configured on `UserPool` (`bootstrap-template.ts:85-89`) is what mails the temp password; that piece doesn't change.

If we collect the admin's email in Step 1 alongside `region` and `prefix`, pass it as a CloudFormation parameter, and have the stack create the Cognito user, then Step 3 disappears entirely — the temp password lands in the user's inbox while the stack is still finishing, and they go straight from Step 2 (outputs) to Step 4 (sign in).

Terminology note: the user described Step 3 as "creating their iam user". There is no IAM user involved — Step 3 is a Cognito user. Confirmed with the user before planning.

---

## Changes

### 1. Bootstrap template — accept email, create the Cognito user

**File:** `starkeep-core/packages/aws-bootstrap/src/bootstrap/bootstrap-template.ts`

- Extend `GenerateBootstrapTemplateInput` with `adminEmail?: string`.
- Add a CloudFormation **parameter** `AdminEmail` (Type: String, `AllowedPattern` for basic email shape, `MinLength: 3`). Default to the value passed in (so the rendered template has a sensible default when the user opens the CFN console, but they can still override).
- Add a new resource between `UserPoolClient` and `IdentityPool`:
  ```yaml
  AdminUser:
    Type: AWS::Cognito::UserPoolUser
    Properties:
      UserPoolId: !Ref UserPool
      Username: !Ref AdminEmail
      DesiredDeliveryMediums: [EMAIL]
      UserAttributes:
        - Name: email
          Value: !Ref AdminEmail
        - Name: email_verified
          Value: 'true'
  ```
  No `MessageAction` is set — the default behavior on create is to send the invitation email using the `InviteMessageTemplate` already declared on `UserPool` (`{####}` = temp password, `{username}` = email). No `TemporaryPassword` is set, so Cognito generates one. This matches exactly what the manual Step-3 path does today, just driven by the stack.
- Add `AdminEmail` to `Outputs` (purely so Step 4 can pre-fill the sign-in form if the user navigates fresh; nice-to-have, not load-bearing).
- Update `getCloudFormationCreateStackUrl(region, opts?)` to accept optional `{ stackName, params }` and append `param_<Key>=<encoded>` query parameters plus `stackName=<name>` — the CFN console honors both. This pre-fills `AdminEmail` and `StackPrefix` (and the stack name) so the user doesn't have to re-type them in the console.

### 2. Wizard Step 1 — email input + drop Step 3

**File:** `starkeep-core/apps/admin-web/src/components/CloudSetupWizard.tsx`

- `Step1Bootstrap` (lines 149-267):
  - Add an `email` state and a third input above the existing Region / Stack-prefix inputs. Validate with a basic email regex; `canContinue` requires all three.
  - Add `validateEmail(v)` next to the existing `validateUserPoolId` / `validateUserPoolClientId` validators (lines 83-93).
  - Pass `adminEmail` into `generateBootstrapTemplate({ stackPrefix, adminEmail })` (line 168) so the downloaded YAML's parameter default is correct.
  - Pass `{ stackName: \`\${stackPrefix}-bootstrap\`, params: { StackPrefix: stackPrefix, AdminEmail: email } }` to `getCloudFormationCreateStackUrl` (line 245).
  - Lift the captured email into the wizard's state so Step 4 can pre-fill it. The wizard already lifts `stackPrefix` via `onContinue`; extend that callback signature to `(stackPrefix, adminEmail) => void` and persist `adminEmail` to cloud-config alongside `stackPrefix` via the existing `patchCloudConfig` plumbing.
- Top-level `STEPS` array (lines 67-73): remove the `{ id: 3, label: "Create user" }` entry. Renumber the remaining steps (4 → 3, 5 → 4). Update the `StepId` union (line 65) and any `currentStep`/`completedSteps` usages.
- `Step3CreateUser` (lines 382-428): delete the component and its wiring in the wizard's step switch.
- `Step4SignIn`'s `email` state (line 447): initialize from the lifted `adminEmail` so it's pre-populated.
- Tweak the post-Step-2 copy: a one-line note in Step 2 (or top of Step 4) explaining that Cognito has emailed the temp password — and noting the sender + that the email may take a minute. Keep it small; the legwork is done by CloudFormation.

### 3. CloudConfig — persist `adminEmail`

**File:** `starkeep-core/apps/admin-web/src/lib/cloud-config.ts`

Add `adminEmail?: string` to `CloudConfig` and accept it in `patchCloudConfig`. No other consumers need to read it; it's only used to repopulate Step 1 / pre-fill Step 4 if the user reloads mid-flow.

---

## Files to touch (summary)

- `starkeep-core/packages/aws-bootstrap/src/bootstrap/bootstrap-template.ts` — `AdminEmail` parameter, `AdminUser` resource, output, URL-helper signature.
- `starkeep-core/apps/admin-web/src/components/CloudSetupWizard.tsx` — Step 1 email input, drop Step 3, renumber, pre-fill Step 4.
- `starkeep-core/apps/admin-web/src/lib/cloud-config.ts` — persist `adminEmail`.

No backend / installer changes. The cloud-data-server install route (`apps/admin-web/app/api/cloud-data-server/install/route.ts`) and the installer CLI are not on this path — they consume STS credentials produced by Step 4, which is unchanged downstream of the sign-in.

---

## Verification

1. Run `pnpm --filter @starkeep/admin-web dev` and open the wizard.
2. **Step 1**: enter a real email you can receive mail at, a region, and a prefix. Download the template — confirm it contains an `AdminEmail` parameter and an `AdminUser` resource referencing `!Ref AdminEmail`. Click the CFN console link — confirm the AdminEmail and StackPrefix fields are pre-populated in the CFN console.
3. Deploy the stack. While it's running, observe that Cognito's invitation email arrives at the supplied address with the temp password (subject "Your Starkeep account", per `InviteMessageTemplate`).
4. **Step 2**: paste the three outputs. Confirm there is no Step 3 — Continue goes directly to **Step 3 (formerly 4) — Sign in**, with the email pre-filled. Enter the temp password from the email; the `NEW_PASSWORD_REQUIRED` challenge runs as before; new password is accepted.
5. **Step 4 (formerly 5) — Deploy**: runs unchanged.
6. Tear down: delete the stack. Verify the Cognito user pool and its admin user both go away with it (they're owned by the stack).
7. Negative path: enter an invalid email in Step 1 — Continue should be disabled. Enter a syntactically valid but unreachable email — confirm the stack still reaches `CREATE_COMPLETE` (Cognito does not bounce-check at user-creation time), and the user can re-run with a corrected email by tearing down and redeploying (acceptable for a one-time bootstrap).
