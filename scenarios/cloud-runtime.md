# Cloud runtime

This file specifies what users see of a Starkeep deployment while it runs in AWS. The cloud operator watches the cloud from the computer that deployed it: the cloud Data Server card on the admin-web dashboard, the cloud's logs and resources in the AWS console, the deploy log's edge signing key, the job dispatcher, the limits that keep a flood from running up the bill, and the permission simulator in `packages/iam-permission-tests`. The cloud operator also reads the dashboard's Costs section, which needs a sign-in with cloud operator rights. The local operator opens the admin-web Storage page. The member uses cloud apps that must keep working while the deployment is busy. The app developer hosts an app's server half and build files through `@starkeep/app-client`, and receives the cloud data server's generic answers for errors and load. Each route's own outcomes belong to the file that owns the route.

Related files:

- [cloud-setup.md](cloud-setup.md): deploying and tearing down the cloud, the wizard's deployment summary, custom domains, the permission boundary as the cloud operator meets it, and the schema a deploy creates.
- [app-lifecycle.md](app-lifecycle.md): installing and updating cloud apps, publishing their build files at install, and the install's checks of routes and cold starts.
- [users-and-access.md](users-and-access.md): admin-web sign-in, the signed-out redirect, pages that answer only on the cloud's address, and request signatures.
- [app-data.md](app-data.md): job runs as members and app developers see them, and timestamps that read back alike on both surfaces.
- [shared-data.md](shared-data.md): signed file links, the thaw rate limit, and public links at the edge.
- [sync.md](sync.md): sync that resumes after the cloud comes back.
- [residency-and-stand-ins.md](residency-and-stand-ins.md): the Storage page's controls.
- [uploads-and-file-bytes.md](uploads-and-file-bytes.md): uploading file bytes to the cloud's storage.

## The cloud's health on the dashboard

The Cloud section of the admin-web dashboard holds a "Data Server" card once this computer deployed the cloud. The card checks the cloud's public liveness address, which needs no sign-in, each time the dashboard loads or refreshes.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-001] A cloud operator sees the cloud Data Server card read "Running" when the cloud answers
  Given a cloud operator deployed the cloud from this computer
  And the cloud is up
  When the cloud operator opens the admin-web dashboard
  Then the Cloud section shows a "Data Server" card with a "Built-in" badge and a spinner while the check runs
  And the spinner turns into a "Running" badge once the cloud answers
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-002] A cloud operator sees "Offline" and the reason when the cloud does not answer
  Given a cloud operator deployed the cloud from this computer
  And the cloud fails every request with "500 Internal Server Error"
  When the cloud operator opens the admin-web dashboard
  Then the cloud Data Server card shows an "Offline" badge
  And the card says "Could not reach the cloud data server: 500 Internal Server Error"
```

- **Notes:** A check that gets no answer within eight seconds, or fails at the network, shows the browser's error message after the colon instead of a status. A cloud that is only busy at its concurrency limit is CLOUD-RUN-070.

```gherkin
@cloud
@intent:unclear
Scenario: [CLOUD-RUN-070] A cloud operator sees "Offline" while the cloud is only too busy to answer the dashboard's check
  Given a cloud operator deployed the cloud from this computer
  And the deployment is at its concurrency limit, so the cloud answers the dashboard's check with "503 Service Unavailable"
  When the cloud operator opens the admin-web dashboard
  Then the cloud Data Server card shows an "Offline" badge
  And the card says "Could not reach the cloud data server: 503 Service Unavailable"
```

```gherkin
@cloud
@intent:unclear
Scenario: [CLOUD-RUN-003] A cloud operator sees "Running" even while the cloud's database cannot be reached
  Given a cloud operator deployed the cloud from this computer
  And the cloud's functions answer, but its database refuses every connection
  When the cloud operator opens the admin-web dashboard
  Then the cloud Data Server card shows "Running"
  And the card gives no sign that the database is down
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [CLOUD-RUN-004] A cloud operator sees on the card whether this browser holds a sign-in with cloud operator rights
  Given a cloud operator deployed the cloud from this computer
  And this browser <session>
  When the cloud operator opens the admin-web dashboard
  Then the cloud Data Server card shows the badge "<badge>"
  And the card's main button reads "<button>"

  Examples:
    | session                                     | badge                  | button           |
    | holds a sign-in with cloud operator rights  | Signed in as admin     | View Costs       |
    | holds no sign-in with cloud operator rights | Not signed in as admin | Sign in as admin |
```

- **Notes:** A signed-in card also shows the signed-in account's email address under its name, and its menu adds "Sign out of admin" below "Manage deployment…". Signing in and out belongs to [users-and-access.md](users-and-access.md).

Behaviors owned elsewhere:

- The wizard's own summary of the deployed cloud and its reachability: CLOUD-SETUP-047 in [cloud-setup.md](cloud-setup.md).
- The way back into the wizard through "Manage deployment…": CLOUD-SETUP-002 in [cloud-setup.md](cloud-setup.md).
- A computer that joined someone else's cloud, which shows no cloud card: CLOUD-SETUP-004 in [cloud-setup.md](cloud-setup.md).
- A local operator refused at admin-web's sign-in for lacking cloud operator rights: ACCESS-002 in [users-and-access.md](users-and-access.md).

## Costs

The dashboard's Costs section reads the AWS cost and usage report that the deploy sets up. AWS delivers the report to the deployment's billing bucket about once a day, and the report bills the whole AWS account, not only the deployment. The section appears on the computer that deployed the cloud, under the cloud apps.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-005] A cloud operator sees each service's month-to-date and projected cost, and the totals
  Given a cloud operator is signed in to admin-web on the computer that deployed the cloud
  And this month's cost report holds $1.20 for Lambda and $0.30 for S3
  When the cloud operator opens the dashboard's Costs section
  Then the section says "Includes both Starkeep and non-Starkeep service costs."
  And a table lists "Lambda" with $1.20 and then "S3" with $0.30 under "Month-to-date", each with a "Projected" amount
  And a "Total" row shows $1.50 month-to-date
```

