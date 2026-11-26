# Users and access

This file specifies who may do what on a Starkeep deployment, for members, cloud operators, local operators, and app developers. A cloud operator manages accounts and roles in admin-web's cloud sections, and signs in once on a computer for admin-web, the `starkeep` command, and the installer scripts. A member signs in to cloud apps in a browser and signs in to phone apps. A local operator signs a computer in through admin-web. An app developer guards an app's own routes, signs the app's requests to the data servers, and relies on the type grants an install gives the app. The scope covers cloud operator rights and the data group, account management, every sign-in surface, the cut that keeps members' data apart, app credentials and type grants, outside-client tokens and OAuth for MCP clients, and the rule that local surfaces stay on this machine.

Related files:

- [cloud-setup.md](cloud-setup.md): the cloud operator's first account, the cloud operator's sign-in at the setup wizard, custom-domain sign-in and discovery, and teardown.
- [app-lifecycle.md](app-lifecycle.md): installing and uninstalling apps, the install consent dialog, mobile-only registration, and an app's signing credential across a reinstall.
- [shared-data.md](shared-data.md): shared records and types, the grant rules unique to shared data, local file links, and public links on every channel.
- [local-data-server.md](local-data-server.md): joining a cloud by address, the This Machine card's layout and offline states, and watched folders.
- [sync.md](sync.md): what each device's exchange carries once access is granted.
- [app-data.md](app-data.md): app rows, scheduled-job tokens, and the credential vault.
- [app-development.md](app-development.md): the app client and SDK as a whole.

## Roles and the data library

An account can hold cloud operator rights, belong to the data group, or both. Cloud operator rights let the account sign in to admin-web's cloud sections and manage accounts. The data group gives an account a data library of its own. Every account with cloud operator rights also holds a library of its own.

### Cloud operators and members

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-001] A member uses every cloud app installed on the deployment
  Given a cloud operator installed Photos and Probe in the cloud
  And a member belongs to the data group only
  When the member signs in to each app in a browser
  Then the member sees each app's pages with the member's own data
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-002] A local operator whose account lacks cloud operator rights cannot sign in to admin-web
  Given the local operator holds an account that can use apps but has no cloud operator rights
  When the local operator signs in from admin-web's dashboard on the sign-in page with the account's email and password
  Then the browser returns to admin-web, which shows "Sign-in did not finish: This account has no admin rights on this cloud. Ask an admin to make you one."
  And admin-web shows none of its cloud sections to the local operator
```

- **Notes:** an account in no group at all meets the same refusal. ACCESS-194 states the same refusal at the cloud setup wizard's sign-in step, and ACCESS-200 in the terminal.

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-194] A cloud operator who signs in at the setup wizard with an account that lacks cloud operator rights cannot start the deploy
  Given the cloud operator holds an account that can use apps but has no cloud operator rights
  And the cloud setup wizard's stack outputs step is done
  When the cloud operator clicks "Open the sign-in page" on the wizard's sign-in step and signs in there with that account
  Then the browser returns to the wizard, which shows "Sign-in did not finish: This account has no admin rights on this cloud. Ask an admin to make you one."
  And the cloud operator cannot start the deploy
```

- **Notes:** split from ACCESS-002 in the role relabel (2026-11-25).

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-003] A member receives no AWS credentials from a sign-in
  Given a member belongs to the data group only
  When the member offers the member's own sign-in token to the deployment's identity pool for AWS credentials
  Then the member receives no AWS credentials
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-178] A cloud operator receives AWS credentials from a sign-in with cloud operator rights
  Given the cloud operator holds an account with cloud operator rights
  When the cloud operator offers that account's sign-in token to the deployment's identity pool for AWS credentials
  Then the cloud operator receives AWS credentials
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-004] A member whose account has cloud operator rights and no data group membership sees the member's own library in a cloud app
  Given the member's account has cloud operator rights and does not belong to the data group
  When the member signs in to a cloud app in a browser
  Then the app shows the member's own records
  And the member sees no other member's records through the app
```

- **Notes:** the maintainer decided on 2026-11-24 that every account with cloud operator rights holds a library. `docs/data-roles-and-permissions.md` › "Accounts and groups" still states the older rule that cloud operator rights grant no data.

```gherkin
@cloud @local
@intent:confirmed
Scenario: [ACCESS-005] A member whose account also has cloud operator rights syncs and uses cloud apps like any member
  Given the member's account has cloud operator rights and belongs to the data group
  And a local operator signed the member's computer in with that account
  When the member opens Photos in the cloud
  Then the computer syncs the member's own library
  And Photos in the cloud shows the member's own photos
```

### The data library

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-006] A local operator whose account belongs to no group cannot sign a computer in
  Given the local operator's computer has joined a cloud
  And the local operator holds an account that belongs to no group
  When the local operator signs the computer in with that account in admin-web's This Machine section
  Then admin-web shows "This account has no library to sync. An admin can give it one in admin-web's Users section."
  And the computer stays signed out with sync off
  And a later sign-in with an account in the data group makes the computer's library that account's
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-007] A member whose account belongs to no group sees no data in a cloud app
  Given a member's account belongs to no group
  When the member signs in to a cloud app and opens a page that lists the member's records
  Then the member sees no records in the app
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-179] An app developer gets a forbidden answer for a signed-in account that belongs to no group
  Given an account that belongs to no group is signed in to an app developer's cloud app
  When the app asks the data server for the account's records
  Then the app receives a forbidden answer
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-008] A member removed from the data group stops syncing within fifteen minutes
  Given a member's computer is signed in and syncing
  And a cloud operator cleared the member's Data box in admin-web's Users section
  When the member keeps adding records on the computer
  Then within fifteen minutes the computer's next sync fails and records the member adds stay on the computer
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-009] A member added back to the data group syncs again without a new sign-in
  Given a cloud operator removed a member from the data group and the member's computer stopped syncing
  And the cloud operator ticked the member's Data box again
  When the member keeps the computer running
  Then the computer syncs again within fifteen minutes
  And the computer needs no new sign-in
```

## Managing accounts in admin-web

A cloud operator manages accounts in admin-web's Cloud Users section. Each action runs against the deployment's user pool with the cloud operator's sign-in.

### Listing and inviting

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-010] A cloud operator sees each account's groups in the Users section, with invited and disabled accounts marked
  Given the deployment has an account with cloud operator rights, a member who has signed in, and an account whose invitation is still unused
  When the cloud operator opens the Cloud Users section
  Then each account appears with its email address and an Admin box and a Data box that show its groups
  And the unused invitation's account carries the mark "Invited"
  And a disabled account carries the mark "Disabled"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-011] A cloud operator adds a user with chosen groups
  Given a cloud operator is signed in to admin-web
  When the cloud operator enters a new person's email address, ticks the groups, and chooses "Add user"
  Then admin-web shows "Created <email>. Cognito has emailed a temporary password."
  And the new account appears in the list with the chosen groups and the mark "Invited"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-180] A member whom a cloud operator invited receives an emailed temporary password
  Given a cloud operator added the member's email address in admin-web's Cloud Users section
  When the member checks the member's email
  Then the member finds an invitation email with a temporary password
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-012] A cloud operator cannot add a user whose address is not an email address
  Given a cloud operator is signed in to admin-web
  When the cloud operator enters "not-an-address" and chooses "Add user"
  Then admin-web shows "Enter the person's email address."
  And no new account appears in the list
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-013] A visitor cannot sign up without a cloud operator's invitation
  Given a visitor opens a cloud app's sign-in page
  When the visitor looks for a way to create an account on the managed login page
  Then the visitor finds no sign-up option
  And a sign-up request that the visitor sends straight to the user pool fails
```

### Changing roles

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-014] A cloud operator gives a member cloud operator rights, and removes them again
  Given the deployment has two enabled accounts with cloud operator rights, and a member
  When a cloud operator ticks the member's Admin box
  Then admin-web shows "Updated <email>." and the member's Admin box stays ticked
  When the cloud operator clears the Admin box again
  Then admin-web shows "Updated <email>." and the member's Admin box stays clear
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-181] A local operator whose account a cloud operator gave cloud operator rights signs in to admin-web until the rights are removed
  Given the local operator holds a member's account
  And a cloud operator ticked that account's Admin box in admin-web
  When the local operator signs in to admin-web with that account
  Then the local operator is signed in to admin-web
  When the local operator signs in again after the cloud operator cleared the Admin box
  Then admin-web refuses the sign-in as in ACCESS-002
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-015] The last enabled cloud operator cannot remove their own cloud operator rights
  Given the deployment has exactly one enabled account with cloud operator rights
  When the cloud operator who holds that account clears their own Admin box
  Then admin-web shows "This is the last admin. Make someone else an admin first."
  And the Admin box shows ticked again after the list reloads
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-016] A cloud operator can remove cloud operator rights from a disabled account but not from the last enabled one
  Given the deployment has one enabled account and one disabled account with cloud operator rights
  When a cloud operator clears the enabled account's Admin box
  Then admin-web shows "This is the last admin. Make someone else an admin first."
  When the cloud operator clears the disabled account's Admin box instead
  Then admin-web shows "Updated <email>." and the disabled account loses its cloud operator rights
```

### Disabling and enabling

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-017] A disabled member loses access to cloud data on every device
  Given a member is signed in on a computer, in a cloud app, and on a phone
  And a cloud operator chose "Disable" for the member
  When the member keeps using each device and the cloud app
  Then within fifteen minutes the member gets no more data from the cloud on any device or cloud app
  And each device asks the member to sign in again, an offline device when it next reaches the cloud
