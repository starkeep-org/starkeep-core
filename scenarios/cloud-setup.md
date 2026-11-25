# Cloud setup

This file specifies how a cloud operator brings a Starkeep deployment up in an AWS account, keeps its bootstrap layer current, and removes it again. The cloud operator works in admin-web's cloud setup wizard, in the AWS CloudFormation console, and with the scripts in `scripts/` and the installer commands in `packages/admin-installer`. The bootstrap stack creates the cloud operator's account, and the cloud operator signs in with it during setup. The file covers the bootstrap stack, the wizard's four steps, the cloud data server install and uninstall, the cloud address, custom domains, the permission limits as the cloud operator meets them, and teardown.

Related files:

- [app-lifecycle.md](app-lifecycle.md): installing, upgrading, and uninstalling apps, locally and in the cloud, and `scripts/teardown-cloud-apps.sh` run on its own.
- [users-and-access.md](users-and-access.md): admin-web sign-in and its refusal of an account without cloud operator rights, roles, the identity pool's credentials, which only cloud operator rights receive, device sign-in, and the sign-in page.
- [local-data-server.md](local-data-server.md): joining a cloud by its address, and `scripts/reset-local-data.sh`.
- [residency-and-stand-ins.md](residency-and-stand-ins.md): the deployment's library settings, which a first deploy seeds.
- [cloud-runtime.md](cloud-runtime.md): the dashboard's view of the running cloud, including the Data Server card's online state and costs.
- [drive.md](drive.md): what Drive does once the deploy has installed it.
- [app-data.md](app-data.md), [shared-data.md](shared-data.md), and [uploads-and-file-bytes.md](uploads-and-file-bytes.md): which data each session reaches, and signed file links on the cloudfront.net address.

## Starting cloud setup from the dashboard

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-001] A cloud operator on a computer with no cloud sees Deploy Starkeep Cloud and Join Existing Cloud
  Given the cloud operator runs admin-web on a computer that has neither deployed nor joined a cloud
  When the cloud operator opens the dashboard
  Then the Cloud section shows a "Deploy Starkeep Cloud" button that opens the cloud setup page
  And the Cloud section shows a "Join Existing Cloud" button
  And pointing at "Deploy Starkeep Cloud" shows a line saying it creates a new cloud in the cloud operator's AWS account
  And pointing at "Join Existing Cloud" shows "Sync this computer with your existing cloud."
```

- **Coverage:** `apps/admin-web/__tests__/pages.test.tsx` › "the dashboard offers two ways in with no cloud: deploy one, or join one that exists" (unit, local).
- **Notes:** The join form that opens beneath the buttons belongs to [local-data-server.md](local-data-server.md) (LDS-022 and LDS-023).

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-002] A cloud operator who deployed the cloud reopens the wizard from the Data Server card's Manage deployment… menu
  Given the cloud operator deployed the cloud from this computer
  When the cloud operator opens the dashboard
  Then the Cloud section no longer shows "Deploy Starkeep Cloud"
  And the cloud Data Server card's menu offers "Manage deployment…", which opens the cloud setup page
```

- **Coverage:** none. No test renders the dashboard with a deployed cloud.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-003] A cloud operator sees and copies the cloud address that phones and other computers sign in with
  Given the cloud operator deployed the cloud from this computer
  When the cloud operator opens the dashboard
  Then the Cloud section shows "Cloud address:" followed by the cloud's CloudFront address, or its custom domain once one is attached
  And clicking the copy button puts the address on the clipboard and shows "Copied"
```

- **Coverage:** `apps/admin-web/__tests__/cloud-address.test.tsx` › "the cloud address names the cloud's address" and "the cloud address copies the address" (unit, local). No test checks that the dashboard prefers the public address over the gateway address.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-004] A local operator on a computer that joined a cloud sees only that computer's link and no cloud sections
  Given the local operator joined this computer to an existing cloud by its address
  And the computer's configuration holds no user pool
  When the local operator opens the dashboard on that computer
  Then the Cloud section shows only this computer's link to the cloud
  And the dashboard shows no Cloud address line, no cloud apps, no Custom Domain, no Cloud Users, and no Costs section
```

- **Coverage:** none.

## Step 1: Bootstrap stack

### Deployment name, region, and stack prefix

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-005] A cloud operator cannot go on from step 1 until giving a region, a stack prefix, and a valid deployment name
  Given the cloud operator opened the cloud setup wizard on a computer with no cloud
  When the cloud operator leaves the region unchosen and the deployment name empty or invalid
  Then "Stack is deployed — Continue" and "Sign in to existing admin account" are disabled
  When the cloud operator chooses a region and enters a valid deployment name
  Then both buttons become enabled
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the deployment name on step 1 holds both ways forward until the name is filled in, and collapses extra spaces" (unit, local) checks only "Sign in to existing admin account", and only for a missing name. No test holds the buttons on a missing region or checks "Stack is deployed — Continue".

```gherkin
@local
@intent:confirmed @coverage:full
Scenario Outline: [CLOUD-SETUP-006] A cloud operator can download the template only for a deployment name of letters, digits, single spaces, hyphens, and underscores, up to 32 characters
  Given the cloud operator opened step 1 of the cloud setup wizard for a new deployment
  When the cloud operator enters "<name>" as the deployment name
  Then "Download bootstrap template" is <outcome>

  Examples:
    | name                              | outcome  |
    | Home Library                      | enabled  |
    | family_photos-2026                | enabled  |
    | Café                              | disabled |
    | My <b>cloud</b>                   | disabled |
    | Library {username}                | disabled |
```

- **Coverage:** `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "the deployment name accepts 1 to 32 letters, digits, single spaces, hyphens and underscores" and "the deployment name refuses punctuation, markup, braces and letters outside ASCII" (unit); `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the deployment name on step 1 holds the download until the name uses only the allowed characters" (unit, local).
- **Notes:** The input field stops typing at 32 characters, so a longer name never reaches validation: the field keeps the first 32 characters.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-007] A cloud operator finds the deployment name saved without spaces at either end or runs of inner spaces
  Given the cloud operator opened step 1 of the cloud setup wizard
  When the cloud operator enters "  Home    Library " as the deployment name and continues
  Then step 1 shows the deployment name "Home Library" when the cloud operator next opens it
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the deployment name on step 1 holds both ways forward until the name is filled in, and collapses extra spaces" (unit, local); `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "the deployment name normalizes away the spaces at either end and between words" (unit).

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-008] A cloud operator picks the region from the supported regions, with none chosen at first
  Given the cloud operator runs admin-web on a computer with no cloud
  When the cloud operator opens step 1 of the cloud setup wizard
  Then the AWS Region field shows "Select a region"
  And the field lists only the regions Starkeep supports, each with its name and code
```

- **Coverage:** none.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-009] A cloud operator finds the stack prefix set to starkeep, typed in lowercase, and capped at 16 characters
  Given the cloud operator runs admin-web on a computer with no cloud
  When the cloud operator opens step 1 of the cloud setup wizard
  Then the Stack prefix field holds "starkeep"
  When the cloud operator types "MyStack" into the Stack prefix field
  Then the field shows "mystack"
  And the field accepts no more than 16 characters
```

- **Coverage:** none.
- **Notes:** CLOUD-SETUP-140 covers a prefix with characters the stack refuses.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-010] A cloud operator who changes the stack prefix confirms first, then finds the later steps cleared
  Given the cloud operator completed the stack outputs step for the stack prefix "starkeep"
  When the cloud operator changes the stack prefix to "other" on step 1 and continues
  Then the wizard asks "Changing the stack prefix will clear stack outputs and all later configuration. Continue?"
  When the cloud operator confirms
  Then step 1 holds the new prefix and the deployment name
  And the stack outputs step and every later step show as not done
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "changing the stack prefix on step 1 asks first, then saves the new prefix and the name and clears the outputs" (unit, local) checks that the wizard asks once and saves the cleared configuration, but not the question's text or the step list's marks. `apps/admin-web/__tests__/config.test.ts` › "PATCH wizard-state persistence a null value deletes the field (wizard back-navigation invalidation)" (unit, local) checks that a cleared value leaves the saved configuration.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-011] A cloud operator who cancels a stack prefix change keeps the old prefix and its stack outputs
  Given the cloud operator completed the stack outputs step for the stack prefix "starkeep"
  When the cloud operator changes the stack prefix on step 1, continues, and cancels the question
  Then the wizard stays on step 1
  And the wizard still holds the prefix "starkeep", and the stack outputs step still holds its values and shows as done
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "changing the stack prefix on step 1 saves nothing when the operator cancels" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-140] A cloud operator who enters a stack prefix the stack would refuse sees it marked invalid and cannot go on
  Given the cloud operator opened step 1 of the cloud setup wizard for a new deployment
  When the cloud operator enters a stack prefix that holds a character other than a lowercase letter, a digit, or a hyphen, or that starts with a digit or a hyphen
  Then the Stack prefix field marks the value as invalid
  And "Download bootstrap template", "Stack is deployed — Continue", and the button that picks up an existing deployment stay disabled
```

- **Coverage:** none.
- **Notes:** Implementation gap: the wizard checks only that the prefix is not blank.

### The cloud operator's email

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-012] A cloud operator cannot download a new deployment's template without a valid email
  Given the cloud operator opened step 1 of the cloud setup wizard on a computer with no cloud
  And the cloud operator entered a deployment name and chose a region
  When the cloud operator leaves "Email address for your new Starkeep account" empty or enters an address that is not an email
  Then "Download bootstrap template" stays disabled
  When the cloud operator enters a valid email address
  Then "Download bootstrap template" becomes enabled
  And the downloaded template names that address for the cloud operator's account
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the admin email on step 1 requires a valid email before a new deployment's download, then carries it to sign-in" (unit, local); `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "the first admin bakes in the email the wizard asked for on a new deployment" (unit).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-013] A cloud operator on a computer that already holds a deployment gets no email field and a template that names no account
  Given the cloud operator's computer already holds the deployment's user pool in its configuration
  When the cloud operator opens step 1 of the cloud setup wizard
  Then step 1 shows no email field
  And a downloaded template names no account, so a stack update cannot replace the cloud operator's existing account
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the admin email on step 1 asks for no email when the config already holds a deployment, and bakes none in" (unit, local).

### Creating the stack

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-014] A cloud operator downloads the bootstrap template and sees the download marked done
  Given the cloud operator filled in step 1 for a new deployment
  When the cloud operator clicks "Download bootstrap template"
  Then the browser saves "starkeep-bootstrap-template.yaml"
  And the step shows a check mark beside the file name
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the admin email on step 1 requires a valid email before a new deployment's download, then carries it to sign-in" (unit, local) checks the generated template but not the file name or the check mark.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-015] A cloud operator opens the CloudFormation create-stack page with the stack name filled in
  Given the cloud operator chose the region "us-west-2" and kept the stack prefix "starkeep"
  When the cloud operator clicks "Open CloudFormation console ↗"
  Then a new browser tab opens the CloudFormation create-stack page in us-west-2
  And the page's stack name reads "starkeep-bootstrap"
```

- **Coverage:** `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "console URL helpers builds the create-stack URL with an optional stack name" (unit) checks the address only. No test clicks the button.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-016] A cloud operator reads console instructions that name the stack and the email to look for
  Given the cloud operator opened step 1 of the cloud setup wizard
  When the cloud operator clicks "Show full instructions"
  Then the step lists the console steps from uploading the template to submitting the stack
  And the list names the stack name "<prefix>-bootstrap" to check
  And the list tells the cloud operator to look for an email titled "Your Starkeep account" that holds the temporary password
```

- **Coverage:** none.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-017] A cloud operator starting a new deployment is told that a second computer should join instead
  Given the cloud operator's computer holds no deployment
  When the cloud operator opens step 1 of the cloud setup wizard
  Then the step says that a second deployment keeps separate data
  And the step points the cloud operator to "Join Existing Cloud" on the dashboard
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the join notice on step 1 points a new deployment to the dashboard's join box" and "the join notice on step 1 leaves the notice off for a config that already holds a deployment" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-018] A cloud operator who picks up an existing deployment skips the download and moves to the stack outputs
  Given a deployment already exists in the AWS account
  And this computer's configuration holds no cloud
  When the cloud operator chooses a region, enters the deployment name, and clicks the button that picks up an existing deployment
  Then the wizard opens the stack outputs step without asking for an email
  And no template is downloaded
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "an operator with an existing deployment and no local config signs in to the existing admin account instead of deploying again" (unit, local).
- **Notes:** The button reads "Sign in to existing admin account" today. CLOUD-SETUP-141 states what its label and note say.

```gherkin
@local
@intent:confirmed
Scenario: [CLOUD-SETUP-141] A cloud operator sees that picking up an existing deployment is for the computer that deployed it
  Given this computer's configuration holds no cloud
  When the cloud operator opens step 1 of the cloud setup wizard
  Then the button that picks up an existing deployment says it serves the computer that deployed the cloud and lost its configuration
  And a note beside the button tells a local operator on another computer to join the cloud instead
