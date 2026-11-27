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
@intent:confirmed
Scenario: [SITES-001] A visitor reads a public site's home page without signing in
  Given a cloud operator installed an app whose manifest declares a public site
  And the visitor holds no account on the deployment
  When the visitor opens "https://<deployment>/sites/<appId>/"
  Then the visitor sees the site's home page
  And no sign-in page appears
```

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-002] A visitor follows a link to a page in a site's subfolder
  Given a cloud operator installed an app whose public site holds an "about/" folder with its own home page
  When the visitor opens the site's home page
  And the visitor follows a link to "about/"
  Then the visitor sees the about page
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [SITES-003] A visitor who leaves off the trailing slash still lands on the page, with its images
  Given a cloud operator installed an app whose public site holds an "about/" folder with a page that shows an image by a relative link
  When the visitor types "<address>" into the browser
  Then the browser moves to "<lands on>"
  And the visitor sees the page with its image

  Examples:
    | address                                   | lands on                                     |
    | https://<deployment>/sites/<appId>        | https://<deployment>/sites/<appId>/          |
    | https://<deployment>/sites/<appId>/about  | https://<deployment>/sites/<appId>/about/    |
```

- **Notes:** An address whose last segment has a dot, such as `/sites/<appId>/about.html`, names a file and loads that file. An address whose last segment has no dot names a folder.

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-004] A visitor who opens a page the site does not have sees a not-found answer
  Given a cloud operator installed an app whose public site has no "missing.html"
  When the visitor opens "https://<deployment>/sites/<appId>/missing.html"
  Then the browser shows a "404 Not Found" answer
```

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
@intent:confirmed
Scenario: [SITES-005] A signed-in member sees the same public site as a visitor
  Given a member is signed in to the deployment's cloud apps in a browser
  And a cloud operator installed an app whose manifest declares a public site
  When the member opens "https://<deployment>/sites/<appId>/"
  Then the member sees the same home page a visitor sees
  And the page shows none of the member's data
```

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-006] Visits to a public site run none of the deployment's app code
  Given a cloud operator installed an app whose manifest declares a public site
  When many visitors read the site at the same moment
  Then the AWS console shows no Lambda invocation for any of the visits
  And members' cloud apps answer as quickly as before the visits
```

## Installing an app with a public site

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-007] A cloud operator sees before installing that the app publishes a public website
  Given an app's manifest declares a public site
  When the cloud operator opens the app's install dialog in admin-web
  Then the dialog shows a "Public website" section
  And the section says the app publishes a website at "/sites/<appId>/" that anyone on the internet can read without signing in
```

- **Notes:** A local install of the same app shows the same section, because a cloud install skips the dialog for a manifest the local operator already approved.

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-008] The cloud install prints the site's address and checks that it answers
  Given an app's manifest declares a public site
  When the cloud operator runs the app's cloud install
  Then the install output names the site's address "https://<deployment>/sites/<appId>/"
  And the install output reports that the address answered
```

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-009] A cloud operator sees which installed cloud apps publish a public site
  Given a cloud operator installed an app whose manifest declares a public site
  And the cloud operator installed another app without one
  When the cloud operator opens the Cloud section of the admin-web dashboard
  Then the card of the app with a site shows a "Public site" link to "https://<deployment>/sites/<appId>/"
  And the other app's card shows no such link
```

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-014] A site-only app installs without any Lambda
  Given an app's manifest declares a public site and no compute
  When the cloud operator runs the app's cloud install
  Then the install finishes
  And the visitor reads the site at "https://<deployment>/sites/<appId>/"
  And the AWS console shows no Lambda function for the app
```

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-015] An install on a deployment that predates public sites warns and names the update
  Given the cloud operator has not updated the bootstrap stack or reinstalled the cloud data server since public sites arrived
  And an app's manifest declares a public site
  When the cloud operator runs the app's cloud install
  Then the install output warns that the site's address does not answer
  And the warning tells the cloud operator to update the bootstrap stack and then reinstall the cloud data server
```

## Updating and removing a public site

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-010] A visitor sees an updated site soon after the cloud operator reinstalls the app
  Given a cloud operator installed an app whose public site's home page reads "Version one"
  And the app developer changed the home page to read "Version two"
  When the cloud operator reinstalls the app
  And a visitor opens the site's home page a minute later
  Then the visitor sees "Version two"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-011] A page the new version removed no longer loads
  Given a cloud operator installed an app whose public site holds "old.html"
  And the app developer removed "old.html" from the site
  When the cloud operator reinstalls the app
  And a visitor opens "https://<deployment>/sites/<appId>/old.html" a minute later
  Then the browser shows a "404 Not Found" answer
```

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-012] A site disappears when the cloud operator uninstalls its app
  Given a cloud operator installed an app whose manifest declares a public site
  When the cloud operator uninstalls the app's web app
  And a visitor opens the site's home page a minute later
  Then the browser shows a "404 Not Found" answer
```

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-013] A site disappears when a reinstall's manifest no longer declares it
  Given a cloud operator installed an app whose manifest declares a public site
  And the app developer removed the public site from the manifest
  When the cloud operator reinstalls the app
  And a visitor opens the site's home page a minute later
  Then the browser shows a "404 Not Found" answer
```

## Declaring a public site

```gherkin
@cloud
@intent:confirmed
Scenario: [SITES-016] A manifest that declares a site but no cloud target is refused
  Given an app developer's manifest declares a public site
  And the manifest's targets omit "cloud"
  When the app developer validates the manifest
  Then validation fails with an error that says a public site is published only from the cloud
```

```gherkin
@cloud
@intent:confirmed
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

```gherkin
@local
@intent:confirmed
Scenario: [SITES-018] A local install of an app with a site publishes nothing
  Given an app's manifest declares a public site
  When the local operator installs the app on a computer
  Then the app runs on the computer as any local app does
  And no address on the internet serves the site
```