```

- **Notes:** the scenario covers only data fetched from the cloud. Data already on a device, including a browser's cache, stays readable there, because no central command reaches an offline device or forces a device to delete data it holds.

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-182] A cloud operator disables a member's account
  Given a cloud operator is signed in to admin-web
  When the cloud operator chooses "Disable" for a member
  Then admin-web shows "Disabled <email> and signed them out of every device."
  And the account carries the mark "Disabled"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-018] A local operator finds the computer signed out at its next start after a cloud operator disabled its account
  Given the local operator signed the computer in with a member's account
  And a cloud operator disabled that account
  When the local operator restarts the computer's local data server
  Then admin-web's This Machine section shows the computer signed out
  And records added on the computer afterwards stay on the computer
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-019] A cloud operator cannot disable their own account
  Given a cloud operator is signed in to admin-web
  When the cloud operator chooses "Disable" on their own account
  Then admin-web shows "You cannot disable your own account."
  And the account stays enabled
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-020] A cloud operator cannot disable the last enabled account with cloud operator rights
  Given the deployment has exactly one enabled account with cloud operator rights
  And a cloud operator is signed in to admin-web with another account
  When the cloud operator chooses "Disable" on that last enabled account
  Then admin-web shows "This is the last admin. Make someone else an admin first."
  And the account stays enabled
```

- **Notes:** a cloud operator who disables another account with cloud operator rights, while the cloud operator's own account stays enabled, succeeds.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-021] A cloud operator enables a disabled member's account again
  Given a cloud operator disabled a member's account
  When the cloud operator chooses "Enable" for the member
  Then admin-web shows "Enabled <email>. They sign in again on each device."
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-183] A member whose account a cloud operator enabled again signs in again on each device
  Given a cloud operator disabled a member's account and then chose "Enable" for the member
  When the member opens each device that held a sign-in
  Then each of the member's devices stays signed out until the member signs it in again
```

### Signing out everywhere

```gherkin
@local @cloud @mobile
@intent:confirmed
Scenario: [ACCESS-022] A member whom a cloud operator signed out of all devices loses every sign-in and keeps the account
  Given a member is signed in on a computer, in a cloud app, on a phone, and through an outside-client token
  And a cloud operator chose "Sign out all devices" for the member
  When the member keeps using each device, the cloud app, and the outside client
  Then within fifteen minutes the member gets no more data from the cloud on any device, cloud app, or outside client
  And each device asks the member to sign in again, an offline device when it next reaches the cloud
  And the member can sign in again at once with the same password
```

- **Notes:** the sign-out is best effort for data already on a device, as ACCESS-017's note says. No single device's sign-in can be ended alone. The token half of this outcome is ACCESS-146.

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-184] A cloud operator signs a member out of all devices and leaves the account enabled
  Given a cloud operator is signed in to admin-web
  When the cloud operator chooses "Sign out all devices" for a member
  Then admin-web shows "Signed <email> out of every device and app. Each one stops reaching the cloud within 15 minutes and asks them to sign in again."
  And the account carries no "Disabled" mark
```

### Resetting a password

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-023] A cloud operator resets a password and sees the temporary password once
  Given a cloud operator is signed in to admin-web
  When the cloud operator chooses "Reset password" for a member
  Then admin-web shows "New temporary password for <email>: <password>. Send it to them; they choose their own at their next sign-in. It is not shown again."
  And the temporary password does not appear again after the cloud operator leaves the page
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-024] A member keeps syncing after a cloud operator resets the member's password
  Given a member's computer is signed in and syncing
  And a cloud operator reset the member's password
  When the member keeps using the computer
  Then the computer keeps syncing without a new sign-in
```

- **Notes:** a cloud operator who suspects a stolen password follows the reset with "Sign out all devices" (ACCESS-022).

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-185] A cloud operator resets a member's password and the account stays enabled
  Given a cloud operator is signed in to admin-web
  When the cloud operator chooses "Reset password" for a member
  Then the member's account carries no "Disabled" mark
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-025] A local operator who signs a computer in after a password reset chooses a new password
  Given a cloud operator reset the password of the local operator's account and sent the local operator the temporary password
  When the local operator signs a computer in with the temporary password
  Then the sign-in page asks the local operator to choose a new password
  And the local operator signs in with the new password
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-026] A cloud operator gets a fresh, readable temporary password from each reset
  Given a cloud operator resets one member's password twice
  When the cloud operator reads the two temporary passwords
  Then the two passwords differ
  And each password works for the member's next sign-in
  And neither password contains a 0, O, 1, l, or I that a reader could confuse
```

### Removing a user

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-027] A cloud operator deletes a disabled member's account and cloud library after typing a confirmation
  Given a cloud operator disabled a member who no longer belongs on the deployment
  When the cloud operator chooses to delete the account in the Cloud Users section and types the confirmation
  Then the Cloud Users section no longer lists the account
  And the deployment no longer holds the member's cloud library
  And nobody can sign in with the member's email until a cloud operator creates the account again
```

- **Notes:** data already on the member's own devices stays there, as ACCESS-017's note says.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-176] A cloud operator cannot delete an account that is still enabled
  Given a member's account is enabled
  When a cloud operator views the member's row in the Cloud Users section
  Then the row offers no way to delete the account
  And the row offers "Disable"
```

## Signing in to cloud apps

A member signs in to a cloud app on the deployment's managed login page. The platform's sign-in routes start and finish the sign-in, and each app keeps its session in cookies scoped to the app.

### The sign-in page

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-028] A signed-out member who opens a Photos page lands on Photos' sign-in page
  Given a member holds no session for Photos in the cloud
  When the member opens a Photos page in a browser
  Then the member lands on Photos' own sign-in page
  And the member sees no Photos content before signing in
```

- **Notes:** a public-share viewer page, the app's static chunks, and its runtime config open without a session.

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-029] An app developer gets a 401 rather than a redirect for a page script's request after the session ends
  Given a member's tab of the app developer's cloud app stayed open after the session ended
  When the app's page script asks the app for data
  Then the script receives a 401 answer that it can read as "signed out"
  And the script never receives an HTML sign-in page in place of data
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-030] A member with a live session returns to Photos without seeing a sign-in form
  Given a member signed in to Photos earlier and the session is still live
  When the member lands on Photos' sign-in page
  Then the member returns to Photos without seeing a form
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-031] A member whose session a cloud app rejects sees the Sign in button instead of a loop
  Given a member's browser holds a session cookie that the app does not accept
  And the app sends the browser straight back to the sign-in page whenever the sign-in page restores that session
  When the member lands on the app's sign-in page
  Then the sign-in page shows its Sign in button within fifteen seconds of the first attempt
  And the browser does not bounce between the two pages again
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-032] A member sees the Starkeep star and the deployment's name on the managed login page in light and dark mode
  Given the member's deployment is named "Family Cloud"
  When the member opens the managed login page in light mode and then in dark mode
  Then the page shows the Starkeep star above the form and in the browser tab in both modes
  And the page shows "Family Cloud" under the star in each mode's heading color
  And a long name appears in a smaller font so that the name fits
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-033] A member finds no password form in a cloud app itself
  Given a member opens a cloud app's sign-in page
  When the member looks for a place to type a password
  Then the only path to sign in leads to the managed login page
  And a password that the member posts to the app's own session routes signs nobody in
```

### Starting and finishing sign-in

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-034] A member signs in on the managed login page and returns to the page they asked for
  Given a member opened a link to one of the member's photos in Photos while signed out
  When the member chooses Sign in and enters the account's email and password on the managed login page
  Then the browser returns to the photo the member asked for
  And Photos shows the member's own photos
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-035] A member cannot sign in to an app that is not installed
  Given no app called "notes" is installed on the deployment
  When a member opens a sign-in link for "notes"
  Then the browser shows "No app called notes is installed on this cloud."
  And the browser never reaches the managed login page
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-036] A member cannot sign in to Drive or the cloud data server, which have no browser surface
  Given the deployment runs Drive and the cloud data server
  When a member opens a sign-in link that names either one
  Then the browser shows "This sign-in link names no app."
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-037] A member cannot sign in through a link that returns outside the app
  Given Photos is installed on the deployment
  When a member opens a Photos sign-in link whose return address lies outside Photos' pages
  Then the browser shows "This sign-in link returns somewhere outside the app."
  And no sign-in starts
```

- A sign-in begun on the custom domain returns to the custom domain: see CLOUD-SETUP-104 in [cloud-setup.md](cloud-setup.md) (formerly ACCESS-038).

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-039] A member gets no session from a sign-in callback with a missing or mismatched state
  Given a member started a sign-in in one browser
  When the member opens a sign-in callback link that carries no state, or a state that this browser did not start
  Then the browser shows "This sign-in has expired or was started elsewhere. Start it again." or "This sign-in does not match the one this browser started."
  And the browser holds no new session for the app
```

- **Notes:** a callback whose session came from another pool client sets no cookie either.

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-040] A member sees a page, not a server error, when sign-in fails on the managed login page
  Given a member is signing in to a cloud app
  And the managed login page sends the browser back with an error, or the code exchange fails
  When the member submits the managed login page
  Then the browser shows a page that begins "Sign-in did not finish:" or says "Sign-in could not be completed. Start it again."
  And the page offers the way back to the app
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-041] A member sees that sign-in is not set up on a deployment without a sign-in page
  Given a deployment has no managed login domain configured
  When a member opens a sign-in link for an installed app
  Then the browser shows "Sign-in is not set up on this cloud yet."
```

### Staying signed in

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-042] A member stays signed in to a cloud app for weeks without signing in again
  Given a member signed in to Photos in a browser
  When the member comes back to Photos every few days for four weeks
  Then Photos opens each time without asking the member to sign in
  And the member signs in again after thirty days at the latest
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-043] A member whose session ended lands on the sign-in page, not an error page
  Given a member's long-lived session for Photos has expired or was ended
  When the member opens Photos
  Then the browser lands on Photos' sign-in page
  And the member sees no error page
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-044] A member signed in to one cloud app still signs in to another
  Given a member signed in to Photos and not to Probe on the same deployment
  When the member opens Probe in the same browser
  Then Probe asks the member to sign in
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-186] An app developer cannot read another app's session cookies from the app's pages
  Given a member signed in to Photos and not to Probe on the same deployment
  When the app developer's Probe pages read the browser's cookies
  Then Probe's pages cannot read Photos' session cookies
```