- **Notes:** The table lists services from the largest month-to-date cost down.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-006] A cloud operator sees Aurora DSQL's cost under the name "Aurora DSQL"
  Given a cloud operator is signed in to admin-web on the computer that deployed the cloud
  And this month's cost report holds $2.02 for the deployment's database
  When the cloud operator opens the dashboard's Costs section
  Then the table lists "Aurora DSQL" with $2.02 month-to-date
```

- **Notes:** Implementation gap: the report names the database's product code `AuroraDSQL`, and the section shows that raw code, because its name table expects `AmazonAuroraDSQL`.

```gherkin
@cloud
@intent:unclear
Scenario: [CLOUD-RUN-007] A cloud operator sees Lambda, S3, and Aurora DSQL listed even when one costs nothing yet
  Given a cloud operator is signed in to admin-web on the computer that deployed the cloud
  And this month's database use so far stays inside AWS's free tier
  When the cloud operator opens the dashboard's Costs section
  Then the table lists "Aurora DSQL" with $0.00 month-to-date and $0.00 projected
  And the table lists "Lambda" and "S3" too, at $0.00 when they cost nothing
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-008] A cloud operator sees a cost of another service under its AWS product code
  Given a cloud operator is signed in to admin-web on the computer that deployed the cloud
  And the AWS account also runs a DynamoDB table outside Starkeep, which cost $0.40 this month
  When the cloud operator opens the dashboard's Costs section
  Then the table lists "AmazonDynamoDB" with $0.40 month-to-date
  And the total includes the $0.40
```

```gherkin
@cloud
@intent:unclear
Scenario: [CLOUD-RUN-009] A cloud operator sees no row for another service whose cost rounds to $0.00
  Given a cloud operator is signed in to admin-web on the computer that deployed the cloud
  And the AWS account's DynamoDB table outside Starkeep cost $0.00000075 this month
  When the cloud operator opens the dashboard's Costs section
  Then the table shows no "AmazonDynamoDB" row
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-010] A cloud operator's costs leave out tax, credits, and refunds
  Given a cloud operator is signed in to admin-web on the computer that deployed the cloud
  And this month's cost report holds $1.20 of Lambda use, a $0.10 tax line, and a $0.50 credit
  When the cloud operator opens the dashboard's Costs section
  Then the table lists "Lambda" with $1.20 month-to-date
  And the total shows $1.20
```

- **Notes:** Reserved-instance fees and recurring Savings Plan fees stay out too. The section shows what the services cost to run, not the bill after tax and credits.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-011] A cloud operator sees the month projected from the days elapsed so far
  Given a cloud operator is signed in to admin-web on the computer that deployed the cloud
  And today is the 10th of a 30-day month, by the cloud operator's computer's clock
  And this month's cost report holds $1.20 for Lambda
  When the cloud operator opens the dashboard's Costs section
  Then the "Lambda" row shows $3.60 under "Projected"
  And the "Total" row's projected amount adds up every row's projection
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-012] A cloud operator reads that the first cost report is on its way
  Given a cloud operator deployed the cloud today
  And the cloud operator is signed in to admin-web on the computer that deployed the cloud
  When the cloud operator opens the dashboard's Costs section
  Then the section says "Cost report configured — data arrives within 24 hours."
```

- **Notes:** The same line shows on the first day of a month until AWS delivers the month's first report.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-013] A cloud operator without a sign-in reads "Sign in to view cost data."
  Given a cloud operator uses admin-web on the computer that deployed the cloud
  And this browser holds no sign-in with cloud operator rights
  When the cloud operator opens the dashboard's Costs section
  Then the section says "Sign in to view cost data."
```

- **Notes:** The cloud Data Server card's "Sign in as admin" button is CLOUD-RUN-004.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-014] A cloud operator whose AWS session lapsed sees costs again without signing in
  Given a cloud operator signed in to admin-web on the computer that deployed the cloud more than an hour ago
  And the cloud operator's AWS session from that sign-in has expired, while the sign-in itself still holds
  When the cloud operator reloads the dashboard
  Then the Costs section shows the cost table without asking the cloud operator to sign in
```