```

- **Notes:** Implementation gap: the button reads "Sign in to existing admin account" and carries no note.

## The bootstrap stack in AWS

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-019] A cloud operator who creates the stack with an email gets the cloud operator's account and a temporary password by email
  Given the cloud operator downloaded a template for a new deployment with the cloud operator's own email as the account's email
  When the cloud operator creates the bootstrap stack from the template
  Then the cloud operator receives a temporary password at that address
  And the cloud operator finds an account for that email in the stack's user pool, with cloud operator rights and in the data group
```

- **Coverage:** `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "the first admin creates the account only when the stack is given an email" and "the first admin puts the account in both groups" (unit) check the template only. The tier-3 suite creates its cloud operator's account through the API with the email left blank, so no automated test creates the cloud operator's account from a real stack.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-020] A cloud operator finds the deployment name and a separately placed password in the invitation email
  Given the bootstrap stack for the deployment "Home Library" named the cloud operator's email
  When the cloud operator opens the invitation email
  Then the subject reads "Your Starkeep account"
  And the body names "Home Library" and the account's username
  And the temporary password sits alone in its own paragraph, so one tap selects exactly the password
```

- **Coverage:** `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "the invitation email is titled the way the wizard tells the operator to look for it", "the invitation email names the deployment and the username", and "the invitation email puts the temporary password alone in its own paragraph" (unit) check the template. No test receives a real email.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-021] A cloud operator who creates the stack with no account email finds no account in the user pool
  Given the cloud operator edited a template so its account email is empty
  When the cloud operator creates the bootstrap stack from the template
  Then the cloud operator finds no account in the stack's user pool
  And no invitation email arrives
```

- **Coverage:** `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "the first admin creates the account only when the stack is given an email" and "the first admin takes the email from a parameter that defaults to empty" (unit). The tier-3 suite creates its stack with no email, but it asserts nothing about the empty pool.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-022] A cloud operator who updates the bootstrap stack finds the cloud operator's account unchanged, with its cloud operator rights and its data group membership
  Given the cloud operator signed in after the bootstrap stack created the cloud operator's account
  When the cloud operator updates the stack with a template that names no account email, or that changes the account's resource
  Then the cloud operator finds the same account for the cloud operator's email in the stack's user pool
  And the account still has cloud operator rights and still belongs to the data group
```

- **Coverage:** `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "the first admin retains the account and both memberships when removed or replaced" and "the first admin pins the account's properties, since any change replaces it in every deployment" (unit) check the template. No test updates a real stack.
- **Notes:** CLOUD-SETUP-143 states what the cloud operator sees at the next sign-in.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-SETUP-143] A cloud operator signs in with the same password and keeps cloud operator rights after a bootstrap stack update
  Given the cloud operator set a permanent password after the bootstrap stack created the account
  And the cloud operator then updated the bootstrap stack, with a template that names no account email, one that changes the account's resource, or "scripts/update-bootstrap.sh --apply"
  When the cloud operator signs in to admin-web with the same email and password
  Then the sign-in succeeds
  And admin-web shows the cloud operator its cloud sections, as before the update
```

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-023] A cloud operator finds every value the wizard and the installer need on the stack's Outputs tab
  Given the cloud operator created the bootstrap stack
  When the cloud operator opens the stack's Outputs tab
  Then the tab lists IdentityPoolId, UserPoolClientId, and UserPoolId among the outputs
  And the tab lists the device client, the sign-in domain, the role ARNs, the permissions boundary ARNs, and the bucket names
```

- **Coverage:** `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "stack outputs exposes every output the wizard and installer consume" (unit); `e2e-aws/src/journey.test.ts` › "bootstrap stack: create if missing, verify outputs" (tier-3 AWS, cloud) passed at baseline but checks only the user pool ID.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-024] A cloud operator deploys the bootstrap stack with the longest allowed stack prefix
  Given the cloud operator chose a 16-character stack prefix
  When the cloud operator creates the bootstrap stack from the downloaded template
  Then the CloudFormation console shows the stack as CREATE_COMPLETE
```

- **Coverage:** `packages/aws-bootstrap/__tests__/policies.test.ts` › the five "managed-policy size (AWS 6144-char ceiling) … fits under 6144 at the longest allowed prefix" tests and `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "template size fits CloudFormation's inline cap, as the tier-3 suite sends it" (unit). No test creates a stack at that prefix length.

## Step 2: Stack outputs

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-025] A cloud operator on the stack outputs step gets a link to the Outputs tab and enters three values
  Given the cloud operator completed step 1 with the region "us-west-2" and the stack prefix "starkeep"
  When the cloud operator opens the stack outputs step
  Then the step links "CloudFormation stack" to the starkeep-bootstrap stack's Outputs tab in us-west-2
  And the step asks for IdentityPoolId, UserPoolClientId, and UserPoolId, and no other value
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "resuming onto the last step asks for only the three IDs sign-in uses" (unit, local); `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "console URL helpers builds the stack-outputs URL filtered to the stack name" (unit). No test checks the link on the page.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario Outline: [CLOUD-SETUP-026] A cloud operator who enters a malformed stack output sees its expected format and cannot continue
  Given the cloud operator opened the stack outputs step
  When the cloud operator enters "<value>" as <field> and leaves the field
  Then the field shows "<hint>"
  And Continue stays disabled

  Examples:
    | field            | value          | hint                                                  |
    | IdentityPoolId   | us-west-2:abc  | Format: us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx |
    | UserPoolClientId | abc-123        | Must be an alphanumeric string                        |
    | UserPoolId       | uswest2abc     | Format: us-east-1_Xxxxxxxxx                           |
```

- **Coverage:** none.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-027] A cloud operator who changes the user pool after a deploy confirms first, then must sign in again and redeploy
  Given the cloud operator deployed the cloud from this computer
  When the cloud operator enters a different UserPoolId on the stack outputs step and continues
  Then the wizard asks "Changing the Cognito configuration will clear deployment outputs and require re-signing in. Continue?"
  When the cloud operator confirms
  Then the wizard opens the sign-in step
  And the deploy step shows as not done
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "changing the user pool after a deploy asks first, then clears the deploy outputs and the session" (unit, local) checks that the wizard asks once, opens the sign-in form, and locks the deploy step, but not the question's text. `apps/admin-web/__tests__/config.test.ts` › "PATCH wizard-state persistence a null value deletes the field (wizard back-navigation invalidation)" (unit, local) checks that a cleared output leaves the saved configuration.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-028] A cloud operator who cancels a user pool change keeps the deployment and stays signed in
  Given the cloud operator deployed the cloud from this computer
  When the cloud operator enters a different UserPoolId, continues, and cancels the question
  Then the wizard stays on the stack outputs step
  And the cloud operator stays signed in, and the deploy step still shows as done
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "changing the user pool after a deploy changes nothing when the operator cancels" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-029] A cloud operator who revisits the stack outputs without a change stays signed in
  Given the cloud operator is signed in on the wizard's deploy step
  When the cloud operator opens the stack outputs step and clicks Continue without changing a value
  Then the wizard opens the deploy step again without asking for a sign-in
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the session across steps skips sign-in after the operator revisits the stack outputs" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-030] A cloud operator who changes the app client or the identity pool must sign in again
  Given the cloud operator is signed in on the wizard's deploy step
  When the cloud operator changes the UserPoolClientId or the IdentityPoolId on the stack outputs step and continues
  Then the wizard opens the sign-in form
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the session across steps asks for sign-in again when the app client changes" (unit, local). No test changes the identity pool alone.

## Step 3: Sign in

Refusing an account without cloud operator rights at this step belongs to [users-and-access.md](users-and-access.md) (ACCESS-194), which owns that refusal here and, in ACCESS-002, on admin-web's dashboard.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-031] The cloud operator signs in with the emailed temporary password and sets a permanent one
  Given the cloud operator received a temporary password in the invitation email
  And the cloud setup wizard's stack outputs step is done
  When the cloud operator enters the email address and the temporary password and clicks "Sign in"
  Then the wizard says "Your temporary password has expired. Please set a new permanent password."
  When the cloud operator enters a new password of at least eight characters twice and clicks "Set password and sign in"
  Then the wizard opens the deploy step
  And the dashboard later shows the cloud operator as signed in
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "signing in on the wizard takes the temporary password, sets a permanent one, and stores the session" (unit, local) uses a stubbed Cognito. `e2e-aws/src/journey.test.ts` › "admin user exists and signs in through Cognito + Identity Pool" (tier-3 AWS, cloud) passed at baseline but signs in with a permanent password the suite set, not through the wizard.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-032] A cloud operator whose new password does not match its confirmation is refused
  Given the cloud operator reached the new-password form on the sign-in step
  When the cloud operator enters two different passwords and clicks "Set password and sign in"
  Then the form shows "Passwords do not match"
  And the wizard stays on the sign-in step
```

- **Coverage:** none.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-034] A cloud operator finds the email from step 1 already filled in on the sign-in form
  Given the cloud operator entered an email address on step 1 in this browser session
  When the cloud operator reaches the sign-in step
  Then the Email field already holds that address
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the admin email on step 1 requires a valid email before a new deployment's download, then carries it to sign-in" (unit, local).
- **Notes:** A page reload loses the address, and the cloud operator types it again.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-035] A signed-in cloud operator sees the account's email and can switch accounts
  Given the cloud operator is signed in on the wizard
  When the cloud operator opens the sign-in step
  Then the step says "You are signed in as an admin of this Starkeep deployment" with the account's email
  When the cloud operator clicks "Sign in with a different account"
  Then the step shows the sign-in form
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the session across steps shows the signed-in admin on the sign-in step and lets the admin switch accounts" (unit, local) checks the account's email and the switch, but not the "You are signed in as an admin" sentence.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-036] A cloud operator who entered only the three stack outputs copies no other value from the console
  Given the cloud operator entered only the three stack outputs on step 2
  When the cloud operator signs in on the wizard with an account that has cloud operator rights
  Then the deploy step offers "Deploy Starkeep cloud" with no request to copy another value from the console
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "signing in on the wizard saves the outputs it looks up after the sign-in" and "the outputs the wizard looks up holds a first deploy until the lookup succeeds, then deploys" (unit, local); `apps/admin-web/__tests__/cognito-outputs.test.ts` › "POST /api/cognito-outputs answers the device client and the managed login host" and "pages through the pool's clients" (unit). Cognito is stubbed in every test.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-037] A cloud operator whose bootstrap stack predates the device client or the sign-in domain is told to update the stack
  Given the bootstrap stack predates the device client or the managed sign-in domain
  When the cloud operator signs in on the wizard with an account that has cloud operator rights
  Then the deploy step says to update the bootstrap stack with a newly downloaded template and sign in again
  And "Deploy Starkeep cloud" stays disabled
  And the step offers "Look up again"
```