### Signing out

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-045] A member who signs out of a cloud app enters the email and password again at the next sign-in
  Given a member is signed in to Photos
  When the member signs out of Photos
  Then the member's next visit to Photos lands on the sign-in page
  And the next sign-in asks the member for the email and password again
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-046] A member who signs out returns to the app, or sees "signed out" when the app is unknown
  Given a member is signed in to a cloud app
  When the member signs out of the app
  Then the browser returns to the app's pages
  And a finished sign-out whose app the browser no longer remembers shows "You are signed out."
```

### What a session reaches

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-047] A member reaches Photos only through the deployment's CloudFront address, never the gateway's own hostname
  Given a member holds a live session for Photos
  When the member sends the session to Photos at the API gateway's own hostname
  Then the member receives a refusal instead of a Photos page
  And the same session opens Photos through the deployment's CloudFront address
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-048] A visitor with no session gets nothing from any app data path
  Given an app is installed in the cloud
  When a visitor with no sign-in asks the app for records, rows, or files on any data path
  Then the visitor receives a refusal on every path
  And only the app's liveness check answers without a sign-in
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-049] An app developer gets no data from a correctly signed request without a member's sign-in
  Given an app developer's app holds its own signing credential
  When the app signs a data request correctly and sends no member's sign-in beside it
  Then the app receives a not-authenticated answer
  And the app receives no records
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-050] A member cannot use a token from admin-web's, a computer's, or a phone's sign-in as a cloud app session
  Given a member holds a token from admin-web's sign-in, from a computer's sign-in, or from a phone's sign-in
  When the member presents the token to a cloud app as its session
  Then the member receives a refusal
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-187] An app developer gets no data by forwarding an admin-web, computer, or phone token beside a valid signature
  Given a member's token from admin-web's sign-in, from a computer's sign-in, or from a phone's sign-in reaches an app developer's cloud app
  When the app forwards the token to the data server beside a valid signature
  Then the app receives no data
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-051] A visitor with an expired, forged, or wrong-pool token sees a refusal, not a server error
  Given a visitor presents an expired token, an unsigned token, a token signed by an unknown key, or a token from another pool or client
  When the visitor asks a cloud app for a page or for data
  Then the visitor receives a not-authenticated or forbidden answer
  And the visitor never receives a server error
```

- **Notes:** an unreachable key endpoint also yields a refusal, not a server error.

### Guarding an app's own routes (app developer)

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-052] An app developer reaches the declared public paths and the platform defaults without a session
  Given an app developer declares a public path in the app's origin gate
  When the app developer asks, from a signed-out browser, for the app root, a file under "/_immutable/", the runtime config, the sign-in page, the session routes, or the declared path
  Then the app developer receives each answer without signing in
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-053] An app developer gets a sign-in page or a 401 on every undeclared path, server-rendered routes included
  Given an app developer declares no public paths beyond the defaults
  When the app developer asks, from a signed-out browser, for an undeclared API path or an undeclared server-rendered page
  Then a document request lands on the app's sign-in page
  And a script request receives a 401 with "Not authenticated"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-054] An app developer gets a 401 from the data proxy for a signed-out cloud request, which the proxy never signs
  Given an app developer builds the app's data proxy with a session check
  When the app developer sends a signed-out request through the proxy in the cloud
  Then the app developer receives a 401
  And the request never reaches the data server with the app's signature
```

- **Notes:** an app developer may supply its own unauthenticated answer in place of the 401.

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-055] An app developer receives a signed-in member's records through the data proxy
  Given a member is signed in to an app developer's app whose data proxy uses a session check
  When the app's page asks the proxy for the member's records
  Then the app receives the member's records
  And a session renewed mid-request reaches the browser as a refreshed cookie
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-056] An app developer gets no sign-in gate on the local surface by default
  Given an app developer's app runs on a member's computer with a session-checked data proxy and an origin gate
  When the app developer opens the app on that computer with no sign-in
  Then the app shows the computer's local data
  And the app's requests carry no member's sign-in token
```

- **Notes:** Starkeep apps are local-first; a sign-in buys sync only.

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-057] An app developer turns on a sign-in gate on the local surface too
  Given an app developer turns off anonymous local access in the app's session check
  When the app developer sends a request with no session through the local data proxy
  Then the app developer receives a 401
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-058] An app developer forwards requests through an anonymous proxy with no end-user check
  Given an app developer declares the data proxy anonymous
  When the app developer sends a request with no session through the proxy
  Then the app's request goes ahead without any member's sign-in
```

- **Notes:** in the cloud the data server still demands a member's sign-in (ACCESS-049), so an anonymous cloud proxy gets no data.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-059] An app developer finds the data proxy refusing another site's writes, while a link from another site still opens the app
  Given an app developer's app is open in a browser beside another site
  When the app developer posts a form, or sends a cross-site or same-site request, to the app's data proxy from the other site's page
  Then the request fails with a 403
  When the app developer follows a link from the other site to the app
  Then the app opens normally
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-060] An app developer probes, refreshes, reads the ID token, and signs out through the session routes
  Given an app developer mounts the app client's session routes
  When the app's page probes the session, refreshes it, asks for the ID token, and signs out
  Then the probe reports signed in or signed out without an error
  And a refresh with a live session cookie issues a fresh token cookie, and a spent one clears both cookies
  And an anonymous request for the ID token receives a 401
  And sign-out clears both cookies and names the platform's sign-out page
  And an unknown session action receives a 404
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-061] An app developer finds the session routes refusing a foreign origin's refresh or sign-out, on a custom domain too
  Given an app developer's app is served on its CloudFront name and on a custom domain
  When the app developer sends a refresh or a sign-out to the app's session routes from a page on a foreign origin
  Then the request is refused
  And a refresh or sign-out from either of the deployment's own hosts succeeds
```

## The cloud operator's sign-in on a computer

A cloud operator signs in once on a computer, on the managed login page in the browser. admin-web, the `starkeep` command, and the installer scripts on that computer share the one sign-in. No Starkeep page or command ever asks for the password.

### Signing in and out

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [ACCESS-195] A cloud operator who signs in from the terminal is signed in to admin-web too, without typing a password into Starkeep
  Given this computer's cloud setup is done through the stack outputs step
  When the cloud operator runs "starkeep login --admin"
  Then the browser opens the sign-in page, and the terminal says "Sign in on this page; it returns here when you finish:" with the page's address
  When the cloud operator signs in on the page with an account that has cloud operator rights
  Then the browser tab says "You can close this tab and return to the terminal."
  And the terminal says "Signed in as the admin (<email>). admin-web uses the same sign-in."
  And admin-web's cloud sections then open without a sign-in
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "signs in on the page, asking for the password, and keeps the session admin-web shares (ACCESS-204)" (unit, local, fake pool). The test plays the browser, so no test checks the page's closing text in a real browser.
- **Notes:** the terminal never reads a password. The sign-in page asks for a new password at an account's first sign-in.

```gherkin
@local @cloud
@intent:confirmed @coverage:none
Scenario: [ACCESS-196] A cloud operator who signs in in admin-web can run the installer scripts in the terminal without signing in again
  Given the cloud operator signed in on admin-web's sign-in page
  When the cloud operator runs an installer script on the same computer, such as the cloud data server install
  Then the command acts as the signed-in cloud operator
  And the command asks for no sign-in
```

- **Coverage:** No test runs an installer script after an admin-web sign-in.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-197] A cloud operator sees in the status who is signed in as the admin and until when
  Given the cloud operator signed in as the admin on this computer
  When the cloud operator runs "starkeep status"
  Then the output shows "ADMIN     signed in as <email> until <time>"
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "shows the admin session and when it ends in the status (ACCESS-197)" (unit, local, fake pool).
- **Notes:** the time is twelve hours after the last cloud action, and never later than a day after the sign-in (ACCESS-198). A computer whose admin session ended shows "ADMIN signed out". A computer that joined no cloud shows no ADMIN line.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [ACCESS-198] A cloud operator who leaves the computer's admin session unused for twelve hours must sign in again
  Given the cloud operator signed in as the admin on this computer
  And twelve hours passed with no cloud action in admin-web or the terminal
  When the cloud operator starts a cloud action
  Then the cloud operator is told "The admin session ended after 12 hours without use. Sign in again."
  And each cloud action within twelve hours of the last one keeps the session going, up to a day after the sign-in
```

- **Coverage:** `packages/operator/__tests__/admin-session.test.ts` › "ends after twelve idle hours, revoking the token", "stays alive while it is used within the idle window" and "ends a day after its sign-in however often it is used, as the pool's one-day refresh token does" (unit, fake pool); `packages/aws-bootstrap/__tests__/bootstrap-template.test.ts` › "issues one-day refresh tokens, revocable one at a time" (unit).
- **Notes:** the pool limits the admin sign-in to one day as well, so a copy of the session taken from this computer stops working within a day, whatever happens here. A session a day old ends with "The admin session ended a day after its sign-in. Sign in again." The limit reaches a deployment with its next bootstrap update.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [ACCESS-199] A cloud operator who signs out in the terminal is signed out of admin-web too
  Given the cloud operator is signed in as the admin on this computer
  When the cloud operator runs "starkeep logout --admin"
  Then the output says "Signed out as the admin."
  And admin-web's cloud sections then ask the cloud operator to sign in
  And the old sign-in no longer works anywhere
  And the next admin sign-in, in the terminal or in admin-web, asks for the password on the sign-in page, even though the page remembers the account
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "signs out at the pool and on disk" and "signs in on the page, asking for the password, and keeps the session admin-web shares (ACCESS-204)"; `apps/admin-web/__tests__/auth-routes.test.ts` › "sends the browser to the managed login page for the admin client, with PKCE" (unit, local, fake pool). No test checks that the real managed login page honors the password prompt.
- **Notes:** when no admin session is open, the output says "No admin session was open here." When the pool cannot be reached, the session still ends on this computer, and the output says "Signed out as the admin on this computer. The pool did not confirm that it revoked the sign-in." The sync sign-in keeps the page's remembered account.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-200] A local operator whose account lacks cloud operator rights cannot sign in as the admin from the terminal
  Given the local operator holds an account that can use apps but has no cloud operator rights
  When the local operator runs "starkeep login --admin" and signs in on the page with that account
  Then the terminal says "This account has no admin rights on this cloud. Ask an admin to make you one."
  And the command exits with status 1, and no admin session opens on the computer
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "refuses an account without admin rights, and opens no session (ACCESS-200)" (unit, local, fake pool).

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [ACCESS-201] A cloud operator whose admin rights were removed must sign in with an account that still has them
  Given the cloud operator signed in as the admin on this computer
  And another cloud operator then removed the account's cloud operator rights
  When the cloud operator starts a cloud action on this computer
  Then the cloud operator is told "This account is no longer an admin of this cloud."
  And the action does not run
```