- **Notes:** When the sign-in itself no longer holds, or AWS refuses the session as invalid or expired, the section says "Sign in to view cost data." instead.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-015] A cloud operator sees "Could not load cost data." when the report cannot be read
  Given a cloud operator is signed in to admin-web on the computer that deployed the cloud
  And AWS refuses the cloud operator's read of the cost report
  When the cloud operator opens the dashboard's Costs section
  Then the section says "Could not load cost data."
  And the section shows no table of zero costs
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-016] A cloud operator jumps from the Data Server card to the Costs section with View Costs
  Given a cloud operator is signed in to admin-web on the computer that deployed the cloud
  When the cloud operator clicks "View Costs" on the cloud Data Server card
  Then the dashboard scrolls to the Costs section
```

## Cost ceilings

The cloud's data plane is pay-per-use, so a flood of requests turns into a larger AWS bill rather than an outage. The deployment's gateway caps the request rate to bound that cost.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-017] A cloud operator finds requests beyond the deployment's rate limit answered "Too Many Requests"
  Given a cloud operator deployed the cloud
  When the cloud operator sends far more than 50 requests a second to the cloud's address
  Then every request beyond a burst of 100 and a steady 50 a second receives 429 "Too Many Requests"
  And the AWS console shows the cloud's functions invoked only for the requests within the limit
```

- **Notes:** The limit covers the whole deployment: every app's routes, the liveness check, and browsers' preflight requests share it.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-018] A cloud operator finds the anonymous sign-in routes for outside clients held to a lower rate
  Given a cloud operator deployed the cloud
  When the cloud operator sends far more than 5 requests a second to the routes that outside clients use to discover an app, ask for approval, and exchange a code for a token, and to the route that approves a job
  Then every request on those routes beyond a burst of 10 and a steady 5 a second receives 429 "Too Many Requests"
  And members' requests to their apps keep answering meanwhile
```

```gherkin
@cloud
@intent:unclear
Scenario: [CLOUD-RUN-019] A cloud operator finds no cap on how many data server copies run at once
  Given a cloud operator deployed the cloud into an AWS account whose concurrency limit is 10
  When the cloud operator opens the cloud data server's function in the AWS Lambda console
  Then the function shows no reserved concurrency
```

- **Notes:** The gateway's rate limit (CLOUD-RUN-017) is then the only ceiling on what a flood can cost.

Behaviors owned elsewhere:

- The per-app rate limit on thawing archived files: SHARED-133 and the thaw scenarios in [shared-data.md](shared-data.md).

## Working under load

Every request that reaches a cloud app runs one copy of the app's function, and a request through the app's data proxy runs a copy of the cloud data server too. The AWS account caps how many copies run at once, and a new account often starts at 10, which every app and every device's sync share. The gateway answers a request over the cap with a 503, and the request never starts.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-020] A member's cloud app finishes loading while the deployment is at its concurrency limit
  Given a member's deployment runs in an AWS account capped at 10 concurrent function copies
  And the member's other devices are syncing at the same time
  When the member opens the example app in the cloud
  Then every panel of the page loads, some of them a moment later than the rest
  And the page shows no error
```

- **Notes:** `docs/authoring-an-app.md` › "Limits on what your Lambda can return" tells every app to limit the requests a page sends at once and to retry a throttled request, which is safe because the work never started. The example app's `example-app/web/src/browser/request-gate.ts` keeps three requests in flight and retries a 503 or 429 up to three times. A throttle that outlasts the retries still reaches the page.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-021] A member's app code still loads while the cloud's functions are busy
  Given a cloud operator installed an app whose build files sit under "_immutable/" and "_static/"
  And the deployment's functions are all busy at the account's limit
  When a member opens the app in the cloud
  Then the member's browser loads the app's scripts, styles, and fonts at once, with no throttle error
```

- **Notes:** The edge serves both prefixes from storage, so these files cost no function copy.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-022] An app gets the answer to a server-side platform call even when the cloud throttles the first attempt
  Given an app developer's app lists a member's jobs from its server half with `listJobs`
  And the deployment is at its concurrency limit, so the cloud answers the first attempt with a 503
  When the app's server half lists the member's jobs
  Then the app receives the member's jobs after a short wait
  And the app sees no error for the throttle
```

- **Notes:** The same holds for every server-side call through the app client, such as a data call during a job run. Implementation gap: `signedFetch` in `packages/app-client/src/sign.ts` retries nothing, so `listJobs` throws on the 503 and a throttled data call inside a job run fails the run. STA-109 tracks the fix.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-023] An app's two simultaneous writes to one photo's details both succeed
  Given an app developer's app is installed in the cloud
  When the app sends two requests at the same moment, one writing a photo's width and the other its capture time
  Then both requests succeed
  And the app receives both the new width and the new capture time when it reads the photo back
```

- **Notes:** The cloud's database refuses one of two racing writes until it retries, and the data server retries such a write with a short backoff, up to six attempts, after reading the row again. A write that fails for any other reason fails at once with a server error.

```gherkin
@cloud
@intent:unclear
Scenario: [CLOUD-RUN-024] An app's first data request right after its cloud install succeeds after a short wait
  Given a cloud operator just installed an app developer's app in the cloud
  And the database has not yet accepted the app's new database identity
  When the app sends its first data request
  Then the app receives the answer after a wait of up to about twelve seconds
  And the app sees no error for the delay
```

- **Notes:** The data server retries a refused connection up to six times, waiting 0.5, 1, 2, 4, and 4 seconds, which stays under the gateway's 30-second limit. A delay longer than that fails the request.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-025] An app's next request succeeds after an idle database connection drops
  Given an app developer's app is installed in the cloud
  And a database connection that served an earlier request drops while the function sits idle
  When the app sends its next request
  Then the app receives its answer as usual
```

