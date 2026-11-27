# Public sites

This file specifies public sites: static websites that a cloud app ships in its bundle and that anyone on the internet can read without signing in. The app developer declares the site's folder in the manifest. The cloud operator sees the publication before the install, installs the app, and finds the site's address in the install output and in admin-web. The visitor reads the site at `https://<deployment>/sites/<appId>/`. A member who is signed in sees the same site as a visitor.

Related files:

- [app-lifecycle.md](app-lifecycle.md): installing, reinstalling, and uninstalling cloud apps, and publishing an app's build files at install.
- [shared-data.md](shared-data.md): public links to single items, which a visitor also opens without signing in.
- [users-and-access.md](users-and-access.md): the signed-out redirect that sends a visitor of a member's app to its sign-in page.
- [cloud-setup.md](cloud-setup.md): updating the bootstrap stack and reinstalling the cloud data server.

## Reading a public site

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SITES-001] A visitor reads a public site's home page without signing in
  Given a cloud operator installed an app whose manifest declares a public site
  And the visitor holds no account on the deployment
  When the visitor opens "https://<deployment>/sites/<appId>/"
  Then the visitor sees the site's home page
  And no sign-in page appears
```

- **Coverage:** `e2e-aws/src/journey.ts` "a visitor reads probe's public site signed out, served from S3", tier-3 AWS, cloud; `packages/admin-installer/__tests__/site-paths-function.test.ts`, unit.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SITES-002] A visitor follows a link to a page in a site's subfolder
  Given a cloud operator installed an app whose public site holds an "about/" folder with its own home page
  When the visitor opens the site's home page
  And the visitor follows a link to "about/"
  Then the visitor sees the about page
```

- **Coverage:** `e2e-aws/src/journey.ts` "a visitor reads probe's public site signed out, served from S3", tier-3 AWS, cloud.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SITES-003] A visitor who leaves off the trailing slash still lands on the page, with its images
  Given a cloud operator installed an app whose public site holds an "about/" folder with a page that shows an image by a relative link
  When the visitor types "<address>" into the browser
  Then the browser moves to "<lands on>"
  And the visitor sees the page with its image

  Examples:
    | address                                   | lands on                                     |
    | https://<deployment>/sites/<appId>                | https://<deployment>/sites/<appId>/                |
    | https://<deployment>/sites/<appId>/about          | https://<deployment>/sites/<appId>/about/          |
    | https://<deployment>/sites/<appId>?ref=mail       | https://<deployment>/sites/<appId>/?ref=mail       |
    | https://<deployment>/sites/<appId>/about?ref=mail | https://<deployment>/sites/<appId>/about/?ref=mail |
```

- **Coverage:** `e2e-aws/src/journey.ts` "a visitor reads probe's public site signed out, served from S3", tier-3 AWS, cloud checks the root's redirect, the page at `about`, and the about page's image, and `packages/admin-installer/__tests__/static-assets.test.ts` checks the page's script and meta refresh, unit. `packages/admin-installer/__tests__/site-paths-function.test.ts` "keeps the query string across the redirect", unit, checks the root's query. No test drives a browser through the move, so no test checks the query on a folder's move.

- **Notes:** The site's root answers a redirect. A folder deeper in the site answers a small page at its bare name that moves the browser, so the move needs script or a meta refresh. A name the site holds as a file loads that file, whatever its name (SITES-020).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SITES-020] A visitor opens a file whose name has no extension
  Given a cloud operator installed an app whose public site holds a file named "NOTICES"
  When the visitor opens "https://<deployment>/sites/<appId>/NOTICES"
  Then the visitor sees the file's contents
```

- **Coverage:** `e2e-aws/src/journey.ts` "a visitor reads probe's public site signed out, served from S3", tier-3 AWS, cloud; `packages/admin-installer/__tests__/static-assets.test.ts` "serves a file whose name has no extension as itself", unit.
- **Notes:** Flutter's web build loads `assets/NOTICES` for its licenses page.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SITES-004] A visitor who opens a page the site does not have sees a not-found answer
  Given a cloud operator installed an app whose public site has no "missing.html"
  When the visitor opens "https://<deployment>/sites/<appId>/missing.html"
  Then the browser shows a "404 Not Found" answer
