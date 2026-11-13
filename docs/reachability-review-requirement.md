# Reachability review requirement

The reachability review traces each credential, signing capability, role assumption and privileged operation in a change to the least-authenticated party that can make it run. Run the review during any code review, security review or functional review that touches one of these. The review produces a table, and later reviews compare their tables against it to catch a capability whose reachable caller became weaker.

## The procedure

For each **credential, signing capability, or privileged operation** in the code
under review — an HMAC secret, a CloudFront or S3 signing key, an
`sts:AssumeRole`, a presign call, a token minter, an unbounded delete, anything
that spends money — trace _outward_, away from the code and toward its callers,
until you reach the least-authenticated party that can cause it to run. Write
that party down.

Produce a table. The table is the deliverable; a paragraph saying "the auth
looks fine" is not the same artifact and does not compose.

| Capability                                           | Where it lives                                                     | Least-authenticated reachable caller                     |
| ---------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| Signs data-plane requests with the app's HMAC secret | `photos/app/api/local-data/[...path]/route.ts`                     | anonymous internet                                       |
| Mints CloudFront signed URLs for `shared/*`          | `cloud-data-server/src/api-handler.ts` (`signSharedCloudFrontUrl`) | any app with a valid HMAC signature and a matching grant |
| Assumes a per-app role                               | `cloud-data-server` broker path                                    | any app with a valid HMAC signature                      |

## Rules

- **Trace outward, not inward.** The question is never "what does this check?"
  It is "who can get here?" A caller that arrives through three hops, two of
  which check nothing, is still this capability's caller.
- **Follow the weakest path, not the intended one.** When two paths reach a
  capability, the answer is the weaker one. The intended path is usually the one
  the comments describe, which is why reading comments is not this pass.
- **Client-side checks are not checks.** `AuthGate`, a disabled button, a
  validated form — none of them constrain a caller. Cross them out and keep
  tracing.
- **A name that implies a boundary is not a boundary.** `/api/local-data` was
  accurate at first and later named the primary cloud data path. Check the
  route table, not the identifier.
- **Name a party, not a mechanism.** "Anonymous internet", "any signed-in user",
  "any installed app", "operator on the local machine" are answers. "Behind the
  proxy", "requires the signature" are not — keep going until you can name who.
- **Trace what the output reaches, not only who reaches the code.** A signed
  URL, a token or a redirect outlives the request that minted it. Ask who ends
  up holding it, how long it works, and whether it can be forwarded. When the
  output is something a browser opens, ask what the browser does with the
  response on the origin that serves it. A file whose type lets it run script
  runs with every cookie and permission of that origin. The response's type
  and disposition then decide reach as much as the signer's checks do, and
  the type stored by whoever uploaded the file is not a check. Write the widest
  consequence into the caller column, for example "anonymous internet, and any
  signed-in user who opens the link".
- **Record the unsurprising rows too.** The value is the table existing, so a
  later review can diff it. The defect this pass catches is a capability whose
  answer got _weaker_ between two revisions while each individual change looked
  locally correct.

## Where the answers live in this system

Four facts about the platform decide most rows, and all four are easy to get
wrong from memory:

- The cloud data plane has **no JWT authorizer**. It authenticates the _app_ via
  HMAC, not the end user. End-user identity is each app's own responsibility —
  see `data-roles-and-permissions.md`, "How data access actually flows at
  runtime", and `authoring-an-app.md` §10.
- **CloudFront authenticates no one.** The API Gateway origin stays directly
  reachable by design. CloudFront's secret origin header separates two
  origins: an app's routes refuse a request without it, and the consent and
  connections pages refuse a request with it. The broker's data plane answers
  either way. Any row that ends at "the edge blocks it" is wrong.
- **One CloudFront domain serves everything.** The cloud apps' pages and
  APIs, and every signed `shared/*` file, share one origin. A file that renders
  as a page there runs as the signed-in apps, so a signed file URL's response
  type is part of its reach.
- **No author declares a route anonymous.** `auth: "public"` is retired. The
  only anonymous app routes are the ones a `session` handler's `publicPaths`
  derive, and the validator bounds those to platform pages and the handler's
  static files. A `delegated` route admits anyone holding a delegation token
  for that app, which any signed-in user can create for their own data.
