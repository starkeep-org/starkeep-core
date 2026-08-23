# The reachability pass

A review step for this repo. Run it during any code review, security review, or
functional review that touches a credential, a signing capability, a role
assumption, or a privileged operation. It takes a few minutes and it is the one
review practice here that was added in response to something that actually
happened rather than something that might.

## Why it exists

On 2026-08-23 an audit found that both cloud-deployed Starkeep apps served their
entire data plane to unauthenticated callers, and had done so for three months.
The striking part is not that a review missed it. It is that a review had
already written down every fact needed to conclude it.

`meta-docs/docs/functional-doc-cloud-apps-2026-06-05.md` states on line 107 that
`auth: "public"` "skips the authorizer and lets unauthenticated traffic reach
the handler," and on line 157 that the Photos static handler runs with
`auth: "public"` on a catch-all and that its API routes fetch the app's HMAC
secret from SSM and sign with it. Seventy lines apart, in one document, by one
author paying attention. Line 162 then summarizes the arrangement approvingly.

The review was organized by component, so "which routes are public" and "which
code holds the app credential" were answered in separate passes and never
joined. The failure was compositional, not observational. More careful reading
would not have helped — the reading was already done. What was missing was a
step whose *output shape* forces the composition.

See `postmortem-unauthenticated-cloud-apps-2026-08-23.md` §4 for the full
account.

## The procedure

For each **credential, signing capability, or privileged operation** in the code
under review — an HMAC secret, a CloudFront or S3 signing key, an
`sts:AssumeRole`, a presign call, a token minter, an unbounded delete, anything
that spends money — trace *outward*, away from the code and toward its callers,
until you reach the least-authenticated party that can cause it to run. Write
that party down.

Produce a table. The table is the deliverable; a paragraph saying "the auth
looks fine" is not the same artifact and does not compose.

| Capability | Where it lives | Least-authenticated reachable caller |
| --- | --- | --- |
| Signs data-plane requests with the app's HMAC secret | `photos/app/api/local-data/[...path]/route.ts` | anonymous internet |
| Mints CloudFront signed URLs for `shared/*` | `cloud-data-server/src/api-handler.ts` (`signSharedCloudFrontUrl`) | any app with a valid HMAC signature and a matching grant |
| Assumes a per-app role | `cloud-data-server` broker path | any app with a valid HMAC signature |

The first row is the real answer for 2026-06-05, derivable entirely from what
that review already contained.

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
  accurate for seven weeks and then named the primary cloud data path for three
  months. Check the route table, not the identifier.
- **Name a party, not a mechanism.** "Anonymous internet", "any signed-in user",
  "any installed app", "operator on the local machine" are answers. "Behind the
  proxy", "requires the signature" are not — keep going until you can name who.
- **Record the unsurprising rows too.** The value is the table existing, so a
  later review can diff it. The defect this pass catches is a capability whose
  answer got *weaker* between two revisions while each individual change looked
  locally correct.

## Where the answers live in this system

Three facts about the platform decide most rows, and all three are easy to get
wrong from memory:

- The cloud data plane has **no JWT authorizer**. It authenticates the *app* via
  HMAC, not the end user. End-user identity is each app's own responsibility —
  see `data-roles-and-permissions.md`, "How data access actually flows at
  runtime", and `authoring-an-app.md` §10.
- **CloudFront is not a security boundary.** The API Gateway origin stays
  directly reachable by design. Any row that ends at "the edge blocks it" is
  wrong.
- A manifest handler's `auth: "public"` on a catch-all makes **every** path
  under `/apps/<appId>/` anonymous, including routes the app's bundle mounts
  that the manifest never names. The handler's `publicPaths` declaration states
  the *intent*; it does not narrow the reach.