- **Coverage:** `packages/operator/__tests__/admin-session.test.ts` › "ends the session when the account lost its admin rights, and mints nothing (ACCESS-201)" (unit, fake pool).

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [ACCESS-202] A cloud operator whose account was signed out of all devices must sign in again on the computer
  Given the cloud operator signed in as the admin on this computer
  And another cloud operator signed the account out of all devices
  When the cloud operator starts a cloud action on this computer
  Then the cloud operator is told "The admin session was ended at the pool. Sign in again."
  And the action does not run
```

- **Coverage:** `packages/operator/__tests__/admin-session.test.ts` › "asks for a sign-in when the pool ended the session" (unit, fake pool).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-203] A cloud operator keeps the computer's admin session out of reach of the computer's other accounts
  Given the cloud operator signed in as the admin on a computer
  When the cloud operator looks for the admin session from another account on the same computer
  Then the other account cannot read the admin session file
```

- **Coverage:** `packages/operator/__tests__/admin-session.test.ts` › "is written by a sign-in, readable by its owner only" (unit, local).

### Sign-in problems

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [ACCESS-204] A cloud operator on a computer with no browser signs in through a forwarded port
  Given the cloud operator reaches the computer over SSH
  When the cloud operator runs "starkeep login --admin --no-browser"
  Then the terminal prints the sign-in page's address and opens no browser
  When the cloud operator forwards the computer's port 47615 to a machine with a browser, opens the address there, and signs in
  Then the terminal says "Signed in as the admin (<email>). admin-web uses the same sign-in."
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "signs in on the page, asking for the password, and keeps the session admin-web shares (ACCESS-204)" (unit, local, fake pool). No test forwards a port.
- **Notes:** the sign-in page returns to a fixed loopback address, so the browser must reach port 47615 of the computer that ran the command.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-205] A cloud operator who does not finish the sign-in within five minutes is told the time ran out
  When the cloud operator runs "starkeep login --admin" and does not finish the sign-in within five minutes
  Then the terminal says "No sign-in arrived before the time ran out."
  And the command exits with status 1, and no admin session opens
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "says the time ran out when no sign-in arrives (ACCESS-205)" (unit, local), with a shortened wait.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [ACCESS-206] A cloud operator whose sign-in port is taken is told to stop the program that holds it
  Given another program on the computer listens on port 47615
  When the cloud operator runs "starkeep login --admin"
  Then the terminal says "Port 47615 is in use, so the sign-in cannot return here. Stop the program that holds it and try again."
  And no browser opens
```

- **Coverage:** `packages/operator/__tests__/admin-session.test.ts` › "names a port another program holds" (unit, local). No test runs "starkeep login --admin" on a held port.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [ACCESS-207] A cloud operator whose sign-in page reports an error sees it in the terminal
  When the cloud operator runs "starkeep login --admin" and the sign-in page returns an error, such as a cancelled sign-in
  Then the terminal says "The sign-in page answered: <error>"
  And no admin session opens
```

- **Coverage:** `packages/operator/__tests__/admin-session.test.ts` › "rejects with the page's error" (unit, local). No test runs the command with an error from the page.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-208] A cloud operator whose admin-web runs on another port is told to sign in from the terminal
  Given admin-web runs on a port other than 3000
  When the cloud operator opens a sign-in in admin-web
  Then admin-web says "Browser sign-in returns to admin-web on port 3000, and this admin-web runs on port <port>. Sign in with `starkeep login` in a terminal instead."
  And admin-web offers no sign-in button
```

- **Coverage:** `apps/admin-web/__tests__/auth-routes.test.ts` › "refuses on a port Cognito does not return to, and says to use the CLI" (unit, local).
- **Notes:** the sign-in page returns only to addresses the bootstrap stack lists, which name port 3000.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [ACCESS-209] A cloud operator whose sign-in in admin-web fails sees why after the browser returns
  When the cloud operator signs in from admin-web and the sign-in fails, such as with an account that lacks cloud operator rights
  Then the browser returns to admin-web, which shows "Sign-in did not finish: <reason>" with a "Dismiss" button
  And a reload of the page does not show the notice again
```

- **Coverage:** `apps/admin-web/__tests__/cloud-setup-navigation.test.tsx` › "shows why a sign-in did not finish, such as an account outside starkeep-admins" (unit, local). No test reloads the page.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-210] A cloud operator who signs in from the terminal before the stack outputs are recorded is told to finish that step
  Given this computer's configuration holds no CognitoDomain stack output
  When the cloud operator runs "starkeep login --admin"
  Then the terminal says "The admin sign-in needs the CognitoDomain output, which admin-web's Stack outputs step saves. A bootstrap stack from before the managed sign-in page has no such output: update it first with `scripts/update-bootstrap.sh --apply`."
  And no browser opens
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "asks for the stack outputs when the configuration names no sign-in page (ACCESS-210)" (unit, local).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [ACCESS-227] A cloud operator whose bootstrap stack predates the browser sign-in is told to update the stack before anyone waits on the page
  Given the deployment's bootstrap stack was created before the browser sign-in, so its sign-in clients list no callback address
  When the cloud operator runs "starkeep login --admin", or signs in from admin-web
  Then the cloud operator is told "The managed login page refused this sign-in (redirect_mismatch). A bootstrap stack from before the browser sign-in lists no callback address for it. Update the stack with `scripts/update-bootstrap.sh --apply`, which needs the AWS account owner's credentials, then sign in again."
  And no sign-in page waits in the browser
  And after the stack update the same sign-in works
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "names the old bootstrap stack when the page refuses the sign-in, before anyone waits" and `apps/admin-web/__tests__/auth-routes.test.ts` › "names the old bootstrap stack when the login page refuses the sign-in" (unit, local, fake login page). No test runs against an old stack.
- **Notes:** the command asks the managed login page about the sign-in before it opens the browser. A page that cannot be reached skips the check, and the browser shows what happened.

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [ACCESS-228] A cloud operator who signs in as the admin with another account is told whose session the sign-in replaced
  Given "ana@example.com" holds the admin session on this computer
  When the cloud operator runs "starkeep login --admin" and signs in as "ben@example.com"
  Then the terminal says "Signed in as the admin (ben@example.com). admin-web uses the same sign-in." and "This replaces ana@example.com's admin session on this computer."
  And ana@example.com's session no longer works at the pool
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "says whose session a sign-in with another admin account replaces" (unit, local, fake pool).

## Signing in a computer

A local operator signs a computer in through admin-web's This Machine section or with `starkeep login --sync`, on the sign-in page in the browser. The computer's local data server keeps the sign-in and presents it on every call to the cloud. Joining a cloud by address belongs to [local-data-server.md](local-data-server.md).

### Signing in and out

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [ACCESS-062] A local operator signs a joined computer in on the sign-in page
  Given the local operator's computer has joined the deployment by its address
  When the local operator clicks "Sign in to sync" in admin-web's This Machine section
  And the local operator signs in on the sign-in page that opens with an account's email and password
  Then the browser returns to admin-web, and the This Machine section shows the computer signed in as the account's email
  And the computer starts syncing the account's library
  And no page of admin-web asked for the password
```

- **Coverage:** `apps/admin-web/__tests__/this-machine-section.test.tsx` › "sends the person to the managed login page to sign in, and asks for no password" (unit, local). No test signs in on a real page.

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-063] A local operator must join a cloud before signing a computer in
  Given the local operator's computer has not joined any cloud
  When the local operator opens admin-web's This Machine section
  Then the section offers the cloud address field and no sign-in form
  And a sign-in that the local operator sends to the computer's local data server by another route answers "Join a cloud first"
  And the computer stays signed out
```

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [ACCESS-064] A local operator who enters a wrong password stays on the sign-in page, and the computer stays signed out
  Given the local operator's computer has joined a cloud
  When the local operator clicks "Sign in to sync" and enters a wrong password on the sign-in page
  Then the sign-in page says the password is wrong and asks again
  And the This Machine section still shows the computer signed out
```

- **Coverage:** The wrong-password answer belongs to the managed login page, which no test drives.

```gherkin
@local
@intent:confirmed @coverage:none
Scenario: [ACCESS-065] A local operator who signs in with a temporary password chooses a new password on the sign-in page
  Given a cloud operator created an account, and the local operator holds the emailed temporary password
  When the local operator clicks "Sign in to sync" and signs in on the sign-in page with the temporary password
  Then the sign-in page asks the local operator to choose a new password
  When the local operator enters a new password that the pool's policy accepts
  Then the browser returns to admin-web, and the computer signs in
