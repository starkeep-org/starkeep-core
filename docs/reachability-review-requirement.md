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
- **Record the unsurprising rows too.** The value is the table existing, so a
  later review can diff it. The defect this pass catches is a capability whose
  answer got _weaker_ between two revisions while each individual change looked
  locally correct.

## Where the answers live in this system

Three facts about the platform decide most rows, and all three are easy to get
wrong from memory:

- The cloud data plane has **no JWT authorizer**. It authenticates the _app_ via
  HMAC, not the end user. End-user identity is each app's own responsibility —
  see `data-roles-and-permissions.md`, "How data access actually flows at
  runtime", and `authoring-an-app.md` §10.
- **CloudFront is not a security boundary.** The API Gateway origin stays
  directly reachable by design. Any row that ends at "the edge blocks it" is
  wrong.
- A manifest handler's `auth: "public"` on a catch-all makes **every** path
  under `/apps/<appId>/` anonymous, including routes the app's bundle mounts
  that the manifest never names. The handler's `publicPaths` declaration states
  the _intent_; it does not narrow the reach.
