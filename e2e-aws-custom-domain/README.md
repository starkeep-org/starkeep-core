# @starkeep/e2e-aws-custom-domain — live custom-domain suite

Custom domains attach an address the operator owns, such as
`photos.example.com`, to the cloud's CloudFront distribution. This suite runs
that feature against real AWS and real DNS. It covers what no unit test or IAM
simulation can:

- ACM issues the certificate through real DNS validation, and CloudFront accepts
  the certificate and the alias.
- IAM's record-name condition admits Route53's own normalization of real
  requests, and refuses nothing the install needs.
- The temp policy's read wildcards admit every call Pulumi's AWS provider makes.
- `PutRolePolicy` accepts the temp policy that names two domains during a change.
- Sessions work on both hosts, the custom domain and the `cloudfront.net` name,
  in a real browser: sign-in, session refresh and sign-out.
- The installer's preflight refuses a record it did not write, reading real
  `ListResourceRecordSets` output.
- The teardown scripts delete what an attach created.

Custom domains are optional, and the suite needs a domain you control, so the
suite lives apart from the platform journey in `e2e-aws`. `pnpm test:aws` never
runs it.

## Requirements

- **A domain you control**, and a subdomain of it for testing, such as
  `e2e.example.com`. The suite writes every record in that subdomain's own zone,
  under names unique to each run, and writes nothing in your domain's zone.
- **The test zone, set up once** in the AWS account the test stack runs in:

  ```bash
  scripts/setup-e2e-dns-zone.sh e2e.example.com
  ```

  The script creates the public Route53 zone and delegates it. When your
  domain's zone sits in the same account, the script shows the one NS record it
  will add there and asks first. When your domain's DNS lives elsewhere, the
  script prints the four name servers to add as an NS record at your provider.
  It then waits for public DNS and prints the line for the repository's `.env`:

  ```bash
  STARKEEP_AWS_CUSTOM_DOMAIN_ZONE=e2e.example.com
  ```

  `scripts/setup-e2e-dns-zone.sh --delete e2e.example.com` removes the zone and
  its delegation again. It refuses while the zone holds test records.

- **The Playwright browser**, as for the journey:
  `pnpm exec playwright install chromium`.

## Running

```bash
STARKEEP_AWS_TESTS=1 pnpm test:aws:custom-domain     # from the repository root
```

Without `STARKEEP_AWS_TESTS=1`, or without `STARKEEP_AWS_CUSTOM_DOMAIN_ZONE`, the
suite reports skipped and makes no AWS call. The suite reads the repository's
`.env`, so the zone can live there.

`STARKEEP_AWS_STACK_PREFIX`, `STARKEEP_AWS_REGION` and `STARKEEP_AWS_TEARDOWN`
work as in `e2e-aws`. The suite shares the journey's run-state directory, so it
reuses a stack that a journey run kept warm with `STARKEEP_AWS_TEARDOWN=none`,
and it creates the bootstrap stack, the cloud data server and the Probe app when
they are missing. A failed run tears nothing down.

`pnpm test` runs only the unit tests of the suite's own safety checks
(`src/zone.unit.test.ts`), which need no AWS.

## What a run does

Each run picks a random six-character id. The two test names are
`<prefix>-<id>.<zone>` and `<prefix>-<id>-b.<zone>`.

1. **Preconditions.** The run refuses to start unless the test prefix differs
   from every live deployment's prefix in `~/.starkeep/config.json` (and in
   `$STARKEEP_DIR`), the zone exists and public DNS delegates to it, the zone
   holds nothing besides its NS and SOA records and earlier runs' records, and
   the installer's zone lookup resolves both test names to the test zone. The
   run then snapshots the parent zone, when it sits in the account, and each
   live deployment's custom domain, records and certificate.
2. **Preflight refusal.** The run writes `<first name> A 192.0.2.1` (TEST-NET-1,
   which routes nowhere), installs with the first name, and expects the install
   to fail naming the record, with no certificate requested. It then deletes the
   record.
3. **Attach.** The install attaches the first name: the certificate issues, one
   A alias points at the distribution and no AAAA record exists, the public base
   URL names the domain, and the signing config lists both hosts.
4. **Sessions on both hosts**, in Chromium: an anonymous page lands on the app's
   sign-in page on the same host; a sign-in finishes on the host it began on; a
   session refresh and a sign-out succeed on each host; a refresh with a foreign
   `Origin` returns 403.
5. **Signed bytes.** A signed URL names the custom host, serves the bytes, and
   CloudFront refuses a tampered or missing signature.
6. **Change** to the second name: it serves, and the first name's alias,
   validation record and certificate are gone.
7. **Removal**: the second name's records and certificate are gone, and the
   public base URL returns to the `cloudfront.net` name.
8. **Teardown with a domain attached**: the run reattaches the first name and
   runs the teardown `STARKEEP_AWS_TEARDOWN` asks for. Afterwards no record
   remains at either test name, and no certificate of this stack for either name
   remains. With `STARKEEP_AWS_TEARDOWN=none` the stack stays up, with no domain.
9. **Postconditions**, whatever happened above: the parent zone and each live
   deployment must match the step 1 snapshot exactly. Any difference fails the
   run and prints it.

Steps 3, 6, 7 and 8 each wait on a CloudFront deployment, and a new name waits
on ACM validation, so a run takes roughly 30 to 60 minutes on a warm stack.

## Safety

Several independent layers keep a run away from live resources:

1. **Zone isolation.** The installer, the Pulumi program and the teardown
   script each pick the longest zone that ends a name, so every per-run record
   lands in the test zone. Step 1 refuses to start when that resolution fails.
2. **A dedicated zone only.** Step 1 refuses a zone that serves records no run
   wrote, so a mistyped variable cannot aim the suite at a live zone. The setup
   script refuses a bare registrable domain.
3. **IAM confines the installer's record writes** to the test names and
   `_*.<test name>`, through the temp policy's record-name condition.
4. **The suite's own writes go through one helper**, `TestZoneWriter`, which
   refuses any zone but the test zone and any name outside this run. It writes
   with `CREATE`, never `UPSERT`, and Route53 deletes only an exactly matching
   record set.
5. **The stack never overwrites an alias.** Its alias record leaves
   `allowOverwrite` unset, and the installer's preflight refuses first.
6. **Certificate deletion is confined to the test prefix** by the temp policy's
   `aws:ResourceTag/starkeep:stackPrefix` condition, and ACM refuses to delete a
   certificate in use.
7. **Separate stack, separate prefix.** Step 1 refuses a live deployment's
   prefix.
8. **Unique names per run**, so a failed run's leftovers never collide with the
   next run, and CloudFront refuses an alias another distribution holds.
9. **Snapshot comparison** in steps 1 and 9 reports any change outside the test
   zone. It detects a failure of the layers above after the fact rather than
   preventing it.

## Cost

The test zone costs $0.50 a month. Certificates cost nothing. External DNS mode,
where the operator adds records at another provider, stays a manual check.