- **Notes:** Each request opens its own database connections and closes them before it answers, and a dropped connection only logs "[cds] pg client async error:" with the reason. Before this held, such a drop killed the function mid-request and the gateway answered a bare 500.

## Errors an app receives

These are the cloud data server's answers for failures that no route answers in its own terms. Each route's own refusals belong to the file that owns the route.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-026] An app receives a generic server error that reveals nothing internal
  Given an app developer's app is installed in the cloud
  And the cloud data server fails unexpectedly while answering one of the app's requests, for example because a query fails for a reason other than a conflict
  When the app sends that request
  Then the app receives a 500 answer whose body is {"error": "Internal server error"}
  And the answer names no table, query, or stack trace
```

```gherkin
@cloud
@intent:unclear
Scenario: [CLOUD-RUN-027] An app's row request that fails inside the cloud gets a server error, not a bad-request answer
  Given an app developer's app is installed in the cloud
  And the cloud's database fails the app's query with a transient error
  When the app reads rows from one of its own tables
  Then the app receives a server error that it may retry
  And the app does not receive a 400 answer, which would tell it the request itself was wrong
```

- **Notes:** A row request that is itself wrong, such as one naming a table the app never declared, still gets a 400 with the reason. Implementation gap: the row route `/app-data/db/<table>` answers every thrown error with a 400 that carries the raw message, and logs nothing.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-028] An app whose storage access is refused gets a forbidden answer
  Given an app developer's app is installed in the cloud
  And the app's request reaches a stored file that the app's cloud role may not touch
  When the app sends the request
  Then the app receives a 403 answer whose body is {"error": "AccessDenied"}
```

- **Notes:** The 403 lets an app tell a permission problem from a server fault. The route-level grant checks in [users-and-access.md](users-and-access.md) refuse most such requests before any storage call.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-029] An app that calls a path the cloud does not have gets "Not found"
  Given an app developer's app is installed in the cloud
  When the app sends a signed request to a data path the cloud data server does not offer
  Then the app receives a 404 answer whose body is {"error": "Not found"}
```

## The cloud's logs

The cloud operator reads the cloud's logs in CloudWatch, in the AWS console. The cloud data server runs as several functions, each with its own log group named `/aws/lambda/<prefix>-app-cloud-data-server-<function>`.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-030] A cloud operator finds the cause of a server error in the data server's log
  Given an app received a 500 "Internal server error" answer from the cloud
  When the cloud operator opens the log group "/aws/lambda/<prefix>-app-cloud-data-server-api" in the AWS console
  Then the cloud operator finds a line starting "Handler error:" with the error's message and stack at the time of the answer
```

- **Notes:** A storage refusal logs "Handler access denied:" with the message instead, as a warning.

```gherkin
@cloud
@intent:unclear
Scenario: [CLOUD-RUN-069] A cloud operator finds which request failed from the data server's error line
  Given an app received a 500 "Internal server error" answer from the cloud
  When the cloud operator opens the data server's log in the AWS console
  Then the "Handler error:" line names the request's method, its path, and the calling app
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-031] A cloud operator finds each cloud data server function's log kept for 14 days
  Given a cloud operator deployed the cloud
  When the cloud operator opens CloudWatch's log groups in the AWS console
  Then the cloud operator finds one log group for each of the data server's functions: "api", "dispatcher", "session-authorizer", "origin-authorizer", and "delegated-authorizer"
  And each log group keeps its entries for 14 days
```

- **Notes:** Each cloud app's own functions keep their logs for 14 days too.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-032] A cloud operator sees why an app's request was slow in the log, one refused database connection at a time
  Given an app's request to the cloud took several seconds to answer
  And the database refused the cloud's connections for that app for a few seconds before accepting them
  When the cloud operator opens the data server's log in the AWS console
  Then the cloud operator finds one line per refused attempt: "[cds] dsql connect for <appId>: attempt <n> refused (<reason>) at <elapsed>s, retrying in <wait>s"
  And a closing line "[cds] dsql connect for <appId>: succeeded on attempt <n> after <elapsed>s"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-033] A cloud operator sees the uninstall command exit promptly once its work is done, even when a database connection dies
  Given a cloud operator has an app installed in the cloud
  And the database will drop one of the uninstall's connections without closing it
  When the cloud operator runs `pnpm --filter @starkeep/admin-installer cli:uninstall-app <appId>`
  Then the command prints the uninstall's own result
  And the command prints "[diag] idle DSQL connection error (<database host>): <reason>" as a warning
  And the command exits within a few seconds with the uninstall's exit code, rather than crashing or hanging for minutes