- **Coverage:** `apps/admin-web/__tests__/cognito-outputs.test.ts` › "POST /api/cognito-outputs says to update the stack when the pool has no device client" and "says to update the stack when the pool has no managed login domain" (unit); `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the outputs the wizard looks up blocks the deploy and says why when the lookup fails, then retries" and "signing in on the wizard completes the sign-in when the lookup fails, and says why on the deploy step" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-038] A cloud operator sees that the looked-up values could not be saved and can retry
  Given the stack has the device client and the sign-in domain
  And admin-web cannot save to this computer's configuration
  When the cloud operator signs in on the wizard with an account that has cloud operator rights
  Then the deploy step says the save failed
  And the step offers "Look up again", which looks the values up and saves them again
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the outputs the wizard looks up says so when saving the looked-up outputs fails, then retries" (unit, local).

## Step 4: Deploy

The sign-in page's display of the deployment name after a deploy belongs to [users-and-access.md](users-and-access.md) (ACCESS-032).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-039] A cloud operator cannot deploy until the wizard finishes looking up the device client and the sign-in domain
  Given the cloud operator signed in on the wizard with an account that has cloud operator rights
  And the lookup of the device client and the sign-in domain is still running
  When the cloud operator opens the deploy step
  Then the step shows "Looking up the stack's device client and sign-in domain…"
  And "Deploy Starkeep cloud" stays disabled until the lookup succeeds
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the outputs the wizard looks up shows a running lookup as a wait in place of the last error" and "the outputs the wizard looks up holds a first deploy until the lookup succeeds, then deploys" (unit, local).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-040] A cloud operator who deploys watches the cloud data server pass, then the Drive pass, in the installer's log
  Given the cloud operator signed in on the wizard with an account that has cloud operator rights, and the lookup succeeded
  When the cloud operator clicks "Deploy Starkeep cloud"
  Then the log shows "── Deploying cloud-data-server ──" followed by the installer's own lines
  And after that pass succeeds, the log shows "── Deploying Starkeep Drive ──" followed by the Drive installer's lines
  And the cloud operator reaches the cloud at its new address once both passes finish
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the deploy, end to end runs both passes, restarts the daemon once, then offers Continue" and "the deploy, end to end shows the installer's own log lines while it runs" (unit, local) stub the installer. `e2e-aws/src/journey.test.ts` › "installs cloud-data-server via the real CLI" and "installs Drive in the cloud (User-Data-Owner identity)" (tier-3 AWS, cloud) passed at baseline but run the real installers from the command line, not from the wizard.
- **Notes:** Drive's own behavior once installed belongs to [drive.md](drive.md).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-041] A cloud operator finds this computer syncing with the new cloud after a deploy, with no manual restart
  Given the local data server runs on this computer
  When the cloud operator deploys from the wizard and waits for both passes to finish
  Then the log shows "[Restarted local-data-server to apply new cloud config]" exactly once
  And the files on this computer sync with the new cloud without the cloud operator restarting anything
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the deploy, end to end runs both passes, restarts the daemon once, then offers Continue" and "shows the installer's own log lines while it runs" (unit, local); `apps/admin-web/__tests__/integration/daemon-orphan.test.ts` › "workspace daemon that replaced itself (stale pid file, successor on the port) a config-change restart still finds it running" (integration, local). No test checks that files sync with the new cloud afterward.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-042] A cloud operator is warned when the local data server cannot restart, and the deploy still succeeds
  Given the local data server on this computer cannot be restarted
  When the cloud operator deploys from the wizard and waits for both passes to finish
  Then the log shows "[Warning: could not restart local-data-server: …]" with the reason
  And the deploy step still offers "Continue →"
```

- **Coverage:** none.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-043] A cloud operator returns to the dashboard with Continue after a deploy
  Given a deploy from the wizard succeeded
  When the cloud operator clicks "Continue →"
  Then admin-web opens the dashboard
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "what Continue does sends the operator to the dashboard" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-044] A cloud operator whose deploy fails sees the error and can retry
  Given the cloud operator is signed in on the deploy step
  And AWS refuses a step of a deploy pass for a reason other than an expired session
  When the cloud operator clicks "Deploy Starkeep cloud"
  Then the log ends with "Error:" and the reason
  And the step offers "Retry install"
  And the wizard stays on the deploy step
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "a deploy that fails offers a retry and navigates nowhere" (unit, local) checks "Retry install" and that the wizard stays, but not the log's "Error:" line.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-045] A cloud operator whose AWS session expires mid-deploy signs in again and keeps the progress
  Given the cloud operator is signed in on the deploy step
  And the wizard's AWS session will expire before the deploy finishes
  When the cloud operator clicks "Deploy Starkeep cloud"
  Then the step says "Your AWS sign-in session expired. Sign in again to retry the deploy — your progress so far is preserved."
  When the cloud operator clicks "Sign in again"
  Then the wizard opens the sign-in form
  And after the sign-in the deploy step offers the deploy again
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "a deploy that fails sends the operator back to sign-in when the session was the problem" (unit, local) checks "Sign in again" and the sign-in form, but not the message's text; `apps/admin-web/__tests__/install-stream.test.ts` › "a rejected AWS session ends with EXPIRED_TOKEN after an expired STS token" and "after a DSQL refusal, which carries no SDK error" (unit). No test signs in again and redeploys.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-046] A cloud operator who reloads mid-deploy follows the running deploy instead of starting another
  Given the cloud operator started a deploy from the wizard, and the deploy is still running
  When the cloud operator reloads the cloud setup page, or restarts admin-web
  Then the deploy step shows the running deploy's log from where it was
  And the log shows no second deploy starting
  And a deploy that reached its Drive pass still finishes that pass
```

- **Coverage:** `apps/admin-web/__tests__/install-stream.test.ts` › "a run that outlives admin-web is followed by a restarted admin-web, which starts no second installer" and "reattaching to a run in progress does not spawn a second installer when a POST arrives mid-run" (unit); `apps/admin-web/__tests__/install-stream-client.test.ts` › "runInstallStream reconnects with reattach after the stream drops, and finishes on the reconnected stream" (unit). No test reloads the wizard mid-deploy.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-047] A cloud operator sees the deployed cloud's summary with its reachability, its address, and Redeploy
  Given the cloud operator deployed the cloud from this computer
  When the cloud operator opens the deploy step
  Then the step shows a "Starkeep cloud" card with an online or offline badge
  And the card shows the cloud's gateway address
  And an unreachable cloud shows "Could not reach the cloud data server:" with the reason
  And the card offers "Redeploy"
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "resuming onto the last step lands on the deploy step when the config and the session are both complete" (unit, local) reaches the card's Redeploy button. No test checks the badge, the address, or the offline reason.
- **Notes:** The dashboard's own online badge belongs to [cloud-runtime.md](cloud-runtime.md).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-048] A cloud operator who redeploys updates the existing cloud in place
  Given the cloud operator deployed the cloud from this computer and pulled newer Starkeep code
  When the cloud operator clicks "Redeploy" on the deploy step
  Then the log shows the cloud data server pass and then the Drive pass
  And the cloud keeps its address, its data, and its accounts
  And the cloud runs the newer code
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the deploy, end to end runs both passes, restarts the daemon once, then offers Continue" (unit, local) drives Redeploy with a stubbed installer. `e2e-aws/src/journey.test.ts` › "installs cloud-data-server via the real CLI" (tier-3 AWS, cloud) passed at baseline and checks that the live function runs the freshly built bundle, but runs the installer from the command line.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-050] A cloud operator who deploys from a second computer keeps the deployment's name
  Given the cloud was deployed from a first computer
  And a second computer reached the deploy step by picking up the existing deployment
  And the second computer holds the version of Starkeep the cloud runs, or a newer one
  When the cloud operator clicks "Deploy Starkeep cloud" on the second computer
  Then the cloud keeps its address, and the AWS account holds no second cloud
  And the cloud runs the second computer's version
  And the sign-in page keeps the deployment's existing name, whatever name the cloud operator typed on the second computer
```

- **Coverage:** none.
- **Notes:** Implementation gap: the deploy writes the name typed on the second computer to the sign-in page.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-SETUP-142] A cloud operator who deploys an older version than the cloud runs confirms the rollback first
  Given the cloud runs a newer version of Starkeep than this computer holds
  When the cloud operator clicks "Deploy Starkeep cloud"
  Then the wizard says that the deploy would roll the cloud back to an older version, and asks the cloud operator to confirm
  And the deploy starts only after the cloud operator confirms
```

- **Notes:** Implementation gap: no version check runs before a deploy.

## Resuming the wizard

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-051] A cloud operator who reopens the wizard lands on the first step not yet done
  Given the cloud operator finished some of the wizard's steps earlier
  When the cloud operator opens the cloud setup page again
  Then the wizard shows "Resuming session…" while it reads the saved state
  And the wizard opens the first step that is not done, with earlier steps marked done
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "resuming onto the last step lands on the deploy step when the config and the session are both complete" (unit, local); `apps/admin-web/__tests__/pages.test.tsx` › "the cloud-setup page starts at step 1 for a machine with no cloud configured" (unit, local). No test resumes onto step 2 or step 3.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-052] A cloud operator whose stored sign-in has lapsed lands on the sign-in form
  Given the cloud operator signed in on the wizard earlier
  And the stored sign-in can no longer be refreshed
  When the cloud operator opens the cloud setup page
  Then the wizard opens the sign-in form
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "a stored session that no longer refreshes lands on the sign-in form" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-053] A cloud operator whose saved deployment name is missing or invalid lands on step 1
  Given this computer's configuration holds no deployment name, or one that fails validation
  When the cloud operator opens the cloud setup page
  Then the wizard opens step 1 so the cloud operator can name the deployment
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "the deployment name on step 1 reopens step 1 for a stored name that fails validation" and "reopens step 1 for a deployment saved before the name existed" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-054] A cloud operator who reaches the deploy step without signing in is asked to sign in first
  Given the cloud operator holds no live sign-in with cloud operator rights on the wizard
  When the cloud operator opens the deploy step
  Then the step says "You need to sign in before deploying. Please complete step 3 first."
  When the cloud operator clicks "Go to Sign In"
  Then the wizard opens the sign-in form
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "a stored session that no longer refreshes sends the operator from the deploy step to the sign-in form" (unit, local) checks "Go to Sign In" and the sign-in form, but not the step's message.

## Installing the cloud data server from the terminal

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-055] A cloud operator running the install command signs in with the email and password of an account that has cloud operator rights, and sets a new password on a first sign-in
  Given the cloud operator finished steps 1 to 3 of the cloud setup wizard on this computer
  When the cloud operator runs "pnpm --filter @starkeep/admin-installer cli:install-cloud-data-server"
  Then the command asks for "Email:" and "Password:", and the password does not show as it is typed
  And for an account still on its temporary password, the command says "This account requires a new password (first login)." and asks for the new password twice
  And two new passwords that differ end the command with "Passwords do not match."
```

- **Coverage:** none. The tier-3 suite runs the command with `--non-interactive`, so no test drives the prompts.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario Outline: [CLOUD-SETUP-056] A cloud operator who runs the install command on an unfinished setup is refused and told the fix
  Given this computer's configuration <state>
  When the cloud operator runs the cloud data server install command
  Then the command exits with "<error>"
  And the command adds "<fix>"
  And the command asks for no password and changes nothing in AWS

  Examples:
    | state                              | error                                                    | fix                                                                                                          |
    | does not exist                     | Error: ~/.starkeep/config.json not found                 | Generate it from admin-web after the bootstrap stack is deployed.                                            |
    | holds no device client             | Error: ~/.starkeep/config.json has no deviceUserPoolClientId. | Sign in on admin-web's cloud setup, which looks it up. If the lookup fails, update the bootstrap stack first. |
    | holds no sign-in domain            | Error: ~/.starkeep/config.json has no cognitoDomain.     | Sign in on admin-web's cloud setup, which looks it up. If the lookup fails, update the bootstrap stack first. |
    | holds no valid deployment name     | Error: ~/.starkeep/config.json has no valid deploymentName. | Name the deployment on step 1 of admin-web's cloud setup.                                                 |
```

- **Coverage:** none.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-057] A cloud operator who runs a non-interactive install without credentials in the environment is refused
  Given the shell holds no AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, or AWS_SESSION_TOKEN
  When the cloud operator runs the install command with "--non-interactive"
  Then the command exits with "--non-interactive requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN env vars"
  And the command asks for nothing
```

- **Coverage:** none. The tier-3 suite passes credentials, so only the passing path runs.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-058] A cloud operator sees the cloud's address, file bucket, and database, and any custom-domain step left to do, when the install finishes
  Given the cloud operator finished steps 1 to 3 of the cloud setup wizard on this computer
  When the cloud operator runs the install command with the email and password of an account that has cloud operator rights and waits for it to finish
  Then the command prints "Install complete." with the cloud's gateway address, its public address, its file bucket, and its database endpoint
  And a custom domain that still awaits a step prints the record to add and says to install again
  And the dashboard on this computer then shows the deployed cloud
```

- **Coverage:** `e2e-aws/src/journey.test.ts` › "installs cloud-data-server via the real CLI" (tier-3 AWS, cloud) checks that the configuration gains the gateway address and the database endpoint, and that the cloud answers its health check. No test reads the printed summary or a custom-domain hint.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-059] A cloud operator whose install fails sees the error and a non-zero exit status
  Given AWS refuses a step of the install
  When the cloud operator runs the install command
  Then the command prints the error
  And the command exits with a non-zero status, so a script or admin-web that runs it sees the failure
```