```

- **Coverage:** `e2e-aws/src/journey.ts` "a visitor reads probe's public site signed out, served from S3", tier-3 AWS, cloud asks for `missing.html`.

```gherkin
@cloud
@suboptimal
@intent:confirmed
Scenario: [SITES-019] A visitor sees the platform's plain not-found answer, not the site's own page
  Given a cloud operator installed an app whose public site holds a "404.html" page
  When the visitor opens a page the site does not have
  Then the browser shows the storage service's plain "404 Not Found" answer
  And the site's own "404.html" does not appear
```

- **Suboptimal:** A site should be able to show its own not-found page. CloudFront's error pages apply to the whole deployment, so a per-site page needs a function on the origin's response.

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [SITES-005] A signed-in member sees the same public site as a visitor
  Given a member is signed in to the deployment's cloud apps in a browser
  And a cloud operator installed an app whose manifest declares a public site
  When the member opens "https://<deployment>/sites/<appId>/"
  Then the member sees the same home page a visitor sees
  And the page shows none of the member's data
```

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SITES-006] Visits to a public site run none of the deployment's app code
  Given a cloud operator installed an app whose manifest declares a public site
  When many visitors read the site at the same moment
  Then the AWS console shows no Lambda invocation for any of the visits
  And members' cloud apps answer as quickly as before the visits
```

- **Coverage:** the tier-3 public-site step asserts that S3 answered each visit, and `packages/admin-installer/__tests__/cloudfront-distribution.test.ts` "/sites/\* — public sites", unit, checks the behavior targets the bucket. No test measures members' apps under a burst of visitors.

```gherkin
@cloud
@suboptimal
@intent:confirmed @coverage:none
Scenario: [SITES-022] A public site's script runs on the same origin as members' cloud apps
  Given a cloud operator installed an app whose public site runs a script
  And a member is signed in to the deployment's cloud apps in a browser
  When the member opens the site in that browser
  Then the site's script can call the member's cloud apps as the member
```

- **Suboptimal:** A site should run on its own origin, so its script cannot reach members' apps. Installing a site therefore trusts its author as much as installing an app. STA-114 tracks a separate hostname for sites.

## Installing an app with a public site

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SITES-007] A cloud operator sees before installing that the app publishes a public website
  Given an app's manifest declares a public site
  When the cloud operator opens the app's install dialog in admin-web
  Then the dialog shows a "Public website" section
  And the section says the app publishes a website at "/sites/<appId>/" that anyone on the internet can read without signing in
```

- **Coverage:** `apps/admin-web/__tests__/consent-cli-parity.test.tsx` "for a public website", unit; `packages/admin-installer/__tests__/public-site-consent.test.ts`, unit.

- **Notes:** A local install of the same app shows the same section, because a cloud install skips the dialog for a manifest the local operator already approved (SITES-023).

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SITES-024] A redeploy whose manifest adds a public site asks the cloud operator again
  Given a cloud operator installed an app whose manifest declared no public site
  And the app developer added a public site to the manifest
  When the cloud operator chooses "Redeploy" on the app's card in admin-web
  Then the install dialog opens with a "Public website" section
  And nothing deploys until the cloud operator approves
```

- **Coverage:** `apps/admin-web/__tests__/cloud-apps-section.test.tsx` "asks before a redeploy whose manifest adds a public site", unit.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SITES-008] The cloud install prints the site's address and checks that it answers
  Given an app's manifest declares a public site
  When the cloud operator runs the app's cloud install
  Then the install output names the site's address "https://<deployment>/sites/<appId>/"
  And the install output reports that the address answered
```