```

- **Notes:** A closing connection whose server never answers gets two seconds before the command drops it. Before this held, `cli:uninstall-app` printed "probe cloud uninstall complete." and then crashed with `read ETIMEDOUT`, exiting 1 (STA-102). The install commands and the schema setup open their database connections the same way.

## The job dispatcher

The job dispatcher is the cloud data server's function that runs members' background jobs. The members' and app developers' view of each run belongs to [app-data.md](app-data.md).

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-034] A cloud operator finds the dispatcher waking every five minutes from one rule that enrollments never change
  Given a cloud operator deployed the cloud
  And members have turned jobs on and changed their times since the deploy
  When the cloud operator opens the EventBridge rules in the AWS console
  Then the cloud operator finds one rule "<prefix>-jobs-tick" with the schedule "rate(5 minutes)" and the description "Wakes the Starkeep job dispatcher, which runs each due job enrollment."
  And the rule targets the function "<prefix>-app-cloud-data-server-dispatcher"
  And the cloud operator finds no other rule for members' jobs
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [CLOUD-RUN-035] A cloud operator finds one log line per job run, with its outcome and duration and never its token
  Given a member's job run ended with the outcome <outcome>
  When the cloud operator opens the dispatcher's log in the AWS console
  Then the cloud operator finds the line "[jobs] enrollment=<enrollment id> app=<app id> job=<job name> outcome=<outcome> durationMs=<milliseconds>"
  And no line holds the run's token

  Examples:
    | outcome  |
    | ok       |
    | failed   |
    | deferred |
    | stopped  |
    | skipped  |
```

- **Notes:** "deferred" is a run the cloud could not start right now, which runs at the next wake. "stopped" is a job the dispatcher turned off, for example for a signed-out member. "skipped" is a due job that another run already held, or that the member turned off since the wake read it.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-036] A cloud operator finds a dispatcher failure in the log, and the run recorded as failed
  Given the dispatcher itself fails while running a member's job, for example because it cannot read the edge signing parameter that names the cloud's address
  When the cloud operator opens the dispatcher's log in the AWS console
  Then the cloud operator finds "[jobs] run <enrollment id> failed in the dispatcher:" with the error
  And the run's line reads "outcome=failed"
```

- **Notes:** The member reads "The dispatcher failed: <message>" as the run's message, which [app-data.md](app-data.md) owns (APP-DATA-108).

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [CLOUD-RUN-037] A cloud operator finds a warning when a run loses its lease
  Given a member's job run <when>
  When the cloud operator opens the dispatcher's log in the AWS console
  Then the cloud operator finds the warning "<warning>"

  Examples:
    | when                                                                  | warning                                                          |
    | was started with "run now" but its claim passed before the run began  | [jobs] manual run <enrollment id> lost its lease before it started |
    | outlasted its claim, so another run held the job when it finished     | [jobs] run <enrollment id> lost its lease before it finished     |
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-038] A cloud operator's failed dispatcher wake is not retried, and the next wake runs the due jobs
  Given the dispatcher's function failed on one wake
  When the cloud operator watches the dispatcher's log through the next ten minutes
  Then the cloud operator finds no second attempt of the failed wake
  And the next wake, five minutes later, runs the jobs that are still due
```

- **Notes:** A retried wake would duplicate the next one, and a retried "run now" would find its claim already released.

Behaviors owned elsewhere:

- A job running at the member's time, up to five minutes late: APP-DATA-111 in [app-data.md](app-data.md).
- A run the cloud cannot start right now, postponed to the next wake: APP-DATA-118 in [app-data.md](app-data.md).
- At most two runs at once across the deployment: APP-DATA-131 in [app-data.md](app-data.md).

## Hosting an app's server half

In the cloud, the platform mounts each app under `/apps/<appId>` and runs the app's server half as a function behind the gateway. An app adapts its Hono server to that function with `createWebAppHandler` and `honoUpstream` from `@starkeep/app-client`. On a member's computer the same Hono app runs as an ordinary local server at its own address.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [CLOUD-RUN-039] An app's routes, written without the mount prefix, answer on both surfaces
  Given an app developer's Hono app declares the route "/api/records"
  And the app's cloud entry wraps it with `honoUpstream`
  When the app developer requests "/apps/<appId>/api/records" in the cloud and "/api/records" on the local server
  Then the app's "/api/records" route answers both requests
  And a path the app has no route for reaches the app's not-found answer under its app-relative path
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-040] An app receives both spellings of its root address as its root
  Given an app developer's app is installed in the cloud with a route for "/"
  And the app developer is signed in to the app
  When the app developer opens "/apps/<appId>" and then "/apps/<appId>/" at the cloud's address
  Then the app's "/" route answers both
```

- **Notes:** The gateway can register only the bare spelling as a public route, so an anonymous request for the trailing-slash spelling meets the sign-in gate. Pages that answer only at the cloud's address belong to [users-and-access.md](users-and-access.md) (ACCESS-047).

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [CLOUD-RUN-041] An app that needs its own mount reads it from the platform
  Given an app developer's app builds an absolute link with `appBasePath()`
  When the app runs <where>
  Then `appBasePath()` returns "<mount>"

  Examples:
    | where                                     | mount         |
    | in the cloud after the cloud operator's install | /apps/<appId> |
    | on a member's computer                    |               |
```