- **Coverage:** none. The tier-3 harness and admin-web rely on the exit status, but no test makes an install fail.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-060] A cloud operator finds a real install's database protected and its file bucket versioned, and a test install's left unprotected
  Given the cloud operator finished steps 1 to 3 of the cloud setup wizard
  When the cloud operator installs the cloud data server without "--ephemeral"
  Then the cloud operator finds deletion protection turned on for the deployment's database
  And the cloud operator finds versioning turned on for the file bucket
  When the cloud operator installs a test deployment with "--ephemeral", as the cloud test suites do
  Then the cloud operator finds neither protection, so a teardown removes the database and the bucket
```

- **Coverage:** `packages/admin-installer/__tests__/cloud-data-server-hardening.test.ts` › "real installs (ephemeral=false) are hardened protects the DSQL cluster from deletion", "enables versioning on the files bucket", "ephemeral e2e installs (ephemeral=true) skip hardening leaves the DSQL cluster unprotected so teardown can drop it", and "isEphemeralInstall is fail-safe — a real install can't be marked ephemeral by accident is true only when the explicit flag is present" (unit) check the install program. The tier-3 suite installs with `--ephemeral` only, so no real install is checked in AWS.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-061] A cloud operator who installs again keeps the stored state passphrase and updates the deployment in place
  Given the cloud operator installed the cloud data server earlier
  When the cloud operator runs the install command again
  Then the command prints "Already present; leaving as-is." for the state passphrase
  And the cloud keeps its address, its data, and its accounts
```

- **Coverage:** none. No single test run installs twice.
- **Notes:** CLOUD-SETUP-048 covers the same update through the wizard's Redeploy.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-062] A cloud operator who installs with an AWS profile set in the shell changes only the deployment's account, with the permissions of the cloud operator's sign-in
  Given the cloud operator's shell sets AWS_PROFILE or holds another AWS key pair
  When the cloud operator installs the cloud data server from the terminal or from the wizard
  Then the cloud operator finds the install's changes in the deployment's AWS account, made with the permissions of the cloud operator's sign-in
  And the cloud operator finds nothing changed in an account the shell's profile names
```

- **Coverage:** `packages/admin-installer/__tests__/aws-env.test.ts` › "withoutAwsVariables removes every AWS\_ variable and keeps the rest", "installerEnv hands the child only the wizard's credentials and region", and "useOnlyAwsCredentials replaces this process's AWS environment" (unit). No test runs an install with a profile set.
- **Notes:** An app's build step during an install finds no AWS variables in its own environment, but the same design notes (section "What removing the variables does") record that a build script can still read the installer's environment. That limit belongs to the app-credential question in [users-and-access.md](users-and-access.md).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-063] A cloud operator sees an install finish through AWS's delay before a fresh IAM grant takes effect
  Given AWS refuses the install's fresh temporary permissions for up to a few minutes after the install grants them
  When the cloud operator installs the cloud data server
  Then the command waits and retries instead of failing
  And the install finishes once the grant takes effect
```

- **Coverage:** `e2e-aws/src/journey.test.ts` › "installs cloud-data-server via the real CLI" (tier-3 AWS, cloud) finishes an install against fresh grants, but does not force a delay. `packages/admin-installer/__tests__/s3-retry.test.ts` › "putAppKeepFile retries the keep-file PutObject through the fresh-role InvalidAccessKeyId window" (unit) covers the same wait for an app's role only.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-064] A cloud operator whose bootstrap stack is out of date is told to run update-bootstrap.sh when an install is refused
  Given the bootstrap stack predates a permission that the current cloud data server needs
  When the cloud operator installs the cloud data server
  Then the install fails with a message that starts "This deployment's bootstrap predates"
  And the message names "scripts/update-bootstrap.sh" and keeps AWS's own refusal text
```

- **Coverage:** `packages/admin-installer/__tests__/bootstrap-hint.test.ts` › "withBootstrapHint names update-bootstrap.sh when the boundary refused a call" and "withBootstrapHint leaves any other failure alone" (unit). No test runs an install against an outdated stack.

## Uninstalling the cloud data server

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-065] A cloud operator sees what the uninstall destroys, and keeps everything by typing anything but yes
  Given the cloud operator installed the cloud data server
  When the cloud operator runs the uninstall command and signs in with an account that has cloud operator rights
  Then the command shows "WARNING: This will permanently destroy the DSQL cluster, files bucket, billing bucket, Lambda, API Gateway, and the app IAM role."
  When the cloud operator types anything other than "yes"
  Then the command prints "Aborted." and removes nothing
```

- **Coverage:** none.
- **Notes:** `--non-interactive` skips the question.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-066] A cloud operator who uninstalls removes Drive first, then the cloud data server, and this computer forgets the custom domain
  Given the cloud operator deployed the cloud with Drive
  When the cloud operator confirms the uninstall
  Then the AWS account no longer holds Drive's identity
  And the AWS account no longer holds the database, the file bucket, the cloud's address, or the cloud data server's role
  And the command prints "Uninstall complete."
  And this computer's configuration no longer names a custom domain or the old distribution
```

- **Coverage:** none. `packages/admin-installer/__tests__/custom-domain.test.ts` › "deleteUnusedCertificates deletes every certificate after an uninstall, and none of another deployment's" (unit) covers only the certificate sweep.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-067] A cloud operator whose Drive uninstall fails is warned, and the cloud data server uninstall continues
  Given AWS refuses the removal of Drive
  When the cloud operator confirms the uninstall
  Then the command warns "Starkeep Drive uninstall failed:" with the reason and says manual cleanup of the role may be needed
  And the command still removes the cloud data server
```

- **Coverage:** none.

## Updating the bootstrap stack

The cloud operator runs `scripts/update-bootstrap.sh` from a terminal with AWS credentials for the deployment's account, outside admin-web.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-068] A cloud operator previews the bootstrap change set with update-bootstrap.sh, which applies nothing without --apply
  Given the cloud operator pulled a checkout whose bootstrap template differs from the live stack
  When the cloud operator runs "scripts/update-bootstrap.sh"
  Then the script prints the stack, the account, the region, and the deployment name
  And the script prints a table of the resources the update would add, modify, or remove
  And the script ends with "Preview only: deleted the change set. Nothing was applied." and "Rerun with --apply to apply this update."
  And the live stack is unchanged
```

- **Coverage:** none. The tier-3 step that runs the script previews a stack with no changes (CLOUD-SETUP-069).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-069] A cloud operator whose stack already matches the checkout's template is told there is nothing to do
  Given the live bootstrap stack matches the template this checkout renders
  When the cloud operator runs "scripts/update-bootstrap.sh"
  Then the script prints "The stack already matches this template. Nothing to do."
  And the script exits successfully
```

- **Coverage:** `e2e-aws/src/journey.test.ts` › "scripts/update-bootstrap.sh finds nothing to change on the stack just verified" (tier-3 AWS, cloud).

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-070] A cloud operator cannot apply a change set that replaces or removes a resource without --allow-replacement
  Given the checkout's template replaces or removes a resource of the live stack
  When the cloud operator runs "scripts/update-bootstrap.sh" without "--allow-replacement"
  Then the script says "Error: the change set removes or replaces <count> resource(s). Nothing was applied."
  And the script says to review the table and rerun with "--allow-replacement" if the change is intended
  And the live stack is unchanged, even when "--apply" was passed
```

- **Coverage:** none.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-071] A cloud operator confirms an --apply update unless passing --yes
  Given the preview shows a change that the script allows
  When the cloud operator runs "scripts/update-bootstrap.sh --apply"
  Then the script asks "Apply this change set to <prefix>-bootstrap? [y/N]"
  And any answer but "y" prints "Deleted the change set. Nothing was applied."
  And "y", or the flag "--yes", applies the update and ends with "The stack reached UPDATE_COMPLETE."
```

- **Coverage:** none.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-072] A cloud operator whose shell credentials belong to another account than the configuration names is refused
  Given this computer's configuration names the deployment's account and stack prefix
  And the shell's AWS credentials belong to another account
  When the cloud operator runs "scripts/update-bootstrap.sh" for that stack prefix
  Then the script says the credentials belong to the other account and names the configured one
  And the script says to set AWS_PROFILE to a profile for the configured account
  And the script creates no change set
```

- **Coverage:** none.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-073] A cloud operator who supplies no stack prefix, region, or deployment name is told the flags to pass
  Given this computer's configuration does not supply the stack prefix, the region, and the deployment name
  When the cloud operator runs "scripts/update-bootstrap.sh" without the missing flags
  Then the script says "Error: need a stack prefix, a region and a deployment name."
  And the script says to pass "--prefix", "--region" and "--deployment-name"
```

- **Coverage:** none.
- **Notes:** The flags default to the configuration, and the region defaults to the region in the configuration's user pool ID.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-074] A cloud operator who applies a bootstrap update keeps every parameter value and the cloud operator's account
  Given the bootstrap stack was created with the cloud operator's email
  When the cloud operator applies an update with "scripts/update-bootstrap.sh --apply"
  Then the stack's parameters keep their previous values
  And the cloud operator finds the same account for the cloud operator's email in the stack's user pool, still with cloud operator rights and in the data group
```

- **Coverage:** none. CLOUD-SETUP-022 covers the template side of the same guarantee.
- **Notes:** CLOUD-SETUP-143 states what the cloud operator sees at the next sign-in.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-075] A cloud operator who renames the deployment sees a user pool change in the preview
  Given the bootstrap stack was created with the deployment name "Home Library"
  When the cloud operator runs "scripts/update-bootstrap.sh --deployment-name 'Family Library'"
  Then the preview lists a change to the UserPool resource
  When the cloud operator applies the update with "--apply"
  Then the cloud operator finds that the user pool's invitation email names "Family Library"
```

- **Coverage:** none.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-076] A cloud operator sees each changed property's old and new value with --verbose
  Given the preview has changes
  When the cloud operator runs "scripts/update-bootstrap.sh --verbose"
  Then each changed resource lists its changed properties with a diff of the old and the new value
  And a value that CloudFormation resolves only during the update says so instead of showing a diff
  And the output ends with a diff of the deployed template against the new one
```

- **Coverage:** none.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-077] A cloud operator whose bootstrap update fails is told about the rollback and the command that lists the stack's events
  Given the checkout's template holds a change that CloudFormation fails to apply
  When the cloud operator applies the update with "scripts/update-bootstrap.sh --apply"
  Then the script says the update ended in the stack's final status and that CloudFormation rolls a failed update back
  And the script prints the "aws cloudformation describe-stack-events" command for the stack and region
  And the script exits with an error
```

- **Coverage:** none.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-078] A cloud operator whose template exceeds CloudFormation's inline size limit is refused before any change set
  Given the template this checkout renders exceeds 51,200 bytes
  When the cloud operator runs "scripts/update-bootstrap.sh"
  Then the script says the template is over CloudFormation's 51,200-byte inline limit
  And the script creates no change set
```

- **Coverage:** `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "template size fits CloudFormation's inline cap, as the tier-3 suite sends it" (unit) keeps today's template under the limit. No test checks the refusal.

## Permission limits

These scenarios state the permission limits as the cloud operator meets them during setup. The rule that only an account with cloud operator rights gets AWS credentials from a sign-in belongs to [users-and-access.md](users-and-access.md) (ACCESS-003). Which data each app's and each user's session reaches belongs to [app-data.md](app-data.md), [shared-data.md](shared-data.md), and [users-and-access.md](users-and-access.md).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-080] A cloud operator who uses the sign-in's AWS credentials outside an install cannot read members' data or change IAM
  Given the cloud operator signed in to admin-web or to an install command with an account that has cloud operator rights
  When the cloud operator uses that sign-in's AWS credentials directly, outside an install
  Then reading a member's shared files in the file bucket is refused
  And creating, changing, or deleting an IAM role or policy is refused
  And the cloud operator can still use the credentials to assume the Manager role for an install
```

- **Coverage:** `packages/aws-bootstrap/__tests__/policies.test.ts` › "admin-app policy can assume Manager but holds no IAM mutation power of its own" (unit) checks the policy document. `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "trust policies (who can assume which role) ManagerRole is assumable only by AdminAppRole" (unit). No test simulates a refused read of shared files with the credentials of a sign-in with cloud operator rights.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-081] A cloud operator with a current bootstrap stack never meets a permissions-boundary refusal during an install
  Given the bootstrap stack matches the checkout's template
  When the cloud operator installs the cloud data server, with or without a custom domain, or installs or uninstalls an app
  Then no step of the install fails with a permissions-boundary refusal