```

- **Coverage:** The new-password page belongs to the managed login page, which no test drives.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-066] A member syncs a computer with its sign-in alone
  Given a local operator signed the member's computer in
  And the computer holds no app secret and no AWS credentials for the cloud
  When the member adds a photo to the computer's library
  Then the photo appears in the member's cloud library after the next sync
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-067] A member sees the cloud's records in Drive on a signed-in computer
  Given a local operator signed the member's computer in
  When the member opens Drive's view of the cloud's records on the computer
  Then Drive lists the member's records held in the cloud
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-068] A local operator who signs a computer out stops its sync at once and ends the old sign-in
  Given the local operator's computer is signed in and syncing
  When the local operator signs the computer out in admin-web
  Then the This Machine section shows the computer signed out
  And a record added afterwards stays on the computer
  And the old sign-in no longer works anywhere
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-069] A local operator who signs a computer in again keeps syncing and ends the earlier sign-in
  Given the local operator's computer is signed in
  When the local operator signs the computer in again with the same account
  Then the computer keeps syncing under the new sign-in
  And the earlier sign-in no longer works anywhere
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-070] A local operator keeps the computer's sign-in out of reach of the computer's other accounts
  Given the local operator signed a computer in
  When the local operator looks for the sign-in from another account on the same computer
  Then the other account cannot read the sign-in file or list its folder
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-071] A local operator signs a computer in to the cloud it joined, not a cloud its old settings name
  Given the local operator's computer once joined one cloud and its settings still name that cloud's user pool
  And the local operator has since joined the computer to a second cloud
  When the local operator signs the computer in
  Then the sign-in uses the second cloud's accounts
  And the local operator's account on the second cloud signs in
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-072] A local operator signs a computer in given only the cloud's address
  Given the local operator knows the cloud's gateway address or its CloudFront address
  When the local operator joins the computer to the cloud by that address, holding no credential
  Then the local operator can sign the computer in on the sign-in page with no further settings
  And on a cloud with no device sign-in set up, the local operator sees that device sign-in is not set up
```

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [ACCESS-211] A local operator signs a joined computer in to sync from the terminal
  Given the local operator's computer has joined the deployment by its address
  When the local operator runs "starkeep login --sync" and signs in on the sign-in page that opens
  Then the terminal says "This computer syncs as <email>."
  And admin-web's This Machine section shows the computer signed in as that email
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "signs the computer in through the data server (ACCESS-211)" (unit, local), against a stand-in data server. No test checks admin-web's This Machine section.

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [ACCESS-212] A local operator signs a computer out of sync from the terminal
  Given the local operator's computer is signed in and syncing
  When the local operator runs "starkeep logout --sync"
  Then the terminal says "This computer no longer syncs."
  And admin-web's This Machine section shows the computer signed out
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "signs a syncing computer out (ACCESS-212)" (unit, local), against a stand-in data server.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-213] A local operator whose computer joined no cloud is told to join one before a terminal sign-in
  Given the local operator's computer has not joined any cloud
  When the local operator runs "starkeep login --sync"
  Then the terminal says "This computer has joined no cloud. Join one in admin-web first."
  And no browser opens
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "says to join a cloud first, and opens no browser (ACCESS-213)" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-229] A local operator whose data server is stopped is told so before a terminal sign-in opens the browser
  Given the local operator's computer has joined a cloud, and its local data server is stopped
  When the local operator runs "starkeep login --sync"
  Then the terminal says "The local data server is not answering. Run `starkeep start data-server` first."
  And no browser opens
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "refuses before the browser opens when the data server is stopped" (unit, local).

```gherkin
@local @cloud
@intent:confirmed @coverage:partial
Scenario: [ACCESS-230] A local operator who signs in to sync with an account other than the library's owner is told the computer does not sync
  Given the computer's library belongs to "ana@example.com"
  When the local operator runs "starkeep login --sync" and signs in as "ben@example.com"
  Then the terminal says "Signed in as ben@example.com, but this computer's library belongs to another account, so it does not sync." with the data server's reason
  And the command exits with status 1
  And "starkeep status" shows "SYNC      this library belongs to another account (ben@example.com)"
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "says when the library belongs to another account" (unit, local), against a stand-in data server.

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-231] A local operator who signs a computer out of sync that does not sync is told so
  Given the local operator's computer is not signed in to sync
  When the local operator runs "starkeep logout --sync"
  Then the terminal says "This computer was not signed in to sync."
  And the command exits with status 0
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "says a computer that does not sync was not signed in" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-214] A local operator who names neither sign-in is told to pick one
  When the local operator runs "starkeep login" without "--admin" or "--sync"
  Then the terminal says "Name what to sign in to: --admin or --sync."
  And the command exits with status 2
```

- **Coverage:** `packages/cli/__tests__/login.test.ts` › "needs one of --admin and --sync (ACCESS-214)" (unit, local).

```gherkin
@local
@intent:confirmed @coverage:full
Scenario: [ACCESS-215] A local operator finds that a program holding an account's password cannot sign the computer in with it
  Given the local operator's computer has joined a cloud
  And a program on the computer holds an account's email and password
  When the program sends them to the computer's local data server to sign it in
  Then the program receives "Send either { code, codeVerifier, redirectUri } from the sign-in page or { refreshToken }"
  And the This Machine section still shows the computer signed out
```

- **Coverage:** `apps/local-data-server/__tests__/integration/device-sign-in.test.ts` › "takes no password" (integration, local).

### When the pool is out of reach

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-073] A local operator keeps the computer's sign-in through a start while the accounts service is out of reach
  Given the local operator's computer is signed in
  And the computer cannot reach the cloud's accounts service
  When the local operator starts the computer
  Then the This Machine section still shows the computer signed in
  And sync resumes once the service answers, with no new sign-in
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-074] A local operator who signed a computer out offline finds the old sign-in ended at the next start or sign-in
  Given the local operator signed a computer out while the computer was offline
  When the local operator next starts the computer with a network, or signs it in
  Then the old sign-in no longer works anywhere
  And a second offline sign-out between the two does not leave either old sign-in working
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-075] A local operator finds the computer signed out after a restart once a cloud operator signed its account out of all devices
  Given the local operator signed the computer in with a member's account
  And a cloud operator signed that member out of all devices
  When the local operator next restarts the computer
  Then the This Machine section shows the computer signed out
  And nothing added afterwards syncs until the local operator signs the computer in again
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-076] A local operator who signs out during a sign-in refresh stays signed out
  Given the local operator's computer is refreshing its sign-in
  When the local operator signs the computer out before the refresh finishes
  Then the computer stays signed out
  And a new sign-in made meanwhile stays in place
```

### Binding the library to one member

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-077] A local operator who signs a computer in for the first time makes its library the account's
  Given a member added photos to a computer's library before anyone signed the computer in
  When the local operator signs the computer in for the first time with the member's account
  Then the photos added earlier reach that account's cloud library
  And the computer's library belongs to that account from then on
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-078] A local operator who signs the computer in again resumes sync with what was added meanwhile
  Given the computer's library belongs to the local operator's account, and the local operator signed the computer out
  When the local operator signs the computer in again
  Then sync resumes and carries what was added while the computer was signed out
```

```gherkin
@local
@intent:confirmed @suboptimal
Scenario: [ACCESS-079] A local operator cannot sign a computer in with an account other than the one its library belongs to, and sees why
  Given a computer's library belongs to a member's account
  When the local operator signs the computer in with another member's account
  Then admin-web shows "This machine's library belongs to another account. Sign in as that account to sync it."
  And none of the library's records reach the other member's cloud library
  And the computer keeps its existing sign-in state
```

- **Suboptimal:** the local operator has no way forward on this computer except signing in as the owner. Revisit a way to hand the library to another account after a clear warning.

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-177] A local operator whose computer refused another member's account resumes sync by signing in with the owning account, without a restart
  Given a sign-in with another member's account was refused on a computer whose library belongs to the local operator's account
  When the local operator signs the computer in with the owning account
  Then the computer syncs the owning account's library at once, without a restart
```

### What a computer's sign-in reaches

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-080] A member finds Drive's records and Photos' rows in the cloud after a computer syncs
  Given a member's computer is signed in
  And Photos is installed both on the computer and in the cloud
  And the member has records in Drive and rows in Photos on the computer
  When the member waits for the computer's next sync
  Then the member finds both in the cloud, in the member's own library
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-081] A member finds an app's rows kept on the computer when the app is not installed in the cloud
  Given a member's computer runs an app that is not installed in the cloud
  When the member waits for the computer to sync that app's rows
  Then the app's rows stay on the computer
  And the sync status names a refusal for that app
```

- **Notes:** what each channel carries belongs to [sync.md](sync.md).

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-082] A member can use a computer's sign-in only for sync, settings, reads, and public links
  Given a member's computer is signed in
  When the member uses the computer's sign-in for anything beyond syncing, uploading, reading the deployment's settings, reading the cloud's record listing, and managing the member's public links
  Then the member's request is refused
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-083] A member cannot change the platform's own files with a computer's sign-in
  Given a member's computer is signed in
  When the member pushes, uploads, or deletes a file in the platform's own category with the computer's sign-in, alone or inside a batch
  Then the whole push or upload is refused
  And the deployment's settings files stay as they were
```

## Signing in on a phone

A member signs in to a phone app on the managed login page. After each sign-in the phone registers a hardware key that the platform ties to one app's declared build, and the phone signs every later request with that key. Phone apps sync without their cloud app: an app registered for its mobile surface alone still syncs.

### Phone sign-in (platform side)

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-084] A member signs in to Photos on a phone through the system browser
  Given a cloud operator installed Photos' mobile surface on the deployment
  When a member chooses Sign in in Photos on a phone
  Then the phone's system browser opens the deployment's managed login page
  And after the member signs in, the browser returns the member to Photos signed in
```

```gherkin
@cloud @mobile
@intent:confirmed
Scenario: [ACCESS-085] A member signs in to a phone app whose mobile surface a cloud operator registered
  Given a cloud operator registered an app's mobile surface, with or without its cloud app
  When a member signs in to the app on a phone
  Then the sign-in returns to the app
```

- **Notes:** mobile-only registration belongs to [app-lifecycle.md](app-lifecycle.md).

```gherkin
@cloud @mobile
@intent:confirmed
Scenario: [ACCESS-188] A member cannot sign in to a phone app after a cloud operator removes its mobile surface
  Given a cloud operator removed an app's mobile surface
  When a member signs in to the app on a phone
  Then the sign-in never returns to the app
  And the member's sign-ins to other phone apps keep working
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-086] An app developer gets a not-authenticated answer for a phone token without an attested key
  Given a member signed in to an app developer's phone app and the app registered no key
  When the app syncs with the token alone
  Then the sync fails as not authenticated
  And the member's cloud library receives nothing from the phone
```