- **Coverage:** `packages/admin-installer/__tests__/public-site-probe.test.ts` "reports the site's address and that it answered", unit. The tier-3 installs print the line, but no test asserts the output.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SITES-009] A cloud operator sees which installed cloud apps publish a public site
  Given a cloud operator installed an app whose manifest declares a public site
  And the cloud operator installed another app without one
  When the cloud operator opens the Cloud section of the admin-web dashboard
  Then the card of the app with a site shows a "Public site" link to "https://<deployment>/sites/<appId>/"
  And the other app's card shows no such link
```

- **Coverage:** `apps/admin-web/__tests__/cloud-apps-section.test.tsx` "links the installed app's public site, and no other app's tile shows one", unit.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SITES-025] A site-only app's card links its public site and no app
  Given a cloud operator installed an app whose manifest declares a public site and no compute
  When the cloud operator opens the Cloud section of the admin-web dashboard
  Then the app's card shows a "Public site" link
  And the card shows no "Open" link, because the app has no page under "/apps/"
```

- **Coverage:** `apps/admin-web/__tests__/cloud-apps-section.test.tsx` "gives a site-only app a web tile that links only the site", unit.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SITES-014] A site-only app installs without any Lambda
  Given an app's manifest declares a public site and no compute
  When the cloud operator runs the app's cloud install
  Then the install finishes
  And the visitor reads the site at "https://<deployment>/sites/<appId>/"
  And the AWS console shows no Lambda function for the app
```

- **Coverage:** `packages/admin-installer/__tests__/orchestrator.test.ts` "installs a site-only app with no exec role, bundle or compute stack", unit, with the steps faked. No tier-3 run installs a site-only app.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SITES-015] An install on a deployment that predates public sites warns and names the update
  Given the cloud operator has not yet both updated the bootstrap stack and reinstalled the cloud data server since public sites arrived
  And an app's manifest declares a public site
  When the cloud operator runs the app's cloud install
  Then the install output warns that the site's address does not answer
  And the warning tells the cloud operator to update the bootstrap stack, then reinstall the cloud data server, then install the app again
```

- **Coverage:** `packages/admin-installer/__tests__/public-site-probe.test.ts` "names the bootstrap update and the cloud data server reinstall", unit. No test runs the install against an outdated deployment.

## Updating and removing a public site

```gherkin
@cloud
@intent:confirmed @coverage:none
Scenario: [SITES-010] A visitor sees an updated site soon after the cloud operator reinstalls the app
  Given a cloud operator installed an app whose public site's home page reads "Version one"
  And the app developer changed the home page to read "Version two"
  When the cloud operator reinstalls the app
  And a visitor opens the site's home page a minute later
  Then the visitor sees "Version two"
```

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SITES-011] A page the new version removed no longer loads
  Given a cloud operator installed an app whose public site holds "old.html"
  And the app developer removed "old.html" from the site
  When the cloud operator reinstalls the app
  And a visitor opens "https://<deployment>/sites/<appId>/old.html" a minute later
  Then the browser shows a "404 Not Found" answer
```

- **Coverage:** `packages/admin-installer/__tests__/static-assets.test.ts` "drops a site page the new deployment removed at once, unlike build files", unit, with S3 faked.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario Outline: [SITES-012] A site disappears when the cloud operator uninstalls its app
  Given a cloud operator installed an app whose manifest declares a public site
  When the cloud operator runs "<command>"
  And a visitor opens the site's home page a minute later
  Then the browser shows a "404 Not Found" answer

  Examples:
    | command                               |
    | cli:uninstall-app <appId>             |
    | cli:uninstall-app <appId> --web       |
```

- **Coverage:** `e2e-aws/src/journey.ts` "uninstalls probe: app plane gone, shared records persist", tier-3 AWS, cloud, runs the first command; `packages/admin-installer/__tests__/orchestrator.test.ts` "empties the site's files on uninstalling a site-only app" and "empties the site's files on removing a site-only app's web app alone", unit, with the steps faked. No tier-3 run removes the web app alone.