```

- **Coverage:** `packages/admin-installer/__tests__/temp-policy-symmetry.test.ts` › "temp/runtime policies are subsumed by their boundaries temp-install-ddl ⊆ install-ddl boundary", "temp-install-infra ⊆ install-infra boundary", "temp-uninstall-infra ⊆ install-infra boundary", "temp-install-cloud-data-server ⊆ foundational boundary", "temp-install-cloud-data-server with a custom domain", and "per-app runtime policy ⊆ per-app boundary" (unit); `packages/admin-installer/__tests__/policy-subsumption.test.ts` (unit, 8 tests on the action comparison); `packages/iam-permission-tests/test/expected-calls.test.ts` › "modeled calls are within policy ∩ boundary install-cloud-data-server" and "install-cloud-data-server-custom-domain" (unit, policy simulation); `e2e-aws/src/journey.test.ts` › "installs cloud-data-server via the real CLI" (tier-3 AWS, cloud).
- **Notes:** The boundaries' contents per app and per user are not scenarios here. CLOUD-SETUP-064 covers the message an outdated bootstrap's refusal produces.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-082] A cloud operator who installs a custom domain finds that the install may change only that domain's records and validation records
  Given the account's Route53 zone "example.com" holds records the cloud operator owns
  When the cloud operator installs the cloud with the custom domain "photos.example.com"
  Then the cloud operator finds the records for "photos.example.com" and the validation records under it in the zone
  And AWS refuses the install any change to "example.com" itself, to a sibling name, or to a deeper name that is not a validation record
  And AWS refuses an install that names no custom domain any record change at all
```

- **Coverage:** `packages/iam-permission-tests/test/custom-domain-records.test.ts` › "install-cloud-data-server-custom-domain refuses the parent zone's apex", "refuses a sibling", "refuses a deeper name that is not a validation record", "refuses a batch mixing the domain with another name", and "install-cloud-data-server, naming no domain holds no record grant at all" (unit, policy simulation); `packages/iam-permission-tests/test/expected-calls.test.ts` › "modeled calls are within policy ∩ boundary install-cloud-data-server-custom-domain" (unit, policy simulation) allows the domain's own records.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-083] A cloud operator's installs and uninstalls delete only certificates tagged with this deployment
  Given the account holds certificates tagged with this deployment's stack prefix, with another deployment's prefix, and with no prefix
  When the cloud operator runs an install or uninstall of this deployment that cleans up certificates
  Then the cloud operator finds only the certificates tagged with this deployment's stack prefix deleted
  And the other certificates stay
```

- **Coverage:** `packages/iam-permission-tests/test/temp-install-cloud-data-server.test.ts` › "install-cloud-data-server-custom-domain: acm:DeleteCertificate allows a certificate tagged with this deployment's prefix", "refuses a certificate tagged with another prefix", and "refuses a certificate with no prefix tag" (unit, policy simulation); `packages/admin-installer/__tests__/custom-domain.test.ts` › "deleteUnusedCertificates deletes every certificate after an uninstall, and none of another deployment's" (unit).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-084] A cloud operator can read certificates with the sign-in's AWS credentials only in us-east-1
  Given the cloud operator signed in to admin-web with an account that has cloud operator rights
  When the cloud operator reads certificates with that sign-in's AWS credentials, as the Custom Domain section's checks do
  Then the reads in us-east-1 succeed
  And the same reads in any other region are refused
```

- **Coverage:** `packages/iam-permission-tests/test/admin-app-certificates.test.ts` › "admin-app: ACM reads allows acm:DescribeCertificate in us-east-1", "allows acm:ListCertificates in us-east-1", "refuses acm:DescribeCertificate outside us-east-1", and "refuses acm:ListCertificates outside us-east-1" (unit, policy simulation).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-085] A cloud operator signs in with cloud operator rights to run a maintenance script, and an IAM user's own keys cannot stand in
  Given the cloud operator's shell holds no credentials from a sign-in with cloud operator rights
  When the cloud operator runs one of the installer package's maintenance scripts
  Then the script says "Sign in as an admin of this deployment." and asks for the email and password
  When the cloud operator passes an IAM user's own access keys instead
  Then the script's first step, assuming the Manager role, is refused
```

- **Coverage:** `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "trust policies (who can assume which role) ManagerRole is assumable only by AdminAppRole" and "AdminAppRole is assumable only via Cognito federation, gated on the identity pool" (unit) check the trust policies. No test runs a maintenance script.
- **Notes:** `scripts/update-bootstrap.sh` and the teardown scripts are different: they use the shell's AWS CLI credentials, by design (`README.md` › "Upgrade Starkeep" and "Removing Starkeep Cloud").

## Custom domain

The cloud operator gives the cloud a domain such as `photos.example.com` in admin-web's Custom Domain section. Each change runs the cloud data server install with the AWS credentials of the cloud operator's sign-in. A domain whose DNS zone lives in Route53 in the deployment's account goes live in one update. A domain hosted at another DNS provider takes two updates and two records that the cloud operator adds at the provider.

### Setting up a domain

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-086] A cloud operator sees the Custom Domain section only on the deploying computer while signed in with cloud operator rights
  Given the cloud operator deployed the cloud from this computer
  When the cloud operator signs in on the dashboard with an account that has cloud operator rights
  Then the dashboard shows a collapsed "Custom Domain" section
  When the cloud operator signs out, or opens the dashboard on a computer that joined the cloud by its address
  Then the dashboard shows no Custom Domain section
```

- **Coverage:** none. The section's tests render the section on its own.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario Outline: [CLOUD-SETUP-087] A cloud operator cannot set up a domain name that the cloud could not answer on
  Given the cloud operator opened the Custom Domain section
  When the cloud operator enters "<domain>" and clicks "Set up"
  Then the section shows "<message>"
  And no confirmation dialog opens, and nothing is saved

  Examples:
    | domain                 | message                                                                                  |
    | *.example.com          | Custom domain *.example.com has a wildcard; name one host, such as photos.example.com.  |
    | photos                 | Custom domain photos is not a valid host name.                                           |
    | d111.cloudfront.net    | Custom domain d111.cloudfront.net is a CloudFront name; name a domain you own.           |
    | photos-.example.com    | Custom domain photos-.example.com is not a valid host name.                              |
    | my photos.example.com  | Custom domain my photos.example.com is not a valid host name.                            |
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain.test.ts` › "validateCustomDomain refuses a wildcard", "refuses a single label", "refuses a CloudFront name", "refuses a label ending in a hyphen", and "refuses a space" (unit); `apps/admin-web/__tests__/custom-domain-route.test.ts` › "POST /zone refuses an invalid name before it reads Route53" and "PUT refuses a name the cloud could not answer on, and writes nothing" (unit, local). No test checks the message in the section.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-088] A cloud operator who enters a domain in mixed case with a trailing dot finds it saved in lowercase without the dot
  Given the cloud operator opened the Custom Domain section
  When the cloud operator enters "Photos.Example.com." and approves the Set up dialog
  Then the Custom Domain section names the saved domain "photos.example.com"
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain.test.ts` › "validateCustomDomain lowercases and drops a trailing dot" (unit); `apps/admin-web/__tests__/custom-domain-route.test.ts` › "PUT writes the domain in the form the install compares against" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-089] A cloud operator who sets up a domain too long for the install's policy quota is told to choose a shorter one
  Given the cloud operator opened the Custom Domain section
  When the cloud operator sets up a domain whose install permissions would not fit IAM's inline-policy quota
  Then the section says "<domain> is too long: the install's permissions for it would not fit IAM's inline-policy quota. Choose a shorter domain."
  And a domain that fits alone but not beside the domains the next install must still clean up names those domains in the message
  And nothing is saved
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-route.test.ts` › "PUT refuses a domain whose grants would overflow the role's policy quota" (unit, local) checks the refusal that names the earlier domain, and that nothing is saved. No test checks the "is too long" message for a domain that overflows alone, or the message in the section.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-090] A cloud operator setting up a domain in the account's Route53 zone sees the records the update adds before approving it
  Given the deployment's AWS account holds the public Route53 zone "example.com"
  When the cloud operator enters "photos.example.com" and clicks "Set up"
  Then the dialog "Set up photos.example.com" says the domain's DNS lives in that zone
  And the dialog names the A record that points the domain at the cloud and the CNAME record that proves ownership
  And the dialog says the update changes no other record and stops if the domain already has an A, AAAA, or CNAME record
  And nothing is saved until the cloud operator clicks "Set up" in the dialog, which saves the domain and runs the update
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "Set up names a Route53 domain's records and saves nothing until the operator approves" and "Set up asks for the domain's zone with the operator's credentials" (unit, local); `apps/admin-web/__tests__/custom-domain-route.test.ts` › "POST /zone names the account's zone for the domain, found with the operator's credentials" (unit, local). No test checks the dialog's sentence that the update changes no other record and stops on an existing record.
- **Notes:** CLOUD-SETUP-096 covers the stop on an existing record.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-091] A cloud operator setting up a domain hosted elsewhere sees the steps at the DNS provider before approving them
  Given the deployment's AWS account holds no Route53 zone for "photos.example.org"
  When the cloud operator enters "photos.example.org" and clicks "Set up"
  Then the dialog says the domain's DNS lives outside this AWS account
  And the dialog lists four steps: the first update requests a certificate and changes no DNS records, the section shows two records to add, "Check now" confirms both, and "Finish" runs a second update that attaches the domain
  And the dialog says the cloud's cloudfront.net address keeps working throughout
  And nothing is saved until the cloud operator approves
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "Set up lists the steps for a domain hosted elsewhere, and saves nothing until approved" (unit, local) checks the first and last steps and that nothing is saved; `apps/admin-web/__tests__/custom-domain-route.test.ts` › "POST /zone reports no zone for a domain hosted elsewhere" (unit, local). No test checks the two middle steps or the sentence that the cloudfront.net address keeps working.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-092] A cloud operator who cancels the Set up dialog saves nothing and runs no update
  Given the cloud operator opened the Set up dialog for a domain
  When the cloud operator clicks "Cancel"
  Then the dialog closes
  And no domain is saved and no update runs
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "Set up Cancel saves nothing and runs no install" (unit, local).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-093] A cloud operator whose Route53 zone public DNS does not delegate to gets the steps for a domain hosted elsewhere
  Given the deployment's AWS account holds a Route53 zone "example.com"
  And public DNS delegates "example.com", or a name between it and the domain, to other name servers
  When the cloud operator sets up "photos.example.com"
  Then the Set up dialog says the domain's DNS lives outside this AWS account and lists the steps at the DNS provider
  And after the update, the cloud operator finds no new record in the undelegated zone
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain.test.ts` › "findHostedZone refuses a zone that public DNS does not delegate to", "findHostedZone refuses a zone whose name does not resolve at all", and "findHostedZone a name between the zone and the domain refuses the zone when public DNS delegates that name to other servers" (unit). No test drives the dialog with an undelegated zone.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-094] A cloud operator follows a custom-domain update's output, even across a page reload
  Given the cloud operator opened the dialog for a custom-domain change
  When the cloud operator approves the change
  Then the "Updating the cloud" dialog shows the install's log lines as they arrive, and Close stays disabled until the run ends
  When the cloud operator reloads the page while the update runs
  Then the dialog opens again and follows the same run to its end
```

- **Coverage:** none. `apps/admin-web/__tests__/custom-domain-section.test.tsx` checks only that an approved change starts the install.

### A domain in the account's Route53 zone

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-095] A cloud operator sees a domain in the account's Route53 zone become the cloud's address in one update
  Given the deployment's AWS account holds the Route53 zone for "photos.example.com"
  When the cloud operator approves "photos.example.com" in the Set up dialog and waits for the update to finish
  Then the zone holds one A alias record for the domain pointing at the cloud, and the certificate's validation record
  And the certificate for the domain is issued in us-east-1
  And the Cloud address line shows "https://photos.example.com"
  And the Custom Domain section says "The cloud answers on photos.example.com." and asks the cloud operator to add no record