### Proving which app holds the token

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-087] An app developer registers a phone's hardware key attested to the app's declared build
  Given a member signed in to an app developer's phone app on a locked, verified phone
  When the app registers a hardware-backed key attested with the new sign-in
  Then the app syncs the member's data with that key
  And registering the same key again succeeds without a second key
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario Outline: [ACCESS-088] An app developer cannot register a key from an unlocked, unverified, or software-only device, or a chain that does not reach a pinned root
  Given a member signed in to an app developer's phone app
  When the app registers a key whose attestation shows <problem>
  Then the registration fails
  And the app cannot sync until it registers an acceptable key

  Examples:
    | problem                                              |
    | an unlocked bootloader                               |
    | an unverified operating system                       |
    | a software key or an imported key                    |
    | a key that may not sign                              |
    | a challenge made for another sign-in                 |
    | a chain from a root the platform does not pin        |
    | a chain out of order, a lone certificate, or garbage |
    | an intermediate certificate out of date              |
```

- **Notes:** a real Android phone with an unlocked bootloader also reports its operating system as unverified, so it fails that check before the bootloader check. The outcome holds for the row, because the scenario quotes no refusal copy.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-089] An app developer cannot register a key whose chain holds a revoked certificate
  Given a phone's attestation chain holds a certificate on Google's revocation list
  When the app developer's phone app registers its key
  Then the registration fails
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-090] An app developer cannot register a key from a build that no app declared or that two apps claim
  Given the attested package or signing certificate of an app developer's phone app matches no installed app's manifest, or matches two apps
  When the app registers its key
  Then the registration fails
  And an app whose mobile build is no longer registered meets the same refusal
```

- **Notes:** apps that share an Android user id are refused too.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-091] An app developer cannot register a key with a token from any sign-in but the phone's
  Given an app developer holds a token from a cloud app, a computer, or admin-web sign-in
  When the app developer registers an attested key with that token
  Then the registration fails
```

### What a phone reaches

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-092] A member finds a phone's photos and Photos' own rows in the cloud library
  Given Photos on a member's phone holds a registered key
  And the member has photos and captions in Photos on the phone
  When the member lets Photos sync the photos on Drive's channel and the captions on Photos' own channel
  Then the member finds both in the member's cloud library
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-093] An app developer gets a not-authenticated answer for a bad signature, a stale timestamp, an expired token, or another member's key
  Given an app developer's phone app on a member's phone holds a registered key
  When the app sends a request with a bad signature, a signature made for another channel, a stale timestamp, an expired token, or a key registered to another member
  Then the request fails as not authenticated
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-094] An app developer gets a forbidden answer from a phone on every other app's channel
  Given an app developer's phone app on a member's phone holds a registered key
  When the app sends a signed request on another app's channel
  Then the request fails as forbidden
  And the other app's rows stay unchanged
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-095] An app developer gets no fallback to the computer sign-in when a phone's key is refused
  Given the platform refuses the key of an app developer's phone app
  When the app's request also carries a token that a computer's sign-in would accept
  Then the request still fails
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-096] An app developer receives on a phone only the types the app may read, with no cloud compute for the app
  Given an app developer's phone app is registered for its mobile surface alone, with read grants on image types
  And the member's cloud library holds photos and Markdown documents
  When the app on the member's phone syncs on Drive's channel
  Then the app receives the member's photos and none of the documents
  And the app's sync agrees with the cloud's digest, so it does not re-sync the same photos
```

- **Notes:** on Drive's channel the phone acts with its app's grants, never Drive's.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-097] An app developer gets a whole phone push refused when it carries any record the app may not write
  Given an app developer's phone app holds readwrite grants on image types only
  When the app pushes a batch with nine photos and one document from a phone
  Then the whole push fails as forbidden
  And none of the ten records appears in the member's cloud library
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-098] An app developer can upload from a phone only into the app's categories
  Given an app developer's phone app holds grants on the image category
  When the app asks to upload an image file and a document file
  Then the image upload goes ahead
  And the document upload fails as forbidden
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-099] A member finds only the member's own phone captions in the cloud and on other devices
  Given the member and another member use Photos on their phones
  When each of them adds captions in Photos on the phone and lets it sync on Photos' own channel
  Then the member finds only the member's own captions in the cloud and on the member's other devices
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-189] An app developer cannot push a phone file row that names another member's key
  Given an app developer's phone app on a member's phone holds a registered key
  When the app pushes a file row that names another member's key on the app's own channel
  Then the push is refused
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-100] An app developer gets a whole phone push refused for shared records or labels on the app's own channel
  Given an app developer's phone app holds a registered key
  When the app pushes shared records or labels on its own channel instead of Drive's
  Then the whole push fails
  And the shared records and labels appear nowhere in the member's cloud library
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-101] An app developer finds a phone app stopped at once when a cloud operator removes its mobile surface
  Given an app developer's phone app on a member's phone syncs with a registered key
  And a cloud operator removed the app's mobile surface
  When the app syncs on either channel and registers a new key
  Then the sync fails
  And the key registration fails
```

## Keeping members' data apart

Each member's shared records, labels, metadata, app rows, and files form a library of the member's own. Nothing crosses from one member's library to another's, whether through a cloud app, a computer, or a phone.

### Shared records

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-102] An app developer gets none of another member's records through an app acting for one member
  Given two members each keep photos in their cloud libraries
  And an app developer's app acts for the second member
  When the app lists, counts, searches, and reads records, including by the first member's record id
  Then the app receives only the second member's records and counts
  And a read by the first member's record id answers not found
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-103] An app developer can neither label, sign a file URL for, overwrite, nor delete another member's record
  Given the first member holds a photo whose record id the app developer knows
  And the app developer's app acts for the second member
  When the app labels the record, asks for its file URL, writes over it, or deletes it
  Then each attempt fails
  And the first member's photo keeps its labels, its bytes, and its place in the library
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-104] A member who adds the same photo as another member keeps a record of the member's own
  Given the member and another member each add the same photo file to their libraries
  When the member views the photo in Photos
  Then the member sees the photo as the member's own record
  And a label, an edit, or a deletion by the other member leaves the member's copy unchanged
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-105] A member sees none of another member's labels, caption, or freed bytes on the same photo
  Given the member and another member hold the same photo
  And the other member labeled the photo, added a caption to its metadata, and freed its bytes on a device
  When the member opens the photo
  Then the member's photo shows none of the other member's labels or caption
  And the member's photo stays available as before
```

### App rows and files

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-106] An app developer keeps two members' app rows with one fixed id apart in reads, digests, and queries
  Given an app developer's app writes a settings row with the fixed id "prefs" for each of two members
  When the app reads, queries, or syncs its rows for each member
  Then the app receives only that member's "prefs" row
  And each member's sync sees no change caused by the other member's row
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-107] An app developer cannot retract or overwrite one member's app row while acting for another
  Given an app developer's app holds a row for the first member, and the app uses the same row id for the second member
  When the app, acting for the second member, writes or retracts a row with that id
  Then the first member's row keeps its content
  And only the second member's own row changes
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-108] An app developer reaches only the acting member's part of the app's files
  Given an app developer's app keeps private files for each of two members
  When the app's session for the second member asks for a file under the first member's part
  Then the request fails
  And the app reaches its own files only for the member it acts for
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-109] An app developer cannot reach another member's stored objects with an app session's AWS credentials
  Given an app developer's app session acts for one member
  When the app developer uses the session's AWS credentials directly against another member's stored objects, or against objects that name no member
  Then each call fails with an access-denied error
  And the same credentials still reach the acting member's own objects
```

- **Notes:** the member never sees this layer. The scenario states the second guard that holds if the data server's own check fails; `packages/iam-permission-tests/test/user-scope.test.ts` exercises it.

### Devices

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-110] A member finds none of another member's records on the member's computer
  Given the member and another member each have a computer signed in to their own account
  When the member waits for the computer's next sync
  Then the member's computer holds only the member's own records
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-111] A member cannot presign, stat, or fetch another member's file with a computer's sign-in
  Given a member knows the storage key of another member's photo
  When the member asks the cloud, with the computer's sign-in, to presign, stat, or fetch that key, or reads the cloud's records through the read-only routes
  Then each request fails or comes back empty
  And the member never receives the other member's bytes
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [ACCESS-112] A member sees none of another member's photos on the member's phone
  Given the member and another member each use Photos on their own phones
  When the member lets Photos on the phone sync
  Then the phone shows only the member's own photos
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-113] An app developer cannot presign a storage key under another member's segment on a computer
  Given a computer's library belongs to one member
  When an app developer's app on the computer asks the local data server to presign a storage key under another member's segment
  Then the app receives a refusal
```

## Sharing with another member

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-114] A member shares an album with another member of the deployment
  Given another member belongs to the same deployment
  When the member shares a set of photos with the other member in cloud Photos
  Then the photos stay in the member's own library, with one stored copy
```

- **Notes:** planned, not built. Today no path crosses the member cut, and Photos' share route answers "not implemented".

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-190] A member sees the photos another member shared, until the other member removes them
  Given another member of the deployment shared a set of photos with the member in cloud Photos
  When the member opens cloud Photos
  Then the member sees the shared photos
  And the member's view loses each photo the other member removes from the share or deletes
```

- **Notes:** planned, not built, as ACCESS-114's note says.

## What an app may reach

An app signs every request to a data server with its own credential. The install's type grants then decide which records the app may read and write. These rules hold on the local data server and in the cloud alike.

### App credentials