- **Notes:** The value never ends in a slash, so a joined path never doubles one.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-042] An app that sets two cookies in one answer finds both in the browser
  Given an app developer's app answers a sign-in by setting a session cookie and a token cookie in one response
  When the app developer signs in to the app in the cloud
  Then the app developer's browser holds both cookies
  And the app receives both cookies on the next request
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [CLOUD-RUN-043] An app's compressed or binary answer reaches the browser intact
  Given an app developer's app answers a request with <body>
  When the app developer's browser requests it in the cloud
  Then the browser receives the same bytes the app sent

  Examples:
    | body                                                        |
    | gzip-compressed JavaScript, marked "Content-Encoding: gzip" |
    | a PNG image                                                 |
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-044] An app receives the request's body, query string, and encoded path segments unchanged
  Given an app developer's app declares the route "/api/items/:name"
  When the app developer sends a POST with a JSON body to "/apps/<appId>/api/items/caf%C3%A9?sort=asc" in the cloud
  Then the app's route receives the name "café", the query "sort=asc", and the JSON body as sent
  And the request's own URL still carries the cloud's host, so the app can build an absolute address from it
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-045] An app whose module exports no handler fails at startup with a message naming the module
  Given an app developer's cloud entry passes `createWebAppHandler` a module that exports no `handler`
  And a cloud operator installed the app in the cloud
  When the app developer opens the app
  Then the app's function log shows "Starkeep Lambda entry: the app's request upstream does not export a `handler` function (got undefined). The entry resolves this during INIT, so the deployment fails at startup rather than on the first request."
  And the app serves no request
```

- **Notes:** A module whose import throws also fails at startup, with the import's own error.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-046] An app's code loads before its first request, so a cold start's first request does not pay for it
  Given an app developer's cloud entry passes its module to `createWebAppHandler` as an already-started import
  When the app developer opens the app in the cloud for the first time after a deploy
  Then the function log's "Init Duration" includes loading the app's code
  And the first request's own duration does not
```

- **Notes:** The entry takes a promise rather than a function that imports later, so the code loads during the function's startup phase, which runs faster and has its own time budget. The install's own cold-start checks belong to [app-lifecycle.md](app-lifecycle.md) (APP-LIFE-134, APP-LIFE-135).

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-047] An app that asks for legible failures answers its own thrown errors
  Given an app developer's cloud entry passes `onError` to `createWebAppHandler`
  And one of the app's routes throws
  When the app developer's browser requests that route in the cloud
  Then the browser receives the answer that the app's `onError` built
```

- **Notes:** Without `onError`, the adapter rethrows, and the app's framework or the gateway reports the failure as it would without the adapter.

Behaviors owned elsewhere:

- A signed-out page load sent to the app's own sign-in page, and a signed-out script call answered 401: ACCESS-028 and ACCESS-029 in [users-and-access.md](users-and-access.md).
- The signature on an app's proxied data calls: ACCESS-093 in [users-and-access.md](users-and-access.md).

## Serving an app's files from its own function

An app names the files its server half serves from disk with the manifest's `staticAssetPaths`, its forever-cached paths with `immutablePaths`, and its client routes with `shellPaths`. The cloud adapter and the local `serveStatic` middleware answer them with the same rules, so a file behaves alike on both surfaces. Files under the reserved `_immutable/` and `_static/` prefixes are served at the edge instead, as the next section describes.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [CLOUD-RUN-048] An app's declared files are served with the content type their extension names
  Given an app developer's app declares "<path>" among its served files, and its build holds the file
  When the app developer's browser requests the file
  Then the answer's content type is "<type>"

  Examples:
    | path            | type                                   |
    | /app.js         | application/javascript; charset=utf-8  |
    | /logo.svg       | image/svg+xml                          |
    | /engine.wasm    | application/wasm                       |
    | /data.bin       | application/octet-stream               |
```

- **Notes:** WebAssembly needs its own type, because streaming compilation refuses any other. A file whose extension the platform does not know gets plain bytes rather than a guess.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [CLOUD-RUN-049] An app answers a revalidation of an unchanged file with "not modified" and no body
  Given an app developer's app serves "/manifest.webmanifest" from its build
  And the app developer's browser fetched the file before and kept its tag
  When the app developer's browser asks for the file again with that tag
  Then the browser receives a 304 answer with no body
```

- **Notes:** A tag that no longer matches gets the whole file and its new tag.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [CLOUD-RUN-050] An app's files are cached forever only on the paths the app names
  Given an app developer's app passes <immutable> as its forever-cached paths
  When the app developer's browser requests "<path>" from the app's served files
  Then the answer says "Cache-Control: <cache>"

  Examples:
    | immutable      | path                  | cache                               |
    | ["/assets/*"]  | /assets/app.3f2a.js   | public, max-age=31536000, immutable |
    | ["/assets/*"]  | /manifest.webmanifest | public, max-age=0, must-revalidate  |
    | []             | /assets/app.3f2a.js   | public, max-age=0, must-revalidate  |
```

- **Notes:** Locally, an app passes the platform's reserved "/_immutable/*" here, and the same headers apply. In the cloud the edge serves that prefix from storage with the same headers, which [app-lifecycle.md](app-lifecycle.md) owns (APP-LIFE-125).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [CLOUD-RUN-051] An app's own route answers an undeclared path even when a file of that name exists
  Given an app developer's build holds "/notes.txt", which the app does not declare among its served files
  When the app developer's browser requests "/notes.txt"
  Then the app's own route for the path answers, and the file is not served
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [CLOUD-RUN-052] An app's own route answers a declared path that has no file, by default
  Given an app developer's app declares "/files/*" among its served files and also answers "/files/index" in its own routes
  And the build holds no file named "/files/index"
  When the app developer's browser requests "/files/index"
  Then the app's own "/files/index" route answers
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [CLOUD-RUN-053] An app that owns a whole prefix answers a missing file there with "Not found"
  Given an app developer's app declares "/assets/*" among its served files with the miss rule "notFound"
  When the app developer's browser requests "/assets/missing.js"
  Then the browser receives a 404 answer with the text "Not found"
  And the app's own routes never see the request
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [CLOUD-RUN-054] An app refuses a path that escapes its files with "Bad path"
  Given an app developer's app declares "/files/*" among its served files
  When the app developer's browser requests a path under "/files/" that climbs out of the build folder with ".."
  Then the browser receives a 400 answer with the text "Bad path"