```

- **Coverage:** `packages/admin-installer/__tests__/cloudfront-custom-domain.test.ts` › "Route53 mode requests the certificate in us-east-1, the only region CloudFront takes", "Route53 mode writes the validation record ACM asks for, in the domain's zone", "Route53 mode points one A alias record at the distribution, and writes no AAAA", and "Route53 mode makes the custom domain canonical and keeps exporting the cloudfront.net name" (unit); `packages/admin-installer/__tests__/custom-domain-plan.test.ts` › "planCustomDomain takes Route53 mode for a zone in the account, canonical in the same run" (unit); `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "Route53 mode shows no records to add" (unit, local). `e2e-aws-custom-domain/src/custom-domain.test.ts` › "attaches the first name: certificate issued, one A alias, canonical" (tier-3 AWS, cloud) asserts each clause in real AWS, but the suite was not run at baseline.
- **Notes:** The 2026-11-06 custom domain plan named A and AAAA alias records. The later maintainer design notes (custom domain review fixes, 2026-11-06), section "Decisions", drop the AAAA record.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-096] A cloud operator cannot set up a domain that already holds a record the stack did not create, and gets no certificate for it
  Given the zone already holds an A, AAAA, or CNAME record at "photos.example.com", or an alias to another distribution
  When the cloud operator sets up the domain and waits for the update
  Then the update fails and names the existing record, such as "A photos.example.com (192.0.2.10)"
  And the account holds no new certificate for the domain
  And the existing record is unchanged
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain.test.ts` › "assertNoForeignRecords refuses an A record at the name, and names it", "assertNoForeignRecords refuses an AAAA record at the name, and names it", "assertNoForeignRecords refuses a CNAME at the name, and names it", "assertNoForeignRecords refuses an alias to another distribution at the name, and names it", "assertNoForeignRecords passes an alias to this deployment's own distribution, A or AAAA", and "assertNoForeignRecords makes no ACM call, so a refusal requests no certificate" (unit). `e2e-aws-custom-domain/src/custom-domain.test.ts` › "refuses a domain that already holds a record the stack did not write" (tier-3 AWS, cloud) drives the install, but the suite was not run at baseline.

### A domain hosted elsewhere

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-097] A cloud operator setting up a domain hosted elsewhere gets the validation record and the CNAME to add after the first update
  Given the DNS of "photos.example.org" lives at another provider
  When the cloud operator approves "photos.example.org" in the Set up dialog and waits for the first update to finish
  Then the section says to add two records at the DNS provider, then press "Check now"
  And the section shows the validation CNAME record and the CNAME from the domain to the cloud's cloudfront.net name, each with copy buttons
  And the cloud does not answer on the domain yet
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain.test.ts` › "ensureExternalCertificate requests a tagged certificate in us-east-1 and returns its validation record" (unit); `packages/admin-installer/__tests__/custom-domain-plan.test.ts` › "planCustomDomain attaches nothing while the external certificate awaits validation" (unit); `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "external mode, certificate pending shows the validation record and the CNAME together" (unit, local) checks both records. No test checks the section's instruction or the copy buttons.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-098] A cloud operator checks whether the certificate is issued and whether the domain points at the cloud
  Given the cloud operator sees the records for a domain hosted elsewhere in the Custom Domain section
  When the cloud operator clicks "Check now"
  Then the section says "The certificate is issued." or "The certificate is not issued yet (<status>)."
  And the section says "<domain> points at the cloud." or "<domain> does not point at the cloud yet. DNS changes can take a while to spread."
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-route.test.ts` › "POST /check reads the certificate's status in us-east-1 with the operator's credentials", "POST /check finds a CNAME to the distribution", and "POST /check says so when no install has acted on a domain" (unit, local); `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "external mode, awaiting DNS says the CNAME is missing and shows it" (unit, local). No test checks the certificate sentences.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-099] A cloud operator can finish a domain hosted elsewhere only after both checks pass, and Finish attaches it in a second update
  Given the cloud operator sees the records for a domain whose certificate awaits validation
  And the certificate is not issued yet, or the domain does not point at the cloud yet
  When the cloud operator clicks "Check now"
  Then "Finish" stays disabled
  When the cloud operator clicks "Check now" after the certificate is issued and the domain points at the cloud
  Then the section says to press "Finish", and "Finish" becomes enabled
  And clicking "Finish" runs the second update, which makes the domain the cloud's address
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "external mode, certificate pending keeps Finish off while neither check passes", "keeps Finish off while only the certificate is issued", "keeps Finish off while only the CNAME resolves", and "turns Finish on when both pass, and Finish runs the install" (unit, local); `packages/admin-installer/__tests__/custom-domain-plan.test.ts` › "planCustomDomain makes an issued external domain canonical once DNS points at the distribution" (unit).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-100] A cloud operator whose attached domain is not yet pointed at by DNS keeps the cloudfront.net address as the cloud's address
  Given the certificate for a domain hosted elsewhere is issued
  And the domain's CNAME does not point at the cloud yet
  When the cloud operator runs a cloud update, which attaches the certificate
  Then the section says the cloud is ready to answer on the domain, but links keep the cloud's cloudfront.net address
  And the section shows the CNAME to add and offers "Check now" and "Finish"
  And links the cloud hands out keep the cloudfront.net address until a later update after the CNAME resolves
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain-plan.test.ts` › "planCustomDomain attaches an issued certificate but stays off the domain until DNS points at it" (unit); `packages/admin-installer/__tests__/cloudfront-custom-domain.test.ts` › "external mode before DNS points at the distribution keeps the cloudfront.net name canonical, so links resolve" (unit); `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "external mode, awaiting DNS says the CNAME is missing and shows it" and "external mode, awaiting DNS turns Finish on once the CNAME resolves" (unit, local).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-101] A cloud operator with a flattened DNS record sees the domain pointing at the cloud only when every address belongs to CloudFront
  Given the DNS provider serves the domain as a flattened record with addresses instead of a CNAME
  When the cloud operator clicks "Check now"
  Then the section says the domain points at the cloud only when every address has a CloudFront reverse name
  And the section says the domain does not point at the cloud yet for an address outside CloudFront, an address with no reverse name, a CNAME to another distribution, or a name that does not resolve
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain-plan.test.ts` › "domainPointsAt accepts a CNAME to the distribution, whatever its case and trailing dot", "domainPointsAt accepts a flattened record whose addresses are all CloudFront edges", "domainPointsAt refuses a flattened record with any address outside CloudFront", "domainPointsAt refuses an address with no reverse name", "domainPointsAt refuses a CNAME to a different distribution, though its edges are CloudFront's", and "domainPointsAt refuses a name that does not resolve" (unit); `apps/admin-web/__tests__/custom-domain-route.test.ts` › "POST /check accepts a flattened record whose addresses are CloudFront edges" (unit, local).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-102] A cloud operator who reruns the update while the certificate awaits validation gets no second certificate
  Given a domain hosted elsewhere has a certificate that awaits validation
  When the cloud operator runs another update before the validation record appears
  Then the cloud operator finds one certificate for the domain in the account
  And the section shows the same validation record
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain.test.ts` › "ensureExternalCertificate makes no new request on a rerun while this deployment's certificate is pending" and "ensureExternalCertificate reuses this deployment's certificate for the domain and reports it issued" (unit).
- **Notes:** A certificate whose validation timed out is replaced ("ensureExternalCertificate replaces a certificate whose validation timed out").

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-103] A cloud operator sees an active external domain's CNAME and a warning that a reinstall changes the value
  Given a domain hosted elsewhere is the cloud's address
  When the cloud operator opens the Custom Domain section
  Then the section says "The cloud answers on <domain>."
  And the section shows the CNAME record and says "A reinstall of the cloud changes the value."
  And the section offers "Check now" and "Remove"
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "Remove, for an attached external domain asks to delete the domain's CNAME and keep the validation record" (unit, local) opens the section on an active external domain and finds "Remove". No test checks the section's sentences, the CNAME record, or "Check now".

### Using the domain

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-104] A member signs in, stays signed in, and signs out on both the custom domain and the cloudfront.net address
  Given the member's deployment answers on the custom domain "photos.example.com" and on its cloudfront.net address
  When the member opens a cloud app on the custom domain, or on the cloudfront.net address
  Then the app's sign-in page opens on the same host
  And the sign-in finishes on the host where it began
  And the member stays signed in on that host after the session refreshes, and signs out there
```

- **Coverage:** `packages/admin-installer/__tests__/signed-out-redirect.test.ts` › "the viewer's host reaches the sign-in routes, which return before any app-surface check", "the viewer's host reaches an app page and the reserved data plane", and "the viewer's host overwrites a value the viewer sent" (unit); `packages/admin-installer/__tests__/custom-domain-plan.test.ts` › "signingHosts keeps an attached domain that is not canonical yet, so sign-in works on it" (unit). `e2e-aws-custom-domain/src/custom-domain.test.ts` › "signs in, refreshes and signs out on the custom domain" and "signs in, refreshes and signs out on the cloudfront.net name" (tier-3 AWS, cloud, real browser) assert every clause, but the suite was not run at baseline.
- **Notes:** Sessions stay per host: a member who moves from one host to the other signs in once more. Generic cloud-app sign-in belongs to [users-and-access.md](users-and-access.md). CLOUD-SETUP-144 states the refusal of a refresh from another site.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-SETUP-144] A cloud operator finds that a page on another site cannot refresh a member's session on either host
  Given the cloud answers on "photos.example.com" and on its cloudfront.net address
  And a member is signed in to a cloud app on one of the hosts
  When the cloud operator sends a session refresh for that host from a page on another site
  Then the cloud operator gets a refusal, and the member's session is not refreshed
```

- **Notes:** Split from CLOUD-SETUP-104 in the point-of-view pass.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-105] An app developer sees OAuth discovery on each host name that host
  Given the app developer's app declares a delegated route, and the cloud answers on "photos.example.com"
  When the app developer calls the route with no token from an outside client, on either host
  Then the client gets a bare 401
  And the protected-resource metadata on that host names the route on that same host
  And the metadata names the gateway's own address as the authorization server
```

- **Coverage:** `packages/admin-installer/builtin-apps/cloud-data-server/__tests__/oauth-metadata.test.ts` › "protected resource metadata names the resource on the viewer's host and the issuer" (unit); `e2e-aws/src/journey.test.ts` › "serves discovery: a bare 401, then both metadata documents" (tier-3 AWS, cloud) on the cloudfront.net address only. `e2e-aws-custom-domain/src/custom-domain.test.ts` › "serves OAuth discovery on the custom domain, naming that host" (tier-3 AWS, cloud) covers the custom domain, but the suite was not run at baseline.
- **Notes:** The rest of the delegation flow belongs to [users-and-access.md](users-and-access.md).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-106] An app developer gets signed file links on the custom domain, and changed links are refused
  Given the app developer's cloud app runs on a cloud that answers on "photos.example.com"
  When the app asks for a link to a member's file
  Then the link's host is "photos.example.com"
  And opening the link returns the file's bytes
  And a link with a changed signature is refused
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain-plan.test.ts` › "signingHosts lists the canonical custom domain first, then the cloudfront.net name" (unit). `e2e-aws-custom-domain/src/custom-domain.test.ts` › "mints signed URLs on the custom host, and the edge enforces them" (tier-3 AWS, cloud) asserts each clause, but the suite was not run at baseline.
- **Notes:** Signed links on the cloudfront.net address belong to [shared-data.md](shared-data.md) (SHARED-088, SHARED-100).

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-107] A cloud operator sets up, changes, or removes a custom domain without breaking the cloudfront.net address
  Given links and sign-in sessions exist on the cloud's cloudfront.net address
  When the cloud operator sets up, changes, or removes a custom domain
  Then sign-in and links on the cloudfront.net address keep working throughout, with no redirect
```

- **Coverage:** `packages/admin-installer/__tests__/cloudfront-custom-domain.test.ts` › "Route53 mode makes the custom domain canonical and keeps exporting the cloudfront.net name" (unit); `packages/admin-installer/__tests__/custom-domain-plan.test.ts` › "signingHosts lists the cloudfront.net name once when no domain is attached" (unit). `e2e-aws-custom-domain/src/custom-domain.test.ts` › "signs in, refreshes and signs out on the cloudfront.net name" (tier-3 AWS, cloud) covers one point in time, and the suite was not run at baseline.
- **Notes:** CLOUD-SETUP-145 states what a member sees.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-SETUP-145] A member keeps using links and sign-in on the cloudfront.net address while the custom domain changes
  Given the member holds links and a sign-in on the cloud's cloudfront.net address
  And the cloud's custom domain gets set up, changed, or removed
  When the member opens one of those links, or signs in on the cloudfront.net address, before, during, or after the change
  Then the link opens and the sign-in works on the cloudfront.net address, with no redirect