```gherkin
@cloud
@intent:confirmed @coverage:partial
Scenario: [SITES-013] A site disappears when a reinstall's manifest no longer declares it
  Given a cloud operator installed an app whose manifest declares a public site
  And the app developer removed the public site from the manifest
  When the cloud operator reinstalls the app
  And a visitor opens the site's home page a minute later
  Then the browser shows a "404 Not Found" answer
```

- **Coverage:** `packages/admin-installer/__tests__/orchestrator.test.ts` "deletes the site's files when a reinstall's manifest drops the site", unit, with the steps faked.

```gherkin
@cloud
@intent:unclear @coverage:none
Scenario: [SITES-021] A reinstall whose manifest drops compute and keeps the site removes the app's Lambda
  Given a cloud operator installed an app whose manifest declares compute and a public site
  And the app developer removed compute from the manifest
  When the cloud operator reinstalls the app
  Then the visitor still reads the site
  And "https://<deployment>/apps/<appId>/" no longer answers with the app
  And the AWS console shows no Lambda function for the app
```

- **Notes:** Today the reinstall skips the compute stack and leaves the old Lambda and its routes running until the app is uninstalled. An app that drops compute and has no site leaves them the same way. The maintainer has not yet decided whether the reinstall should remove them or should refuse until the cloud operator removes the web app.

## Declaring a public site

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario: [SITES-016] A manifest that declares a site but no cloud target is refused
  Given an app developer's manifest declares a public site
  And the manifest's targets omit "cloud"
  When the app developer validates the manifest
  Then validation fails with an error that says a public site is published only from the cloud
```

- **Coverage:** `packages/admin-manifest/__tests__/validate.test.ts` "refuses a site on an app with no cloud install", unit.

```gherkin
@cloud
@intent:confirmed @coverage:full
Scenario Outline: [SITES-017] A bundle without a usable site folder is refused before the install changes anything
  Given an app developer's manifest declares a public site in the folder "site"
  And the app's bundle <problem>
  When the cloud operator runs the app's cloud install
  Then the install stops with an error that names <named>
  And the deployment holds nothing new from the install

  Examples:
    | problem                                    | named                        |
    | has no "site" folder                       | the missing folder           |
    | has a "site" folder without "index.html"   | the missing home page        |
```

- **Coverage:** `packages/admin-installer/__tests__/static-assets.test.ts` "refuses a bundle without the site's folder" and "refuses a site without index.html", unit; `packages/admin-installer/__tests__/orchestrator.test.ts` "refuses a site bundle without index.html before any step", unit, with the steps faked.

```gherkin
@local
@intent:confirmed @coverage:partial
Scenario: [SITES-018] A local install of an app with a site publishes nothing
  Given an app's manifest declares a public site and targets both a computer and the cloud
  When the local operator installs the app on a computer
  Then the app runs on the computer as any local app does
  And no address on the internet serves the site
```

- **Coverage:** `packages/admin-installer/__tests__/cli-install-app-local.test.ts` "shows the public website line for an app with a site", unit, checks that the install registers the app with the computer's data server alone. No test runs the app afterward.

```gherkin
@local
@intent:unclear @coverage:partial
Scenario: [SITES-023] A local install of an app with a site says the cloud install will publish it
  Given an app's manifest declares a public site and targets both a computer and the cloud
  When the local operator runs "cli:install-app-local" for the app
  Then the install prompt shows a "Public website" line
  And the line says the website is published when the app is installed in the cloud
```

- **Coverage:** `packages/admin-installer/__tests__/cli-install-app-local.test.ts` "shows the public website line for an app with a site", unit, checks the line. The line does not yet mention the cloud.
- **Notes:** The local prompt shows the line because a later cloud install skips the dialog for a manifest the local operator already approved (SITES-007). Today the line reads "publishes a website at /sites/<appId>/", which a local operator may read as a site that the local install itself publishes. The maintainer has not yet decided the line's words.