```

- **Notes:** A declared path that names a folder counts as a missing file, never as a folder listing.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [CLOUD-RUN-055] An app answers its client routes with the page shell, which is never cached forever
  Given an app developer's app declares "/", "/settings", and "/study/*" as client routes, and its build holds "index.html"
  When the app developer's browser requests "/study/42"
  Then the browser receives "index.html" with "Cache-Control: public, max-age=0, must-revalidate"
  And the app's own routes never see the request
```

- **Notes:** In the cloud the app root answers with the shell in both spellings, "/apps/<appId>" and "/apps/<appId>/".

```gherkin
@local @cloud
@intent:confirmed
Scenario: [CLOUD-RUN-056] An app serves a real file over the page shell at the same path
  Given an app developer's app declares "/about.html" among its served files and "/*" as a client route
  And the build holds "about.html"
  When the app developer's browser requests "/about.html"
  Then the browser receives "about.html", not the shell
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [CLOUD-RUN-057] An app's own routes answer a client route when the shell file is missing
  Given an app developer's app declares "/settings" as a client route, but the build holds no "index.html"
  When the app developer's browser requests "/settings"
  Then the app's own routes answer the request
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [CLOUD-RUN-058] An app that declares served files without a folder for them fails at startup with a message
  Given an app developer's <entry> declares <declared> but passes no folder for the build's files
  When the app developer starts the app
  Then the app fails to start with "<message>"

  Examples:
    | entry                       | declared            | message |
    | cloud `createWebAppHandler` | one served path     | Starkeep web adapter: staticPaths declares 1 path(s) served from disk but no assetsDir was given, so every one of them would fall through. Pass assetsDir, or declare no staticAssetPaths in the manifest. |
    | cloud `createWebAppHandler` | three client routes | Starkeep web adapter: shellPaths declares 3 client route(s) answered with index.html from disk but no assetsDir was given. Pass assetsDir, or declare no shellPaths. |
    | local `serveStatic`         | any served paths    | Starkeep static responder: assetsDir is required. |
```

## Serving through the edge

The cloud's public address is a CloudFront distribution in front of the gateway. Build files under each app's `_immutable/` and `_static/` prefixes come from the platform's app assets bucket at the edge, and every other request goes on to the gateway.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-059] A member's page loads a build file larger than a function answer can carry
  Given a cloud operator installed an app whose build holds a 20 MB WebAssembly file under "_static/"
  When a member opens the app in the cloud
  Then the member's browser loads the whole 20 MB file
  And the app starts in the browser
```

- **Notes:** A function's answer holds at most 6 MB. The install refuses a file over 4 MB that the app's own function would have to serve, which [app-lifecycle.md](app-lifecycle.md) owns (APP-LIFE-127).

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-060] An app developer gets a hashed build file from the edge cache on a repeat load
  Given a cloud operator installed an app developer's app, whose page names a script under "_immutable/"
  And the script was loaded once through the cloud's address
  When the app developer loads the script again through the cloud's address
  Then the answer's "x-cache" header reads "Hit from cloudfront"
  And the answer's "server" header reads "AmazonS3", with "Cache-Control: public, max-age=31536000, immutable"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-061] A member never receives another member's answer from the edge cache
  Given two members use Photos in the cloud
  And the first member just loaded the photo list
  When the second member loads the photo list at the same address
  Then the second member sees only the second member's own photos
```

- **Notes:** The edge caches no answer from the gateway except public-link pages, which [shared-data.md](shared-data.md) owns (SHARED-177).

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-062] An app gets the same answer to a bearer-token call through the cloud's address as on the gateway
  Given an app developer's app declares a route that requires a member's bearer token
  When the app developer calls the route with a member's token through the cloud's address and on the gateway's own address
  Then both calls receive the same answer
```

- **Notes:** The edge forwards every request header except Host, so sign-in tokens and request signatures arrive as sent.

Behaviors owned elsewhere:

- Publishing the build files at install, keeping the previous deployment's files, and the size and bucket checks: APP-LIFE-125 to APP-LIFE-129 in [app-lifecycle.md](app-lifecycle.md).
- An app's pages answering only at the cloud's address, never on the gateway's own hostname: ACCESS-047 in [users-and-access.md](users-and-access.md).
- A public link answering from the edge cache for up to a minute: SHARED-177 in [shared-data.md](shared-data.md).
- A tampered signed file link refused at the edge: SHARED-100 in [shared-data.md](shared-data.md), and on a custom domain CLOUD-SETUP-106 in [cloud-setup.md](cloud-setup.md).

## The edge signing key

The cloud signs file links and public-link files with a CloudFront key that the deploy generates. The deploy stores the key, the cloud's canonical address, and every address the distribution answers on in one encrypted parameter in AWS Systems Manager Parameter Store. Only the cloud data server reads it.

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-063] A cloud operator finds the edge signing key stored with every address the cloud answers on
  Given a cloud operator's deployment already serves a custom domain
  When the cloud operator redeploys the cloud data server
  Then the deploy's log shows "Persisting CloudFront signing config to SSM…" and then "CloudFront signing config persisted."
  And Parameter Store holds the SecureString "/<prefix>/app-creds/_cloudfront-signing", tagged "starkeep:appId" "cloud-data-server" and "starkeep:managed" "true"
  And the parameter's value names the custom domain as the canonical address, and lists both the custom domain and the cloudfront.net address
```