```

- **Notes:** Split from CLOUD-SETUP-107 in the point-of-view pass.

### Changing and removing a domain

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-108] A cloud operator who changes to a second domain finds the first domain's records and certificate deleted
  Given "photos.example.com" is the cloud's address through the account's Route53 zone
  When the cloud operator sets up "pics.example.com" and waits for the update to finish
  Then "pics.example.com" is the cloud's address
  And the zone holds no record for "photos.example.com" and the account holds no certificate for it
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain.test.ts` › "deleteUnusedCertificates deletes this deployment's certificates of both modes except those kept" (unit); `packages/admin-installer/__tests__/custom-domain-plan.test.ts` › "planCustomDomain with a certificate already on the distribution swaps the held certificate out when a new domain attaches" (unit). `e2e-aws-custom-domain/src/custom-domain.test.ts` › "changes to the second name and deletes everything of the first" (tier-3 AWS, cloud) asserts each clause, but the suite was not run at baseline.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-109] A cloud operator removing an active domain is warned that links sent with the domain stop working
  Given "photos.example.com" is the cloud's address
  When the cloud operator clicks "Remove"
  Then the dialog "Remove photos.example.com" says the cloud stops answering on the domain and every link sent with it stops working
  And the dialog says links on the cloudfront.net address keep working
  And nothing changes until the cloud operator clicks "Remove" in the dialog, while "Keep it" closes the dialog
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "Remove names the Route53 record it deletes and the one it keeps, and removes only once approved" (unit, local) checks the broken-links warning and that nothing changes until "Remove"; "Remove lists the provider's records for an external domain, and breaks no link before it is active" (unit, local) checks that "Keep it" closes the dialog. No test checks the sentence that cloudfront.net links keep working.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-110] A cloud operator who removes a Route53 domain finds its A record deleted, and the validation record and an unused certificate kept
  Given "photos.example.com" is the cloud's address through the account's Route53 zone
  When the cloud operator removes the domain and waits for the update to finish
  Then the Remove dialog said the update deletes the A record, keeps the validation record so the certificate keeps renewing, and keeps the certificate unused at no cost
  And the zone holds no A record for the domain and still holds its validation record
  And the cloud's address returns to its cloudfront.net name
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "Remove names the Route53 record it deletes and the one it keeps, and removes only once approved" (unit, local); `packages/admin-installer/__tests__/cloudfront-custom-domain.test.ts` › "a kept certificate after a removal drops the alias but keeps the certificate on the distribution", "a kept certificate after a removal keeps the Route53-mode certificate and its validation record, so ACM keeps renewing it", and "a kept certificate after a removal writes no A record, and keeps the cloudfront.net name canonical" (unit). `e2e-aws-custom-domain/src/custom-domain.test.ts` › "removes the domain and returns to the cloudfront.net name" (tier-3 AWS, cloud) asserts the AWS side, but the suite was not run at baseline.
- **Notes:** The 2026-11-06 design notes planned to delete the certificate on removal. The 2026-11-07 notes reversed that, because ACM holds a certificate for up to an hour after CloudFront releases it.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-111] A cloud operator removing an external domain is told which provider record to delete and which validation record to keep
  Given a domain hosted elsewhere is the cloud's address
  When the cloud operator clicks "Remove"
  Then the dialog says the update changes no DNS records
  And the dialog asks the cloud operator to delete the domain's CNAME at the DNS provider afterwards
  And the dialog asks the cloud operator to keep the validation record, so the certificate keeps renewing
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "Remove, for an attached external domain asks to delete the domain's CNAME and keep the validation record" (unit, local) checks both records. No test checks the sentence that the update changes no DNS records.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-112] A cloud operator who cancels a domain that never went live breaks no link, and its certificate is deleted
  Given a domain hosted elsewhere awaits certificate validation
  When the cloud operator clicks "Cancel" and confirms "Remove"
  Then the dialog says links never used the domain, so no link stops working
  And the dialog lists the two CNAME records to delete at the DNS provider if the cloud operator added them
  And after the update, the cloud operator finds the certificate requested for the domain deleted
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "Remove lists the provider's records for an external domain, and breaks no link before it is active" (unit, local); `packages/admin-installer/__tests__/custom-domain.test.ts` › "deleteUnusedCertificates deletes this deployment's certificates of both modes except those kept" (unit). No test deletes a real certificate.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-113] A cloud operator who sets up a removed domain again reuses its kept certificate
  Given the cloud operator removed "photos.example.com", and the cloud kept its certificate
  When the cloud operator sets up "photos.example.com" again
  Then the domain becomes the cloud's address again
  And the cloud operator finds no new certificate for the domain in the account, only the kept one
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain-config.test.ts` › "customDomainInstallInput holds the kept certificate after a removal, and keeps its domain in play" (unit); `packages/admin-installer/__tests__/custom-domain.test.ts` › "ensureExternalCertificate reuses this deployment's certificate for the domain and reports it issued" (unit) for a domain hosted elsewhere. No test sets a removed Route53 domain up again.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-114] A cloud operator whose domain removal has not run yet sees the domain's state and Update cloud
  Given the cloud operator cleared the domain, and the update that removes it did not finish
  When the cloud operator opens the Custom Domain section
  Then the section says the cloud never served the domain, still accepts it with no link using it, or still answers on it, whichever applies
  And the section offers "Update cloud" to finish the removal
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "a cleared domain whose removal has not run yet describes a pending-validation domain truthfully", "describes a awaiting-dns domain truthfully", and "describes a active domain truthfully" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-115] A cloud operator removes a saved domain that no update applied, without running an update
  Given the cloud operator saved a domain, and no update has acted on it
  When the cloud operator opens the Custom Domain section
  Then the section says the cloud has not set up the domain yet and to press "Set up" to run the update
  When the cloud operator clicks "Remove"
  Then the domain is cleared and no update runs
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-section.test.tsx` › "a saved domain no install has applied offers Remove, which clears the domain without running the install" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-116] A cloud operator cannot set up a different domain until a failed attempt at the first is cleaned up
  Given an update for "photos.example.com" failed and may have left records behind
  When the cloud operator sets up "pics.example.com"
  Then the section says "An install for photos.example.com failed and may have left records behind. Remove photos.example.com and update the cloud, then set another domain."
  And nothing is saved
  When the cloud operator sets up "photos.example.com" again, or removes it
  Then the change is accepted
```

- **Coverage:** `apps/admin-web/__tests__/custom-domain-route.test.ts` › "PUT after a failed attempt at another domain refuses a new domain until the attempt is cleaned up", "PUT after a failed attempt at another domain allows a retry of the same domain, and clearing it", and "POST /zone refuses a new domain while a failed attempt waits, before it reads Route53" (unit, local); `packages/admin-installer/__tests__/custom-domain-config.test.ts` › "nextCustomDomainConfig refuses to start on another domain while a failed attempt waits" (unit). No test checks the message in the section.

## Tearing down

The cloud operator runs the teardown scripts from a terminal with the AWS CLI, signed in with administrator credentials for the deployment's account. `scripts/teardown-cloud-apps.sh` run on its own belongs to [app-lifecycle.md](app-lifecycle.md).

### Removing the cloud data server

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-117] A cloud operator who runs teardown-cloud-data-server.sh without --prefix or --region is asked in a terminal and refused unattended
  Given this computer's configuration describes a deployment
  When the cloud operator runs "scripts/teardown-cloud-data-server.sh" without "--prefix" in an interactive shell
  Then the script says no prefix was given, names the configuration's prefix for reference, and asks "Enter the stack prefix to tear down:"
  And the same happens for a missing "--region"
  When the cloud operator runs the script with "--yes", or from a shell with no terminal, and leaves a flag out
  Then the script exits with "Error: a stack prefix is required; pass --prefix <stack-prefix>." or the matching region error
  And nothing is deleted
```

- **Coverage:** none. Every test of the script passes both flags.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-118] A cloud operator sees the resources the teardown would remove before it asks, and a dry run deletes nothing
  Given the deployment holds cloud apps and the cloud data server
  When the cloud operator runs the teardown with "--dry-run"
  Then the script says "DRY RUN: nothing will be deleted."
  And the script lists the gateway, the functions, the log groups, the database, the distribution, the certificates, and the cloud apps it would remove
  And nothing is deleted
  When the cloud operator runs the teardown without "--dry-run" and without "--yes"
  Then the same list appears before the question "Continue? [y/N]", and any answer but "y" prints "Aborted."
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-cloud-data-server-script.test.ts` › "teardown-cloud-data-server.sh lists the resolved resources on --dry-run, including the apps, and deletes nothing" (unit, against a stubbed AWS CLI) checks the listed resources and that nothing is deleted. No test checks the "DRY RUN" line, runs without "--yes", or answers the question.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-119] A cloud operator who tears down a cloud data server removes its cloud apps first, and leaves another deployment's resources untouched
  Given the account holds the target deployment and another deployment
  When the cloud operator tears down the target's cloud data server
  Then the target's cloud apps are gone, and then its gateway, functions, log groups, jobs rule, database, file bucket, billing bucket, cost report, signing keys, and role
  And every resource of the other deployment is unchanged
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-cloud-data-server-script.test.ts` › "teardown-cloud-data-server.sh deletes the target's resources and never changes the other deployment's" and "teardown-cloud-data-server.sh deletes every signing SecureString the install writes" (unit, against a stubbed AWS CLI) check that the target's resources are gone and the other deployment's are unchanged. No test checks that the cloud apps go first, or that the role and the billing bucket go.
- **Notes:** A database with no deployment tag stays when it is deletion-protected, and the script prints the command that tags it. The script deletes an untagged database without protection as a disposable test database.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-120] A cloud operator keeps a deletion-protected database unless passing --force or answering y, and the teardown still succeeds
  Given the deployment's database has deletion protection, as every real install leaves it
  When the cloud operator runs the teardown without "--force"
  Then the script asks "Cluster <id> has deletion protection enabled. Disable it and delete the cluster? [y/N]"
  And any answer but "y" warns that the cluster stays and says to rerun with "--force" or answer "y"
  And the teardown still succeeds
  When the cloud operator passes "--force" or answers "y"
  Then the cloud operator finds the protection turned off and the database deleted
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-cloud-data-server-script.test.ts` › "teardown-cloud-data-server.sh keeps a protected cluster without --force, and that is not a failure" (unit, against a stubbed AWS CLI). No test answers the prompt or passes `--force` on a protected database.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-121] A cloud operator who reruns a partial teardown sees missing resources reported as not found, and the teardown succeeds
  Given an earlier teardown removed part of the deployment
  When the cloud operator runs the teardown again
  Then the script reports each missing resource as not found and keeps going
  And the teardown succeeds
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-cloud-data-server-script.test.ts` › "teardown-cloud-data-server.sh treats resources that are already gone as deleted" (unit, against a stubbed AWS CLI) checks that the teardown succeeds, but not the "not found" lines.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-122] A cloud operator whose teardown meets a failed delete or lookup sees the rest deleted, every failure listed, and an error exit
  Given AWS refuses to delete one of the deployment's resources, or a lookup fails
  When the cloud operator runs the teardown
  Then the script still deletes every other resource
  And the script lists each failure at the end and exits with an error
  And a failed lookup counts as a failure, never as nothing to delete
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-cloud-data-server-script.test.ts` › "teardown-cloud-data-server.sh reports a failed delete, still deletes the rest, and exits 1", "teardown-cloud-data-server.sh fails when a lookup fails, rather than reporting nothing to delete", "teardown-cloud-data-server.sh reports a failed lookup of the redirect function rather than skipping it", and "teardown-cloud-data-server.sh reports a failed delete of the delegation signing key" (unit, against a stubbed AWS CLI).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-123] A cloud operator sees the teardown retry throttled AWS calls and finish
  Given AWS throttles some of the teardown's calls
  When the cloud operator runs the teardown
  Then the script prints that each throttled call is retried after a wait
  And the teardown finishes with no failure once the throttling stops
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-cloud-data-server-script.test.ts` › "teardown-cloud-data-server.sh retries a throttled cluster lookup and finishes" and "teardown-cloud-data-server.sh retries throttled CloudFront and S3 calls and finishes" (unit, against a stubbed AWS CLI); `packages/admin-installer/__tests__/teardown-bootstrap-script.test.ts` › "teardown-bootstrap.sh retries a throttled call and finishes when the throttling stops", "teardown-bootstrap.sh retries a throttled role listing and finishes", and "teardown-bootstrap.sh retries an S3 SlowDown while emptying a bucket and finishes" (unit, against a stubbed AWS CLI).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-124] A cloud operator finds the cloud's outputs cleared from this computer's configuration only after tearing down the deployment it describes
  Given this computer's configuration describes the deployment being torn down
  When the cloud operator runs the cloud data server teardown for that deployment and waits for it to finish
  Then the configuration no longer holds the cloud's address, its database, its file bucket, or its authorizer IDs
  And the dashboard no longer shows the deployed cloud
  When the cloud operator tears down a deployment with another prefix or region than the configuration describes
  Then the teardown leaves the configuration untouched and says so in its list
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-cloud-data-server-script.test.ts` › "teardown-cloud-data-server.sh strips every authorizer id the install writes into config.json" (unit) compares the script's list of keys to clear with the keys the install writes, without running the script. No test runs the teardown and reads the configuration, checks the untouched case, or checks the dashboard.

### Removing everything

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-125] A cloud operator must give teardown-bootstrap.sh --prefix and --region, which it never takes from the configuration
  Given this computer's configuration describes a deployment
  When the cloud operator runs "scripts/teardown-bootstrap.sh" without "--prefix" or "--region"
  Then the script names the configuration's values only for reference and asks for the missing value in an interactive shell
  And an unattended run exits with the error naming the missing flag, and nothing is deleted
```