- A cloud app's signing credential survives a reinstall, and sync keeps validating: see APP-LIFE-124 in [app-lifecycle.md](app-lifecycle.md) (formerly ACCESS-115).

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [ACCESS-116] An app developer gets a not-authenticated answer for a wrongly signed request
  Given an app developer's app holds its installed credential
  When the app sends a data server a request signed with <fault>
  Then the request fails as not authenticated
  And the app receives no data and changes nothing

  Examples:
    | fault                                                  |
    | a wrong secret                                         |
    | another app's id                                       |
    | a signature made for another path                      |
    | a timestamp outside the freshness window               |
    | a body changed after signing                           |
    | no signature headers at all                            |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-117] An app developer gets a not-authenticated answer for an app with no installed credential
  Given an app developer's app was never installed on this computer or in this cloud
  When the app developer sends the data server a request signed under that app's id
  Then the request fails as not authenticated
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-118] An app developer sees 401s and a visible error state when the app's credential is damaged
  Given the installed credential file of an app developer's app was damaged on a member's computer
  When the app developer opens the app on that computer
  Then the app's data requests fail with 401 answers
  And the app shows a visible error state instead of an empty library
```

### Type grants

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-119] An app developer cannot create or delete a record of a type the app holds only read on, or no grant on
  Given an app developer's app holds a read grant on image/jpeg and no grant on document/pdf
  When the app registers a JPEG record or a PDF record, or deletes an existing JPEG record
  Then each write fails as forbidden
  And no record appears or disappears in the member's library
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-120] An app developer cannot see an ungranted type in listings, single reads, or file links
  Given a member's library holds JPEG photos and Markdown documents
  And an app developer's app holds a read grant on image/jpeg only
  When the app lists records and types, reads a Markdown record by id, and asks for a Markdown record's file URL
  Then the listings leave out every Markdown record and the document/markdown type
  And the single read and the file URL fail as forbidden
  And an app with no read grant at all receives an empty type list with a total of zero
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-121] An app developer gets "not found" for a missing record without the grant
  Given an app developer's app holds no grant on document/markdown
  When the app reads a record id that does not exist
  Then the app receives a not-found answer, as an app with the grant would
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-122] An app developer cannot upload a PDF through an app with grants on images only
  Given an app developer's app holds grants on the image category only
  When the app uploads the bytes of a PDF document
  Then the upload fails as forbidden
  And the member's library holds no new bytes
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-123] An app developer can upload only the formats that the app's type grant names
  Given an app developer's app holds a readwrite grant on image/jpeg only
  When the app uploads PNG bytes
  Then the upload fails as forbidden
  And an upload of JPEG bytes goes ahead
```

- **Notes:** file uploads and record creation accept the same formats, the ones the member approved in the consent dialog.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-124] An app developer sees Drive read and write every type with no grant rows
  Given Drive holds no grant rows on the deployment
  When Drive lists, reads, and writes records of every type, other/other included
  Then each operation succeeds
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-125] An app developer cannot write metadata through an app that may only read a category
  Given an app developer's app holds a read grant on image/jpeg without a metadata-write grant
  When the app writes image metadata to an existing JPEG record through the metadata route
  Then the write fails as forbidden
  And the record gains no metadata
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-174] An app developer gets a metadata write judged by the record's own type, not the type the request names
  Given an app developer's app holds a metadata-write grant on the image category and no grant on the video category
  When the app writes metadata that names the image category to a video record
  Then the write fails as forbidden
  And the video record gains no metadata
```

- **Notes:** an app that holds metadata-write grants on both categories writes into the video record's own metadata. A column that only images have fails as invalid, and the columns the two categories share land on the video record.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [ACCESS-175] An app developer reads metadata only with a grant on the record's own type
  Given an app developer's app holds a read grant on image/jpeg only
  When the app reads the image metadata of a PNG record and of its own JPEG record
  Then the PNG read fails as forbidden, although both records are images
  And the JPEG record's metadata reads normally
  And a readable record of the other/other type has no metadata to read
```

### Local file links

- A local file link serves bytes without a signature and stops working after a restart: see SHARED-194 in [shared-data.md](shared-data.md) (formerly ACCESS-126).
- A forged or garbage file link is refused: see SHARED-099 in [shared-data.md](shared-data.md) (formerly ACCESS-127).

## Outside clients

A member lets an outside client, such as a script or an MCP client, act for the member through one app. The member creates a token on the consent page, or approves an MCP client through OAuth. Either way the client acts as the app, for the member, at a mode the member chose. Scheduled-job tokens belong to [app-data.md](app-data.md).

### Creating a token on the consent page

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-128] A member creates a read token for one app, with a 90-day expiry by default
  Given a member opens the consent page for an outside client
  When the member names the program, picks Probe, and accepts the preselected choices
  Then the member receives a token that reads through Probe for the member
  And the page says the program "may now read" the member's Probe data until a date ninety days out
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-129] A member sees the new token once, after a fresh sign-in on the managed login page
  Given a member chose an app and a mode on the consent page
  When the member submits the form
  Then the browser takes the member to the managed login page for a fresh sign-in
  And the consent page shows the new token once
  And the token does not appear again after the member leaves the page
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-130] A member can pick only installed web apps that declare an outside-client route
  Given the deployment runs Probe, which declares an outside-client route, and Photos, which declares none
  When a member opens the consent page
  Then the page offers Probe and not Photos
  And a form that the member posts for Photos, or with an unsupported expiry, creates no token
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-131] A member gets no token from a cross-site post or a post without the page's CSRF token
  Given a member is signed in to the consent page
  When the member opens another site's page that posts the consent form, or sends a post without the page's CSRF token
  Then the post creates no token
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-132] A member whose account has cloud operator rights and no data group membership creates a token for the member's own library on the consent page
  Given the member's account has cloud operator rights and does not belong to the data group
  When the member signs in on the consent page and submits the form
  Then the consent page shows the new token once
  And the member's connections page lists the token
```

- **Notes:** follows ACCESS-004's decision (2026-11-24): every account with cloud operator rights holds a library.

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-133] A member gets no token for an app uninstalled while the member signed in
  Given a member filled in the consent form for Probe
  And a cloud operator uninstalled Probe before the member finished signing in
  When the member finishes signing in and returns to the consent page
  Then the page shows "No app called probe serves outside clients here."
  And no token appears on the connections page
```

- **Notes:** a callback whose state does not match the browser's creates nothing either.

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-134] A member opens the consent and connections pages only on the gateway's own hostname
  Given a member has an account on a deployed cloud
  When the member opens the consent page through the CloudFront address
  Then the member receives a not-found page
  And the same page opens on the gateway's own hostname
  And the page refuses to show inside a frame
```

### What a token reaches

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-135] A member reads records and app rows and adds labels with a read token
  Given a member created a read token for Probe
  When the member uses the token in an outside client to read records, read Probe's rows, and add a label
  Then the member's client receives the member's records and rows
  And the member finds the label on the record afterwards
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-136] A member cannot write a row with a read token
  Given a member created a read token for Probe
  When the member writes a Probe row with the token in an outside client
  Then the write fails as forbidden
  And the member finds Probe's rows unchanged
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-137] A member writes and deletes rows and records with a readwrite token, and deleted records go to the Trash
  Given a member created a readwrite token for Probe
  When the member uses the token in an outside client to write a row and a record and then delete each
  Then the member finds the record in the Trash and the row gone from Probe
  And the member can still restore the record within the trash window
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-138] A member cannot erase bytes, restore from the Trash, thaw, sync, publish public links, or read settings with a token
  Given a member created a readwrite token for Probe
  When the member uses the token in an outside client to erase a file's bytes, restore a record from the Trash, thaw archived bytes, run a sync exchange, publish a public link, or read the deployment's settings
  Then each call fails as forbidden
  And a call to a route the platform added later is refused until someone opens it to tokens
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-139] A member reads only the member's own rows with a token
  Given the member and another member each created a token for Probe
  When the member reads Probe's rows with the member's token
  Then the member's client receives only the member's own rows
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-140] An app developer gets a gateway 401, and no run of the app's code, for another app's token, an expired token, or a forged token
  Given a member created a token for Probe, the app developer's app
  When the app developer presents a token for another app, an expired token, a token signed by another key, a scheduled job's token, or garbage on Probe's outside-client route
  Then the app developer receives a 401 at the gateway
  And Probe's code never runs for the request
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-141] An app developer gets a bare 401 from an outside-client route called without a token
  Given an app developer declares an outside-client route for Probe's MCP tools
  When the app developer calls the route with no token
  Then the app developer receives a 401 that says a bearer token is expected
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-142] A member gets a 403, not a 401, for a token used on the gateway's own hostname
  Given a member created a valid token for Probe
  When the member calls Probe's outside-client route with the token on the gateway's own hostname
  Then the member's client receives a 403 rather than a 401
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-143] An app developer gets a refusal for a token sent without the app's own signature
  Given an app developer holds a member's valid token for Probe
  When the app developer sends the token to the data server without Probe's signature, or beside a member's sign-in token
  Then the app developer receives a refusal
  And the app developer receives no data
```

### Listing, revoking and ending a token

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-144] A member sees each connection's app, access, expiry, last use, and status on the connections page
  Given a member created two tokens and approved one MCP client
  When the member opens the connections page
  Then the page lists the member's own connections, newest first, each with its app, access mode, expiry, last use, and status
  And the MCP client's row shows the client's hosts beside the name it chose
  And the page lists no other member's connections
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-145] A member who revokes a token sees its calls fail at once, and everywhere within a minute
  Given a member's outside client uses a token
  When the member revokes the token on the connections page
  Then the client's next call fails
  And within a minute every later call fails, wherever it lands
  And the connections page shows the token as revoked
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-146] A member whom a cloud operator signed out of all devices or disabled loses the outside client's token within fifteen minutes
  Given a member's outside client uses a token
  And a cloud operator chose "Sign out all devices" or "Disable" for the member
  When the member keeps using the outside client
  Then within fifteen minutes the client's calls fail
  And the connections page shows the token as revoked
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-147] A member removed from the data group loses every token's access
  Given a member's outside client uses a token
  And a cloud operator removed the member from the data group
  When the member keeps using the outside client
  Then within fifteen minutes the client's calls fail as forbidden
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-148] A member keeps an outside client's token through an outage at the user pool
  Given a member's outside client uses a token
  And the deployment cannot reach its user pool to check the member
  When the member keeps using the outside client during the outage and after it ends
  Then the client's calls fail while the outage lasts
  And the token works again once the pool answers
  And the connections page still shows the token as active