- **Notes:** The parameter's description reads "CloudFront shared-file URL-signing config (keyPairId/domain/privateKey). Created by admin-installer." The cloud uses the list to keep a visit's sign-in and signed links on the address the visit used, which [cloud-setup.md](cloud-setup.md) owns (CLOUD-SETUP-104, CLOUD-SETUP-107).

```gherkin
@cloud
@intent:confirmed
Scenario: [CLOUD-RUN-064] A cloud operator finds the signing key's parameter rewritten in place after a redeploy
  Given a cloud operator deployed the cloud before
  When the cloud operator redeploys the cloud data server
  Then Parameter Store shows a new version of "/<prefix>/app-creds/_cloudfront-signing" with the deploy's current key and addresses
  And the parameter keeps its tags
```

```gherkin
@cloud
@intent:unclear
Scenario: [CLOUD-RUN-065] A cloud operator whose signing parameter is damaged finds file links failing and the reason in the log
  Given a cloud operator hand-edited "/<prefix>/app-creds/_cloudfront-signing" so that its value lacks the private key
  And members report that Photos in the cloud shows no images
  When the cloud operator opens the data server's log in the AWS console
  Then the cloud operator finds a "Handler error:" line with "CloudFront signing parameter is malformed" for each file link request
  And each of those requests was answered with "Internal server error"
```

- **Notes:** Every other use of the parameter fails the same way: OAuth discovery for outside clients and every job run, which records "The dispatcher failed: CloudFront signing parameter is malformed". A redeploy writes the parameter again (CLOUD-RUN-064). A deleted parameter fails with AWS's own not-found error instead.

Behaviors owned elsewhere:

- Signed links and sign-in on a custom domain and on the cloudfront.net address: CLOUD-SETUP-104 to CLOUD-SETUP-107 in [cloud-setup.md](cloud-setup.md).
- Deleting the signing key at teardown: CLOUD-SETUP-119 in [cloud-setup.md](cloud-setup.md).
- The grant checks before the cloud signs a file link, and a forged or expired link: SHARED-099 and SHARED-100 in [shared-data.md](shared-data.md).

## Checking permissions before a deploy

The permission simulator in `packages/iam-permission-tests` checks the AWS calls the installer and the cloud make against the policies and boundaries they run under, without touching a live deployment. The cloud operator runs it from a Starkeep checkout with `pnpm simulate --context=<name>`, and `pnpm simulate --list-contexts` lists the contexts.

```gherkin
@local
@intent:confirmed
Scenario: [CLOUD-RUN-066] A cloud operator sees the permission check pass when every modeled AWS call is allowed
  Given a cloud operator has a Starkeep checkout with the current policies
  When the cloud operator runs `pnpm simulate --context=install-cloud-data-server` in `packages/iam-permission-tests`
  Then the output names the context and its principal, and lists the modeled calls under "== Expected calls (modeled) =="
  And the command exits 0
```

```gherkin
@local
@intent:confirmed
Scenario: [CLOUD-RUN-067] A cloud operator sees the permission check list each denied call with its reason and fail
  Given a cloud operator changed a policy so that one modeled call of the cloud data server's install is no longer allowed
  When the cloud operator runs `pnpm simulate --context=install-cloud-data-server` in `packages/iam-permission-tests`
  Then the output lists the call's action and resource under "DENIED by policy/boundary:", with a "why:" line saying what the call is for
  And the command exits 1
```

- **Notes:** The cloud operator may also pass trace files captured from a real install. Calls in the traces that the policies deny are listed the same way, under the principal that made them.

## The Storage page

```gherkin
@local
@intent:confirmed
Scenario: [CLOUD-RUN-068] A local operator opening the Storage page reads what this computer keeps, and finds the way back
  Given the local operator uses admin-web on a computer that runs the local data server
  When the local operator opens the Storage page
  Then the page shows the heading "Storage" with an "Experimental" badge
  And the page says "This machine keeps every file in your Starkeep library, except large photo and video originals, which can be downloaded on demand. It also keeps photo and video previews up to its ceiling. Turn on "Keep originals here" to keep every original too. Nothing is removed unless you free up space."
  And a "Photos & videos" panel holds the page's controls
  And a "← Dashboard" link leads back to the dashboard
```

- **Notes:** The panel's controls belong to [residency-and-stand-ins.md](residency-and-stand-ins.md), except "Reclaim deleted files" in [shared-data.md](shared-data.md) and "Check sync integrity" in [sync.md](sync.md).