- **Coverage:** none.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-126] A cloud operator sees every layer's resources in a bootstrap teardown dry run, and nothing is deleted
  Given the deployment holds cloud apps, the cloud data server, and the bootstrap layer
  When the cloud operator runs "scripts/teardown-bootstrap.sh --dry-run"
  Then the script lists the bootstrap stack, the state bucket, the stored passphrase, the certificates, the roles, the policies, and the Cognito pools
  And the script lists the cloud data server's and the cloud apps' resources
  And the script says whether the local configuration would be cleared
  And nothing is deleted
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-bootstrap-script.test.ts` › "teardown-bootstrap.sh lists every layer's resources on --dry-run and deletes nothing" (unit, against a stubbed AWS CLI) checks the pools, the certificates, the stored parameters, the lower layers' resources, and that nothing is deleted. No test checks the line about the local configuration.
- **Notes:** The tier-3 suites print this list before every run's teardown (`e2e-aws/src/journey.ts`), but they assert nothing about it.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-127] A cloud operator whose cloud data server teardown fails keeps the bootstrap layer
  Given AWS refuses part of the target's cloud data server teardown
  When the cloud operator runs "scripts/teardown-bootstrap.sh" for the target, which tears down the cloud data server first
  Then the script stops with an error
  And the bootstrap stack, the state bucket, the passphrase, and the Cognito pools are still there
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-bootstrap-script.test.ts` › "teardown-bootstrap.sh stops before the bootstrap layer when the cloud-data-server teardown fails" (unit, against a stubbed AWS CLI).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-128] A cloud operator who confirms the bootstrap teardown finds the bootstrap layer and the target's Cognito pools gone
  Given the target deployment's bootstrap stack and its resources outside CloudFormation exist
  When the cloud operator confirms "scripts/teardown-bootstrap.sh"
  Then the account no longer holds the stack, the state bucket, the stored passphrase, the certificates, the IAM roles and policies, or the target's Cognito pools
  And a rerun after the stack is already gone still deletes the target's pools, and leaves a pool of the same name that carries another deployment's tag
  And the only change the script makes to a pool before deleting it turns its deletion protection off
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-bootstrap-script.test.ts` › "teardown-bootstrap.sh deletes the target deployment and never changes the config's deployment", "teardown-bootstrap.sh finds pools by prefix name and tag once the stack is gone", and "teardown-bootstrap.sh updates a user pool only to turn deletion protection off" (unit, against a stubbed AWS CLI).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-129] A cloud operator cannot tear down a pool that another deployment's configuration names, and nothing is deleted
  Given this computer's configuration, or the home configuration, describes another deployment
  And a pool that the target's teardown would delete is one that configuration names
  When the cloud operator runs "scripts/teardown-bootstrap.sh" for the target
  Then the script says "Error: Cognito pool <id> belongs to the deployment that <config> describes", adds "Nothing was deleted.", and exits with an error
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-bootstrap-script.test.ts` › "teardown-bootstrap.sh stops before deleting anything when a found pool is one the other deployment's config names" and "teardown-bootstrap.sh with STARKEEP_DIR set to the target's own config, as the e2e harness sets it stops before deleting anything when a found pool is one the home config names" (unit, against a stubbed AWS CLI).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-130] A cloud operator sees the teardown fail when another deployment's pool vanishes during the run, and not for a pool already gone
  Given a configuration names another deployment's pool
  When the cloud operator runs "scripts/teardown-bootstrap.sh" while that pool exists at the start and is gone at the end
  Then the teardown fails and names the pool
  When the cloud operator runs it after that pool was already gone
  Then the teardown does not report it as a failure
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-bootstrap-script.test.ts` › "teardown-bootstrap.sh fails when a config pool that existed at the start is gone at the end", "teardown-bootstrap.sh does not blame the teardown for a config pool that was already gone", and "teardown-bootstrap.sh with STARKEEP_DIR set to the target's own config, as the e2e harness sets it fails when a home-config pool that existed at the start is gone at the end" (unit, against a stubbed AWS CLI).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [CLOUD-SETUP-131] A cloud operator is warned when another deployment lives in the target's region
  Given a configuration names a deployment whose user pool sits in the target's region
  When the cloud operator runs "scripts/teardown-bootstrap.sh"
  Then the list starts with "WARNING: <region> also holds the deployment that <config> describes" and asks the cloud operator to check that "--prefix" names the deployment to remove
  And the warning says test deployments belong in a region that no live deployment uses
  And the run continues
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-bootstrap-script.test.ts` › "teardown-bootstrap.sh warns when another deployment's config names a pool in the target's region" and "teardown-bootstrap.sh does not warn when no other deployment's pool is in the target's region" (unit, against a stubbed AWS CLI).

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-132] A cloud operator who tears down the deployment this computer describes finds the cloud configuration cleared and the app folder list kept
  Given this computer's configuration names a stack prefix and a region
  When the cloud operator tears down the deployment with that prefix and region
  Then the script ends with "Cloud config cleared; local appParentDirs preserved."
  And admin-web still lists the apps from the same app folders
  When the cloud operator tears down a different deployment
  Then the configuration is unchanged
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-bootstrap-script.test.ts` › "teardown-bootstrap.sh deletes the config's own deployment when the config describes the target", "teardown-bootstrap.sh deletes the target deployment and never changes the config's deployment", and "teardown-bootstrap.sh with STARKEEP_DIR set to the target's own config, as the e2e harness sets it deletes the target, clears the run's config and leaves the home config's pools" (unit, against a stubbed AWS CLI) check the "Cloud config cleared" line. No test reads the configuration afterward, so neither the kept app folders nor the untouched configuration of another deployment is checked.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [CLOUD-SETUP-133] A cloud operator removes a protected database in the bootstrap teardown only with --force, and is never asked about it
  Given the deployment's database has deletion protection
  When the cloud operator runs "scripts/teardown-bootstrap.sh" without "--force"
  Then the script asks no question about the database
  And the cloud operator finds the database still in the account after the rest of the deployment is gone
  When the cloud operator passes "--force"
  Then the account no longer holds the database either
```

- **Coverage:** none. `packages/admin-installer/__tests__/teardown-bootstrap-script.test.ts` runs no protected database through the bootstrap teardown.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-134] A cloud operator who tears down a deployment the account no longer holds sees the teardown succeed
  Given the account holds no resource of the target deployment
  When the cloud operator runs "scripts/teardown-bootstrap.sh" for it
  Then every step reports nothing to delete
  And the teardown succeeds
```

- **Coverage:** `packages/admin-installer/__tests__/teardown-bootstrap-script.test.ts` › "teardown-bootstrap.sh succeeds against an account that holds nothing of the target" and "teardown-bootstrap.sh reports a pool it cannot delete and exits 1, but treats a missing pool as deleted" (unit, against a stubbed AWS CLI). The first test checks only the exit status. The second checks the "not found" line for one pool only.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [CLOUD-SETUP-135] A cloud operator who tears down a deployment with a custom domain finds no certificate left behind
  Given a custom domain is the cloud's address, or a removed domain's certificate is kept
  When the cloud operator tears the deployment down
  Then the account holds no certificate tagged with the deployment
  And the zone holds no record of the domain that the install wrote
```

- **Coverage:** `packages/admin-installer/__tests__/custom-domain.test.ts` › "deleteUnusedCertificates deletes every certificate after an uninstall, and none of another deployment's" (unit). `e2e-aws-custom-domain/src/custom-domain.test.ts` › "tears the stack down with a domain attached and leaves nothing of it" (tier-3 AWS, cloud) asserts both clauses, but the suite was not run at baseline.

## Test deployments beside a live one

The cloud operator who runs the cloud test suites against the same AWS account as a live deployment meets these guards.

```gherkin
@cloud
@intent:unclear @coverage:partial
Scenario: [CLOUD-SETUP-136] A cloud operator cannot start a cloud test suite without a region, and is told one that no live deployment uses
  Given STARKEEP_AWS_E2E_REGION is not set
  When the cloud operator starts a cloud test suite
  Then the suite stops with "STARKEEP_AWS_E2E_REGION is not set. The cloud suites have no default region for the test stack."
  And the message names each live deployment this computer's configurations describe, with its region, or says that none was found
  And the message gives the command that sets a region that no live deployment uses
```

- **Notes:** Maintainer design notes (live Cognito teardown postmortem, 2026-11-15) name the shared account and region as a root cause, but record no decision on this guard.
- **Coverage:** `e2e-aws/src/region.unit.test.ts` › "testRegion refuses an unset region and names the live region and a command that sets another", "testRegion suggests a region that no live deployment uses", "testRegion refuses an unset region when no live deployment is configured", "liveDeployments reads the region from the user pool ID of the home config and STARKEEP_DIR's config", and "liveDeployments skips a missing config, a config with no cloud deployment and an unreadable one" (unit). No test checks the message's "none was found" sentence.

```gherkin
@cloud
@intent:unclear @coverage:partial
Scenario: [CLOUD-SETUP-137] A cloud operator who points a test suite at a live deployment's region gets a warning that names the deployment and the fix
  Given STARKEEP_AWS_E2E_REGION names the region of a live deployment
  When the cloud operator starts a cloud test suite
  Then the suite prints a warning that names the live deployment and explains that a teardown with the wrong prefix would reach it
  And the warning says to tear down the test stack and set another region in .env.local
  And the run continues
  When the cloud operator starts a cloud test suite in a region that holds no live deployment
  Then the suite prints no warning
```

- **Coverage:** `e2e-aws/src/region.unit.test.ts` › "testRegion returns the live region with a warning that names the deployment and the fix" and "testRegion returns a region that no live deployment uses, with no warning" (unit) check the named deployment, the suggested region, and the run going on. No test checks the warning's explanation of the risk or its advice to tear down the test stack.

```gherkin
@cloud
@intent:unclear @coverage:partial
Scenario: [CLOUD-SETUP-138] A cloud operator can run the custom-domain suite only in a dedicated, delegated test zone, and a run writes no name outside its own
  Given the cloud operator set STARKEEP_AWS_CUSTOM_DOMAIN_ZONE to a zone that does not exist, that public DNS does not delegate, or that holds records the suite did not write, or a live configuration uses the test prefix
  When the cloud operator starts the custom-domain suite
  Then the suite stops before it installs anything and names the reason
  And after any run, the cloud operator finds no record the run wrote at the zone's apex, at another name in the zone, at another run's name, or outside the zone
```

- **Coverage:** `e2e-aws-custom-domain/src/zone.unit.test.ts` › "TestZoneWriter refuses the test zone's apex before any request", "TestZoneWriter refuses another name in the test zone before any request", "TestZoneWriter refuses another run's name before any request", "TestZoneWriter refuses a name outside the test zone before any request", "TestZoneWriter refuses a parent zone's name that merely contains the prefix before any request", "foreignToSuite accepts the apex NS and SOA records and any run's records", and "foreignToSuite names everything else, so a live zone is refused" (unit). `e2e-aws-custom-domain/src/custom-domain.test.ts` › "refuses to start anywhere but a dedicated, delegated test zone" (tier-3 AWS, cloud) checks the preconditions, but the suite was not run at baseline.

```gherkin
@cloud
@intent:unclear @coverage:none
Scenario: [CLOUD-SETUP-139] A cloud operator cannot create a test zone for a name delegated elsewhere, or delete one that still holds records
  Given the cloud operator wants a test zone for the custom-domain suite
  When the cloud operator runs "scripts/setup-e2e-dns-zone.sh example.com" for a name public DNS already delegates
  Then the script says public DNS already delegates the name to other name servers and suggests a new subdomain such as "e2e.example.com"
  And the script creates no zone
  When the cloud operator runs "scripts/setup-e2e-dns-zone.sh --delete e2e.example.com" while the zone holds records besides NS and SOA
  Then the script lists the records, says a test run may still be using the zone, and deletes nothing
```

- **Coverage:** none.