```

### OAuth for MCP clients

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-149] An app developer finds where an MCP client signs in from a bare 401 and the two metadata documents
  Given Probe declares an outside-client route
  When the app developer calls the route with no token from an MCP client and follows the answer
  Then the client finds the protected resource metadata for the route on the host it called
  And the authorization server metadata names PKCE, client metadata documents, public clients, and the issuer parameter
  And an undeclared path, a sub-path, or an app with no outside-client route answers not found
```

- Discovery names the host the client called: see CLOUD-SETUP-105 in [cloud-setup.md](cloud-setup.md) (formerly ACCESS-150).

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-151] A member never reaches sign-in for an MCP client whose metadata document fails the fetch checks
  Given an MCP client names its metadata document by URL
  And the URL is plain http, names an IP address, a private address, credentials, a port, a fragment, or dot segments, or the document redirects, loads slowly, runs too large, is not JSON, names another client id, a confidential client, or no https redirect address
  When the member starts approving the MCP client
  Then the member's browser shows an error page that names the client's host
  And the browser never reaches the managed login page
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-152] A member sees an error page, never a redirect, for an unlisted redirect address
  Given an MCP client's metadata document lists its redirect addresses
  And the client's authorization request names a redirect address the document does not list, or names no client or no redirect address
  When the member opens the authorization request in a browser
  Then the member's browser shows an error page
  And the browser is never sent to the unlisted address
```

- **Notes:** request errors that the client can safely receive, such as an unsupported response type, scope, or resource, go back to the listed redirect with the state and the issuer.

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-153] A member sees a loopback redirect accepted on any port, with a warning
  Given an MCP client lists "http://127.0.0.1/callback" as a redirect address
  And the client asks for authorization with "http://127.0.0.1:53124/callback"
  When the member opens the authorization request in a browser
  Then the consent page accepts the address
  And the consent page names the loopback origin with its port and warns "This program receives its access on your own computer. Any program running there can claim this name."
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-154] A member sees the client, its document's host, the access host, the app, the account, the mode, and the expiry on the consent page
  Given a member signed in to approve an MCP client
  When the member reaches the consent page
  Then the page names the client, the host that serves its document, the host the access goes to, the app, the member's account, the mode, and the expiry
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-155] A member finds read and write preselected only when the MCP client asks for write
  Given an MCP client asks for authorization with no write scope, or with one
  When the member opens the consent page
  Then the consent page preselects read, or read and write, to match
  And the member can change the choice before approving
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-156] An app developer receives a one-minute code when a member approves the MCP client, and access_denied when the member denies
  Given an app developer's MCP client sent a member to the consent page
  When the client waits for the answer at its redirect address
  Then the client receives a code, with the state and the issuer, that works for one minute, once the member approves
  And the client receives access_denied once the member denies instead
```

- **Notes:** a second approval of the same page issues nothing.

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-191] A member who denies an MCP client finds no connection for it
  Given a member is on the consent page for an MCP client
  When the member denies
  Then no connection for the client appears on the member's connections page
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-157] An app developer can use a code once, and a second use ends the first exchange's tokens
  Given an app developer's MCP client exchanged a code for tokens
  When the client presents the code a second time
  Then the second exchange fails
  And the tokens from the first exchange stop working
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-158] An app developer cannot exchange an expired code, a wrong verifier, another client's code, another redirect, or another app's resource
  Given a member approved an app developer's MCP client
  When the client exchanges the code after it expired, without the PKCE verifier or with a wrong one, as another client, with another redirect address, for another app's resource, or for an app uninstalled since the consent
  Then the exchange fails
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-192] A member finds no connection when an MCP client's code exchange fails
  Given a member approved an MCP client
  And the client's code exchange failed, for example because the code expired
  When the member opens the connections page
  Then no connection for the client appears there
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-159] An app developer gets a rotated refresh token and a fifteen-minute access token on each refresh
  Given an app developer's MCP client holds a refresh token
  When the client refreshes
  Then the client receives a new refresh token and an access token that works for fifteen minutes
  And an expired access token receives a 401 at the gateway
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-160] An app developer loses the connection by reusing a rotated refresh token after the grace window
  Given an app developer's MCP client refreshed and received a successor refresh token
  When the client presents the old refresh token again more than a minute after the rotation
  Then the refresh fails
  And every token of that connection stops working
  And within the minute the old token is refused without ending the connection
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-161] An app developer cannot refresh past the expiry the member chose
  Given a member approved an app developer's MCP client with a thirty-day expiry
  When the client refreshes after thirty days
  Then the refresh fails
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-162] An app developer loses the connection on a refresh for a disabled member, and keeps it through a pool outage
  Given an app developer's MCP client holds a refresh token for a member
  When the client refreshes after a cloud operator disabled the member
  Then the refresh fails and the connection shows as revoked
  When the client refreshes while the user pool does not answer
  Then the refresh fails as unavailable and the connection stays active
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-163] A member who revokes an OAuth client on the connections page ends its access and its next refresh
  Given a member approved an MCP client
  When the member revokes the client on the connections page
  Then the client's next refresh fails
  And the client's current access token stops working
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-164] A member keeps using cloud apps while anonymous callers flood the OAuth endpoints
  Given anonymous callers flood the deployment's OAuth endpoints
  When the member keeps using the member's cloud apps
  Then the member's apps keep answering
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-193] A cloud operator finds a flood of anonymous OAuth calls throttled at the OAuth endpoints, below the deployment's limit
  Given anonymous callers flood the deployment's OAuth endpoints
  When the cloud operator checks the answers that the flood receives
  Then the flood meets throttling at the OAuth endpoints first
```

### Outside clients on the local surface

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-165] A member uses a local app's tools from an MCP client with no token
  Given Probe runs on a member's computer
  When the member connects an MCP client on the same computer to Probe's outside-client route on a loopback address, without a token
  Then the member's client uses Probe's tools with Probe's full power over the local library
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-166] An app developer gets a forbidden answer from a local outside-client route for a non-loopback Host or another site's page
  Given Probe runs on a member's computer
  When the app developer sends Probe's outside-client route a request with a Host that is not a loopback name, or from another site's page
  Then the request fails as forbidden
```

```gherkin
@cloud
@intent:confirmed
Scenario: [ACCESS-167] An app developer gets a 401 from a cloud outside-client route for a loopback Host without a token
  Given Probe runs in the cloud
  When the app developer presents a loopback Host to Probe's outside-client route without a token
  Then the app developer receives a 401
```

## Local surfaces stay on this machine

Admin-web, the local data server, and local apps listen on this machine's loopback address. A web page in the member's browser can still reach them, so each surface refuses requests that a foreign page or a rebinding domain sent.

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-168] A member who opens a rebinding page sees admin-web, the local data server, Photos, and Drive refuse it
  Given a member runs admin-web, the local data server, Photos, and Drive on a computer
  When the member opens a page on an attacker's domain that re-resolves the domain to 127.0.0.1 and sends a read or a write to any of them
  Then the page receives a refusal, such as "This server answers on its loopback address only"
  And the member's own requests to localhost, 127.0.0.1, or [::1] on any port go ahead
```

- **Notes:** a local operator who lists LAN names in `STARKEEP_ADMIN_DEV_ORIGINS` opens admin-web to those names.

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-169] A local operator who opens another page finds admin-web and the local data server refusing its writes to the sign-in, join, and app admin routes
  Given the local operator's computer has not yet signed in
  When the local operator opens a web page that posts to the local data server's sign-in, join, or app admin routes
  Then the page receives "Sign in from admin-web", "Change this machine's settings from admin-web", or "Manage apps from admin-web"
  And the computer's sign-in and joined cloud stay as they were
  And admin-web answers a write from any page but its own, including one on another loopback spelling, with "This request must come from admin-web's own page."
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-170] A member who opens a page from another site, another port, or an opaque origin finds Photos and Drive refusing its writes
  Given Photos and Drive run on a member's computer
  When the member opens a page from another site, from another port on the computer, or with an opaque origin, and the page sends a write or a cross-site fetch to Photos or Drive
  Then the page's request fails with a 403
  And Photos' and Drive's own pages keep writing normally
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-171] A member opens Photos from admin-web's Open, and Photos or Drive from another site's link
  Given Photos and Drive run on a member's computer
  When the member chooses Open for Photos in admin-web, or follows a link to Photos or Drive from another site
  Then the app opens in the browser
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-172] A member who opens a rebinding page finds Photos refusing its static files too
  Given Photos runs on a member's computer
  When the member opens a rebinding page that asks Photos for one of its static files
  Then the page receives a 403
  And Photos' own pages load the same file normally
```

```gherkin
@local
@intent:confirmed
Scenario: [ACCESS-173] A local operator who opens another site's page keeps the watched folders unchanged
  Given the local operator watches a folder on the computer
  When the local operator opens a web page that posts to, or reads, the local data server's watched-folder routes
  Then the page's request fails as forbidden
  And the local operator's watched folders stay as they were
```

```gherkin
@local @cloud
@intent:confirmed @coverage:full
Scenario: [ACCESS-216] A cloud operator who opens another site's page while signed in finds admin-web refusing to act as the cloud operator for it
  Given the cloud operator is signed in as the admin on this computer
  When the cloud operator opens a page from another site that sends admin-web a cloud request, such as one that invites a user
  Then the page receives "This request must come from admin-web's own page."
  And nothing changes in the deployment
```

- **Coverage:** `apps/admin-web/__tests__/same-origin.test.ts` › "refuses another site's POST to a route that mints the admin's credentials" (unit, local).
- **Notes:** a page from another site that sends the browser to admin-web's sign-in start gets "Start the sign-in from admin-web's own page.", so it cannot sign the computer's sync or the admin session in through the sign-in page's remembered session.
