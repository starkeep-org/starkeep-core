/**
 * Inline Pulumi program for the cloud-data-server built-in app.
 *
 * Provisions the cloud-side data plane:
 *   - Aurora DSQL cluster (the per-user metadata index)
 *   - S3 files bucket + bucket policy (apps/<id>/* prefix isolation)
 *   - Lambda function (the protocol-core broker) using the per-app role
 *     ${stackPrefix}-app-cloud-data-server-role minted by Manager outside Pulumi
 *   - CloudWatch log group for the Lambda
 *   - API Gateway v2 + Cognito JWT authorizer + explicit reserved sub-namespaces
 *
 * Stack outputs match the previous SST shape so per-app Pulumi installs can
 * read apiGatewayId and authorizerId to attach their own routes:
 *   auroraHostname, bucketName, apiGatewayUrl, publicBaseUrl, apiGatewayId,
 *   authorizerId, sessionAuthorizerId, region
 *
 * The Lambda's IAM role is NOT a Pulumi resource — Manager mints it as part
 * of the install pipeline (createAppRole + broker-power policy). Pulumi only
 * references its ARN.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";
import {
  INTENT_TAG_KEY,
  LADDER_TAG_KEY,
  LADDER_TAG_COMPLETE,
} from "@starkeep/protocol-primitives";

// ---------------------------------------------------------------------------
// Cost / DoS guardrails (todo-cloud-dos-cost-amplification-2026-06-30)
//
// The data plane is fully pay-per-use (Lambda + DSQL + S3), so volumetric
// abuse of the internet-reachable gateway turns directly into the customer's
// AWS bill rather than a clean outage. These two limits bound the blast radius
// at zero fixed monthly cost:
//
//   - Gateway throttle caps the *request rate* reaching the Lambda. The default
//     APIGW account ceiling is ~10k rps; we clamp the shared stage far below
//     that. Tune up if a real deployment legitimately needs more.
//   - Reserved concurrency is the hard *dollar ceiling*: even if throttling were
//     mis-tuned, the Lambda can never run more than this many copies at once, so
//     parallel DSQL connections and S3 ops — and thus spend-per-second — are
//     bounded regardless. Legitimate bursts past the cap get 429'd, so size it
//     to real peak load. NOTE: currently disabled — a default AWS account's
//     total Lambda concurrency limit (10) makes any reservation impossible; see
//     the reservedConcurrentExecutions site below.
//
// Single named home so an operator can retune without hunting through the body.
// ---------------------------------------------------------------------------
const GATEWAY_THROTTLE_RATE_LIMIT = 50; // steady-state req/s across the whole shared stage
const GATEWAY_THROTTLE_BURST_LIMIT = 100; // token-bucket burst allowance
// TEMPORARILY DISABLED (see usage site below): unusable on a default AWS account
// whose total Lambda concurrency limit is 10 — any reservation drops unreserved
// below its floor of 10 and 400s the install. Re-enable with the account quota fix.
// const LAMBDA_RESERVED_CONCURRENCY = 20; // max concurrent broker invocations

export interface CloudDataServerProgramContext {
  stackPrefix: string;
  region: string;
  accountId: string;
  /** ARN of the per-app role minted by Manager (used as the Lambda execution role). */
  appRoleArn: string;
  /** Local filesystem path to the prebuilt Lambda zip (admin-installer reads it from disk). */
  distZipPath: string;
  /**
   * Base64-encoded SHA-256 of dist.zip. Wired to aws.lambda.Function.sourceCodeHash
   * so Pulumi detects bundle changes across redeploys. Mirrors the per-app installer.
   */
  bundleHash: string;
  /** Cognito user-pool resources from bootstrap, needed to wire the JWT authorizer. */
  userPoolId: string;
  userPoolClientId: string;
  /**
   * When true, this install provisions *disposable* infrastructure (the cloud
   * e2e suite) and the production data-protection hardening is skipped:
   *   - DSQL deletion protection stays OFF so teardown can drop the cluster.
   *   - The files bucket gets NO versioning (versioned/delete-markered objects
   *     would block bucket deletion on repeated e2e teardown), no explicit
   *     SSE-S3 assertion, and no public-access block.
   *
   * Defaults to false everywhere except the e2e harness, so real user accounts
   * are hardened by default. AWS still applies its own defaults to ephemeral
   * resources (SSE-S3 on new buckets, account-level block-public-access,
   * DSQL encryption + PITR); this flag only governs the *explicit* hardening
   * we assert on top of those defaults.
   */
  ephemeral: boolean;
  /**
   * Days an `archive`-intent original waits, after its ladder is confirmed
   * complete, before transitioning to Deep Archive.
   *
   * A primary setting, not a safety margin. Under Intelligent-Tiering the whole
   * range from a week to a year spans well under a dollar a month at the
   * operator's scale and flattens after 90 days, so the number is chosen for
   * how long you want to be able to change your mind — about a derivation bug,
   * or about an original you are still editing — rather than for cost.
   */
  archiveHoldDays?: number;
}

/**
 * Below this, archiving costs more than not archiving.
 *
 * Deep Archive bills a 40 KB per-object overhead and a 180-day minimum
 * duration, so a small object is both more expensive and slower to read once
 * frozen. Strictly worse on both axes, which is why this is a floor rather than
 * a tuning knob.
 */
const ARCHIVE_MIN_OBJECT_BYTES = 1024 * 1024;

const DEFAULT_ARCHIVE_HOLD_DAYS = 7;

/**
 * Where inventory reports land.
 *
 * A reserved prefix inside the files bucket, deliberately outside `shared/` so
 * the reports are not themselves inventoried, are not served by CloudFront, and
 * cannot be mistaken for record blobs by anything walking the shared namespace.
 */
const INVENTORY_PREFIX = "_starkeep/inventory/";

export function buildCloudDataServerProgram(
  ctx: CloudDataServerProgramContext,
): () => Promise<Record<string, unknown>> {
  return async () => {
    // CloudFront URL-signing config (Part B) is stored as a single SSM
    // SecureString JSON blob { keyPairId, domain, privateKey }, read by the
    // Lambda at runtime. The Lambda's env carries only this (static, no
    // resource dependency) parameter NAME, so the Lambda needs no ordering
    // relationship with the CloudFront resources. Stored under the existing
    // `/${stackPrefix}/app-creds/` prefix — the only SSM path the CDS Lambda
    // role can read.
    //
    // The parameter is NOT created here: the CDS Pulumi stack runs as the CDS
    // role, which is deliberately read-only on SSM (it verifies HMAC secrets;
    // it never writes app-creds — Manager does). Instead this program exports
    // the signing material (keyPairId, domain, privateKey) as stack outputs and
    // the installer writes the SecureString post-Pulumi under Manager creds —
    // mirroring how the Pulumi passphrase and per-app HMAC secrets are minted.
    // See putCloudFrontSigningParameter in app-creds.ts. The name is shared via
    // this exported constant so both sides agree; keep them in lockstep.
    const cloudfrontSigningParamName = `/${ctx.stackPrefix}/app-creds/_cloudfront-signing`;

    // -----------------------------------------------------------------------
    // DSQL cluster
    // -----------------------------------------------------------------------
    const cluster = new aws.dsql.Cluster(`${ctx.stackPrefix}-db`, {
      // Protect real user clusters from accidental destroy; ephemeral e2e
      // clusters stay unprotected so the suite can tear them down each run.
      deletionProtectionEnabled: !ctx.ephemeral,
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    }, {
      /**
       * The same guard as the files bucket, and it is *not* redundant with
       * `deletionProtectionEnabled` above.
       *
       * That flag is enforced by AWS at the moment of deletion. This one is
       * enforced by Pulumi at the moment of *planning*, so a plan that would
       * replace this cluster fails before it touches anything — rather than
       * getting partway, as the bucket's replacement did, and leaving the
       * stack in a state where some resources are gone and some are not.
       *
       * Two layers because they fail at different times, and the earlier
       * failure is the more useful one.
       */
      protect: !ctx.ephemeral,
    });

    const auroraHostname = pulumi.interpolate`${cluster.identifier}.dsql.${ctx.region}.on.aws`;

    // -----------------------------------------------------------------------
    // Files bucket + bucket policy
    // -----------------------------------------------------------------------
    const bucket = new aws.s3.BucketV2(`${ctx.stackPrefix}-files`, {
      bucket: `${ctx.stackPrefix}-files-${ctx.accountId}-${ctx.region}`,
      // Ephemeral e2e buckets self-empty on `pulumi destroy` so repeated
      // teardown isn't wedged by leftover objects; real user buckets keep the
      // default guard (destroy fails on a non-empty bucket) so a stray destroy
      // can't silently wipe customer files. forceDestroy is only ever true when
      // versioning is off (both ride ctx.ephemeral), so the existing
      // s3:DeleteObject grant suffices — no s3:DeleteObjectVersion is needed.
      forceDestroy: ctx.ephemeral,
      // Object Lock — the flag ONLY, never a bucket-level default retention.
      //
      // This can only be set at bucket creation. A bucket that misses it can
      // never get Object Lock without an AWS Support request, so it has to
      // land before anyone has a bucket worth protecting — which is why this
      // is item 0 of the media plan while the retention that actually uses it
      // is item 36, deliberately last.
      //
      // Setting the flag makes nothing undeletable. A bucket with Object Lock
      // enabled and no retention configured behaves exactly like an ordinary
      // bucket; objects become undeletable only when a retain-until date is
      // written on them individually. There must NEVER be a bucket-level
      // default retention here — compliance retention can be extended but not
      // reduced, so anything written under a bucket default would be
      // permanently undeletable, which would make rendition supersession
      // impossible. Retention is set per object, on `archive` intent only.
      //
      // Rides !ctx.ephemeral exactly like versioning does (Object Lock
      // requires versioning, and AWS turns it on implicitly at creation), or
      // an e2e bucket could never be torn down.
      objectLockEnabled: !ctx.ephemeral,
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    }, {
      /**
       * Refuse to delete this bucket, including as half of a replacement.
       *
       * ## The incident this exists to prevent
       *
       * `objectLockEnabled` is **ForceNew** in the AWS provider, because AWS can
       * only set Object Lock at bucket creation. So on a stack whose bucket
       * predates that field, the provider does not report an error — it reports
       * "this requires replacement", and Pulumi plans a delete and a create.
       * S3 bucket names are globally unique, so the delete has to go *first*:
       * the policy, versioning, public-access block, CORS and encryption
       * configuration are all torn down, then the bucket itself.
       *
       * That ran against a real deployment on 2026-08-02. Every user file
       * survived for exactly one reason — `DeleteBucket` returned
       * `BucketNotEmpty`. Nothing in the design stopped it; the data was saved
       * by the accident of existing.
       *
       * `protect` converts that plan from an execution into an error, which is
       * the behaviour anyone would have assumed was already there.
       *
       * ## Why this does not block teardown
       *
       * `scripts/teardown-cloud-data-server.sh` deletes through the AWS CLI and
       * empties the bucket first; it never runs `pulumi destroy`. A deliberate
       * teardown is unaffected. What is blocked is an *incidental* delete —
       * one nobody asked for, arriving as a side effect of deploying a Lambda.
       *
       * Off for ephemeral e2e stacks, which are created and destroyed by the
       * suite and hold nothing.
       */
      protect: !ctx.ephemeral,
    });

    // Data-protection hardening — asserted explicitly for real user accounts;
    // skipped for ephemeral e2e buckets (see ctx.ephemeral). The IAM
    // foundational permissions boundary already grants the three Put* actions
    // these resources require (PutBucketVersioning / PutEncryptionConfiguration
    // / PutBucketPublicAccessBlock), so this is purely additive.
    if (!ctx.ephemeral) {
      // Versioning: keep prior object versions so an overwrite or delete of a
      // user file is recoverable. Deliberately off for e2e — versioned objects
      // and delete markers block bucket deletion on repeated teardown.
      new aws.s3.BucketVersioningV2(`${ctx.stackPrefix}-files-versioning`, {
        bucket: bucket.id,
        versioningConfiguration: { status: "Enabled" },
      });

      // Encryption at rest: assert SSE-S3 (AES256) rather than relying on the
      // implicit AWS bucket default, so the posture is visible in IaC and
      // survives any future change to AWS defaults. A customer-managed KMS key
      // is intentionally NOT used here: the permissions boundary only grants
      // kms:Decrypt via SSM, so a CMK would require widening IAM and granting
      // the broker role KMS access — a separate, larger change.
      new aws.s3.BucketServerSideEncryptionConfigurationV2(
        `${ctx.stackPrefix}-files-sse`,
        {
          bucket: bucket.id,
          rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
        },
      );

      // Block all public access. Presigned-URL access (SigV4) and the Deny-only
      // cross-app bucket policy below are unaffected; this only forecloses
      // public ACLs/policies ever being added.
      new aws.s3.BucketPublicAccessBlock(`${ctx.stackPrefix}-files-pab`, {
        bucket: bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      });
    }

    // -----------------------------------------------------------------------
    // Archive lifecycle — ONE rule, tag-filtered
    // -----------------------------------------------------------------------
    //
    // The conjunction is the whole safety argument. An object transitions to
    // Deep Archive only when it carries BOTH tags: `starkeep:intent=archive`
    // (its writer declared it can tolerate a 48-hour read) AND
    // `starkeep:ladder=complete` (something cheaper is confirmed readable in
    // its place). Either alone is not enough — an original whose derived ladder
    // is incomplete is still the only readable form of that record, and
    // freezing it would put the sole copy behind a thaw.
    //
    // Renditions need no rule at all. They are never tagged, so they are
    // structurally ineligible: an untagged object cannot match this filter,
    // which is a stronger guarantee than a rule that reads a value correctly.
    //
    // The ~1 MB floor is not a tuning knob. Deep Archive bills a 40 KB
    // per-object overhead plus a minimum 180-day duration, so below roughly a
    // megabyte an archived object costs *more* than leaving it in
    // Intelligent-Tiering — and it is slower to read. Archiving it would be
    // strictly worse on both axes.
    //
    // `archiveHoldDays` is expressed here as the transition's `days`. It is a
    // primary user-facing setting rather than a safety margin: it buys a week
    // to catch a derivation bug before the input is behind a 48-hour thaw, and
    // it is what someone who edits recent originals will ask to change.
    if (!ctx.ephemeral) {
      new aws.s3.BucketLifecycleConfigurationV2(`${ctx.stackPrefix}-files-lifecycle`, {
        bucket: bucket.id,
        rules: [
          {
            id: "starkeep-archive-complete-originals",
            status: "Enabled",
            filter: {
              and: {
                tags: {
                  [INTENT_TAG_KEY]: "archive",
                  [LADDER_TAG_KEY]: LADDER_TAG_COMPLETE,
                },
                objectSizeGreaterThan: ARCHIVE_MIN_OBJECT_BYTES,
              },
            },
            transitions: [
              {
                days: ctx.archiveHoldDays ?? DEFAULT_ARCHIVE_HOLD_DAYS,
                storageClass: "DEEP_ARCHIVE",
              },
            ],
          },
        ],
      });
    }

    // NOTE: the files bucket policy is defined AFTER the CloudFront distribution
    // below, because it must also admit the distribution (via OAC) to read
    // shared/* objects — and S3 permits only one policy document per bucket, so
    // both the cross-app Deny and the CloudFront Allow live in that single
    // resource. See `${ctx.stackPrefix}-files-policy` further down.

    // Browser uploads/downloads go directly to S3 via presigned URLs from the
    // photos app served at the API Gateway origin, so the bucket itself must
    // answer CORS preflights. Mirrors the gateway's `allowOrigins: ["*"]`.
    new aws.s3.BucketCorsConfigurationV2(`${ctx.stackPrefix}-files-cors`, {
      bucket: bucket.id,
      corsRules: [{
        allowedMethods: ["GET", "PUT", "HEAD"],
        allowedOrigins: ["*"],
        allowedHeaders: ["*"],
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3000,
      }],
    });

    // -----------------------------------------------------------------------
    // Lambda log group
    // -----------------------------------------------------------------------
    const lambdaName = `${ctx.stackPrefix}-app-cloud-data-server-api`;

    const logGroup = new aws.cloudwatch.LogGroup("api-log-group", {
      name: `/aws/lambda/${lambdaName}`,
      retentionInDays: 14,
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    });

    // -----------------------------------------------------------------------
    // Lambda function
    // -----------------------------------------------------------------------
    const fn = new aws.lambda.Function(
      "api",
      {
        name: lambdaName,
        role: ctx.appRoleArn,
        runtime: aws.lambda.Runtime.NodeJS22dX,
        handler: "api-handler.handler",
        code: new pulumi.asset.FileArchive(ctx.distZipPath),
        sourceCodeHash: ctx.bundleHash,
        memorySize: 256,
        timeout: 30,
        // Hard ceiling on concurrent broker copies → bounds parallel DSQL/S3
        // work and thus worst-case spend-per-second. See guardrail note above.
        //
        // TEMPORARILY DISABLED: a fresh AWS account defaults to a total Lambda
        // concurrency limit of 10, and AWS refuses any reservation that would
        // drop unreserved concurrency below its floor of 10 — so on a default
        // account you can't reserve *any* concurrency (need account limit ≥
        // reserved + 10). Setting this 400s the install (InvalidParameterValue).
        // Re-enable once we require/raise the account concurrency quota. The
        // gateway throttle below still bounds the request rate in the meantime.
        // reservedConcurrentExecutions: LAMBDA_RESERVED_CONCURRENCY,
        environment: {
          variables: {
            AURORA_ENDPOINT: auroraHostname,
            S3_BUCKET: bucket.bucket,
            STACK_PREFIX: ctx.stackPrefix,
            STARKEEP_APP_ID: "cloud-data-server",
            STARKEEP_STACK_PREFIX: ctx.stackPrefix,
            // The broker requires an end-user credential on every data-plane
            // call and verifies the ID token against this pool's JWKS. With
            // these unset it cannot verify anyone, and it refuses rather than
            // admitting — so a missing value here is an outage, not a hole.
            STARKEEP_USER_POOL_ID: ctx.userPoolId,
            STARKEEP_USER_POOL_CLIENT_ID: ctx.userPoolClientId,
            // Part B: SSM SecureString holding { keyPairId, domain, privateKey }
            // for signing shared-file CloudFront URLs. Name only — the Lambda
            // reads and caches the value once per warm container.
            CLOUDFRONT_SIGNING_PARAM: cloudfrontSigningParamName,
            // Forwarded only when the installer process sets it (the Tier-3
            // e2e suite does, to shorten the broker's HMAC secret cache).
            // Absent in real installs → broker keeps its 5-min default.
            ...(process.env.HMAC_CACHE_TTL_MS !== undefined
              ? { HMAC_CACHE_TTL_MS: process.env.HMAC_CACHE_TTL_MS }
              : {}),
          },
        },
        tags: {
          "starkeep:managed": "true",
          "starkeep:appId": "cloud-data-server",
        },
      },
      { dependsOn: [logGroup] },
    );

    // -----------------------------------------------------------------------
    // Availability maintenance — S3 event notifications
    // -----------------------------------------------------------------------
    //
    // This is what makes `availability` mean anything. Without it every record
    // reports whatever it was written as, forever: an archived original would
    // still claim to be instantly readable, and the 409 that protects callers
    // from a silent twelve-hour stall would never fire.
    //
    // Only the event kinds that change *readability* are subscribed. Object
    // creation is deliberately not among them — a newly written object is
    // instant, which is already the default for a key with no stored row, so
    // subscribing would write a row per upload to record something nothing
    // needed told.
    //
    // Delivered straight to the same Lambda rather than through SNS or SQS: the
    // handler is idempotent (observations carry their own timestamp and older
    // ones are discarded), so at-least-once delivery needs no deduplication,
    // and a queue would add a component whose only job is holding events for a
    // consumer that is already warm.
    //
    // Deliberately NOT gated on ctx.ephemeral. Nothing here obstructs teardown
    // — a notification config and an inventory config are deleted with the
    // bucket — and gating them meant the only suite that runs a real install
    // never exercised the IAM grants they need. That gap is exactly how a
    // missing s3:PutInventoryConfiguration reached a real account.
    const s3InvokePermission = new aws.lambda.Permission(
      `${ctx.stackPrefix}-files-notify-invoke`,
      {
        action: "lambda:InvokeFunction",
        function: fn.name,
        principal: "s3.amazonaws.com",
        sourceArn: bucket.arn,
      },
    );

    new aws.s3.BucketNotification(
      `${ctx.stackPrefix}-files-notify`,
      {
        bucket: bucket.id,
        lambdaFunctions: [
          {
            lambdaFunctionArn: fn.arn,
            events: [
              // A lifecycle transition into Deep Archive is the moment an
              // object stops being readable.
              "s3:LifecycleTransition",
              // A thaw finished; a temporary readable copy now exists.
              "s3:ObjectRestore:Completed",
              // The thawed copy lapsed and the object is archived again.
              // Without this an object reads as available forever after one
              // restore — the failure mode that looks fine right up until
              // someone opens it months later.
              "s3:ObjectRestore:Delete",
            ],
            filterPrefix: "shared/",
          },
          {
            // The daily inventory report landing. Keyed on the checksum file
            // because S3 writes the data files first and the checksum last,
            // so anything else would trigger ingestion of a partial report.
            //
            // A separate entry rather than widening the prefix above: these
            // are different events about different things, and one filter
            // covering both would deliver every shared-object creation too.
            lambdaFunctionArn: fn.arn,
            events: ["s3:ObjectCreated:*"],
            filterPrefix: INVENTORY_PREFIX,
            filterSuffix: "manifest.checksum",
          },
        ],
      },
      // S3 validates that it may invoke the function while *creating* the
      // notification, so the permission must exist first or the apply fails
      // with an unhelpful "unable to validate the following destination".
      { dependsOn: [s3InvokePermission] },
    );

    // NOTE: the daily S3 Inventory that backstops availability is created
    // AFTER the files bucket policy further down, because S3 will only deliver
    // a report into a bucket whose policy admits the inventory service — see
    // `${ctx.stackPrefix}-files-inventory` below.

    // -----------------------------------------------------------------------
    // API Gateway v2 + Cognito JWT authorizer + explicit reserved sub-namespaces
    //
    // The cloud-data-server lambda is reached via:
    //   - OPTIONS /{proxy+}             (CORS preflight, no auth)
    //   - GET     /health               (public liveness check)
    //   - GET     /apps/{appId}/health  (per-app authenticated health)
    //   - ANY     /apps/{appId}/data/{proxy+}
    //   - ANY     /apps/{appId}/files/{proxy+}
    //   - ANY     /apps/{appId}/sync/{proxy+}
    //
    // These routes claim the reserved data-plane sub-namespaces on the shared
    // gateway. APIGW v2 picks the most-specific match, so an app's own
    // `GET /apps/{appId}/{proxy+}` (e.g. photos static site) still serves UI
    // paths but loses to these routes for `data`, `files`, `sync`, `health`.
    // No `$default` — stray traffic gets an APIGW 404 without invoking lambda.
    // -----------------------------------------------------------------------
    const api = new aws.apigatewayv2.Api(`${ctx.stackPrefix}-gateway`, {
      name: `${ctx.stackPrefix}-gateway`,
      protocolType: "HTTP",
      corsConfiguration: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: [
          "Content-Type",
          "Authorization",
          "X-Starkeep-App-Id",
          "X-Starkeep-App-Sig",
          "X-Starkeep-App-Ts",
        ],
      },
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    });

    const stage = new aws.apigatewayv2.Stage(`${ctx.stackPrefix}-gateway-stage`, {
      apiId: api.id,
      name: "$default",
      autoDeploy: true,
      // Stage-wide request throttle. Applies to every route (the public
      // /health and OPTIONS preflight as well as the HMAC-gated data plane),
      // so it bounds Lambda invocations regardless of which surface is hit.
      // See guardrail note at the top of the file.
      defaultRouteSettings: {
        throttlingRateLimit: GATEWAY_THROTTLE_RATE_LIMIT,
        throttlingBurstLimit: GATEWAY_THROTTLE_BURST_LIMIT,
      },
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    });

    const authorizer = new aws.apigatewayv2.Authorizer("cognito-jwt", {
      apiId: api.id,
      authorizerType: "JWT",
      identitySources: ["$request.header.Authorization"],
      jwtConfiguration: {
        audiences: [ctx.userPoolClientId],
        issuer: `https://cognito-idp.${ctx.region}.amazonaws.com/${ctx.userPoolId}`,
      },
      name: "cognitoJwt",
    });

    // -----------------------------------------------------------------------
    // Session authorizer — the gate in front of every browser app
    // -----------------------------------------------------------------------
    //
    // The JWT authorizer above reads a bare token from `Authorization`, which a
    // browser navigating to a URL cannot send. That is why the first pass at
    // this design concluded the gateway could not gate a browser app and pushed
    // enforcement into the app bundle — an app gating itself, which is the
    // assumption that produced the 2026-08 exposure. A REQUEST authorizer reads
    // any header, `Cookie` included, so the gateway can do the job after all,
    // and an app's own middleware stops being the thing that matters.
    //
    // Same artifact as the broker, different entry point: it deploys and
    // versions with the code it guards rather than being a second thing to
    // remember to rebuild.
    const sessionAuthLambdaName = `${ctx.stackPrefix}-session-authorizer`;

    const sessionAuthLogGroup = new aws.cloudwatch.LogGroup("session-auth-log-group", {
      name: `/aws/lambda/${sessionAuthLambdaName}`,
      retentionInDays: 14,
      tags: { "starkeep:managed": "true", "starkeep:appId": "cloud-data-server" },
    });

    const sessionAuthFn = new aws.lambda.Function(
      "session-authorizer",
      {
        name: sessionAuthLambdaName,
        role: ctx.appRoleArn,
        runtime: aws.lambda.Runtime.NodeJS22dX,
        handler: "session-authorizer.handler",
        code: new pulumi.asset.FileArchive(ctx.distZipPath),
        sourceCodeHash: ctx.bundleHash,
        memorySize: 128,
        // It verifies a signature against a cached JWKS. The only slow path is
        // the first fetch in a cold container.
        timeout: 5,
        environment: {
          variables: {
            STARKEEP_USER_POOL_ID: ctx.userPoolId,
            STARKEEP_USER_POOL_CLIENT_ID: ctx.userPoolClientId,
          },
        },
        tags: { "starkeep:managed": "true", "starkeep:appId": "cloud-data-server" },
      },
      { dependsOn: [sessionAuthLogGroup] },
    );

    new aws.lambda.Permission("session-authorizer-invoke", {
      action: "lambda:InvokeFunction",
      function: sessionAuthFn.name,
      principal: "apigateway.amazonaws.com",
      sourceArn: pulumi.interpolate`${api.executionArn}/authorizers/*`,
    });

    const sessionAuthorizer = new aws.apigatewayv2.Authorizer("session-cookie", {
      apiId: api.id,
      authorizerType: "REQUEST",
      authorizerPayloadFormatVersion: "2.0",
      enableSimpleResponses: true,
      identitySources: ["$request.header.Cookie"],
      // Caches the decision per distinct Cookie header, so a signed-in session
      // costs one authorizer invocation per window rather than one per request
      // — which matters against an account concurrency limit of ten.
      authorizerResultTtlInSeconds: 300,
      authorizerUri: sessionAuthFn.invokeArn,
      name: "sessionCookie",
    });

    // Lambda integration
    const integration = new aws.apigatewayv2.Integration("api-integration", {
      apiId: api.id,
      integrationType: "AWS_PROXY",
      integrationUri: fn.invokeArn,
      payloadFormatVersion: "2.0",
    });

    // Permit API Gateway to invoke the Lambda
    new aws.lambda.Permission("api-invoke", {
      action: "lambda:InvokeFunction",
      function: fn.name,
      principal: "apigateway.amazonaws.com",
      sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
    });

    // OPTIONS catch-all (no auth, for CORS preflight)
    new aws.apigatewayv2.Route("options-proxy", {
      apiId: api.id,
      routeKey: "OPTIONS /{proxy+}",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    // Public liveness check (no auth)
    new aws.apigatewayv2.Route("route-root-health", {
      apiId: api.id,
      routeKey: "GET /health",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    // Per-app health endpoint. App identity is established by the handler's
    // HMAC verifier (X-Starkeep-App-Id + X-Starkeep-App-Sig against the SSM
    // SecureString at /${stackPrefix}/app-creds/${appId}), not by the
    // gateway's JWT authorizer. The data plane identifies the *app*, not the
    // end user; end-user identity is the app's business.
    new aws.apigatewayv2.Route("route-app-health", {
      apiId: api.id,
      routeKey: "GET /apps/{appId}/health",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    // Reserved data-plane sub-namespaces. {appId} is a path variable purely
    // for APIGW route specificity — the handler parses appId from rawPath
    // itself and does not read event.pathParameters. All four routes rely on
    // the handler's HMAC verifier for identity; no gateway authorizer.
    new aws.apigatewayv2.Route("route-data-proxy", {
      apiId: api.id,
      routeKey: "ANY /apps/{appId}/data/{proxy+}",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    new aws.apigatewayv2.Route("route-files-proxy", {
      apiId: api.id,
      routeKey: "ANY /apps/{appId}/files/{proxy+}",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    new aws.apigatewayv2.Route("route-sync-proxy", {
      apiId: api.id,
      routeKey: "ANY /apps/{appId}/sync/{proxy+}",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    // Step 2: cloud-side /app-data/* surface (mirrors local-data-server's
    // /app-data/db/<table> and /app-data/files/<key> routes). Handler logic
    // lives in api-handler.ts; this route is what makes it reachable through
    // the gateway. Identity gated by the HMAC verifier, same as the others.
    new aws.apigatewayv2.Route("route-app-data-proxy", {
      apiId: api.id,
      routeKey: "ANY /apps/{appId}/app-data/{proxy+}",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    // -----------------------------------------------------------------------
    // CloudFront distribution (platform-owned) — Part A: app static assets
    //
    // Puts an edge cache in front of the shared API Gateway so each cloud app's
    // Next.js JS/CSS/HTML (served under /apps/{appId}/*) is cached at the edge
    // instead of costing a Lambda invocation per request. Lives in this stack
    // so `pulumi destroy` tears it down (no teardown-bootstrap.sh change).
    //
    // CloudFront is an OPTIMIZATION layer, not a security boundary: the gateway
    // stays directly reachable, and JWT/HMAC auth is unchanged on the origin.
    // See data-roles-and-permissions.md.
    // -----------------------------------------------------------------------

    // Managed policies (looked up by name so we don't hardcode AWS's IDs).
    const cachingOptimizedId = aws.cloudfront
      .getCachePolicyOutput({ name: "Managed-CachingOptimized" })
      .apply((p) => p.id!);
    const cachingDisabledId = aws.cloudfront
      .getCachePolicyOutput({ name: "Managed-CachingDisabled" })
      .apply((p) => p.id!);
    // Forwards all viewer headers EXCEPT Host. The two gotchas this resolves:
    //   (a) with caching disabled, Authorization + custom (HMAC signature)
    //       headers are only forwarded if the origin request policy includes
    //       them — this policy forwards all viewer headers;
    //   (b) forwarding the viewer Host header breaks API Gateway HTTP APIs
    //       (the gateway requires its own execute-api hostname) — hence the
    //       ...ExceptHostHeader variant. HMAC signs over the path (preserved),
    //       so signatures remain valid.
    const allViewerExceptHostId = aws.cloudfront
      .getOriginRequestPolicyOutput({ name: "Managed-AllViewerExceptHostHeader" })
      .apply((p) => p.id!);

    // API Gateway execute-api origin domain (apiEndpoint minus the scheme).
    const gatewayOriginDomain = api.apiEndpoint.apply((ep) =>
      ep.replace(/^https?:\/\//, ""),
    );
    const gatewayOriginId = "api-gateway";

    // -----------------------------------------------------------------------
    // Part B — shared-data file bytes via CloudFront signed URLs
    //
    // A second origin (the files bucket, locked with OAC) plus a `shared/*`
    // behavior that requires CloudFront-signed requests from a key group. The
    // cloud-data-server Lambda signs URLs with the private key (read from SSM);
    // the read path stops minting S3 presigned URLs for shared bytes.
    //
    // Trust note (see data-roles-and-permissions.md + the plan): this removes
    // the per-app IAM ceiling from the shared *read* path. Blast radius is
    // capped structurally at `shared/*` — the distribution has no behavior for
    // apps/* or any other prefix, and OAC opens the bucket only to this
    // distribution. Writes and app-data files are untouched.
    // -----------------------------------------------------------------------

    // RSA key pair for CloudFront URL signing. Generated via the TLS provider so
    // the key material is stable in Pulumi state across updates (regenerating on
    // every `pulumi up` would silently invalidate every already-issued URL).
    const signingKey = new tls.PrivateKey(`${ctx.stackPrefix}-cf-signing-key`, {
      algorithm: "RSA",
      rsaBits: 2048,
    });

    const cfPublicKey = new aws.cloudfront.PublicKey(`${ctx.stackPrefix}-cf-pubkey`, {
      comment: `${ctx.stackPrefix} shared-file signing key`,
      encodedKey: signingKey.publicKeyPem,
    });

    // Key group created able to hold two keys so a future rotation needs no
    // redesign (rotation itself is out of scope — fresh-start philosophy).
    const keyGroup = new aws.cloudfront.KeyGroup(`${ctx.stackPrefix}-cf-keygroup`, {
      comment: `${ctx.stackPrefix} shared-file signers`,
      items: [cfPublicKey.id],
    });

    // (The private key + keyPairId + distribution domain are exported as stack
    // outputs below and written to one SSM SecureString by the installer, under
    // Manager creds — the CDS role that runs this program is read-only on SSM.)

    // Origin Access Control — CloudFront signs its S3 origin requests (SigV4)
    // so the bucket can stay fully private (block-public-access on) and admit
    // only this distribution via the bucket policy below.
    const filesOac = new aws.cloudfront.OriginAccessControl(`${ctx.stackPrefix}-files-oac`, {
      name: `${ctx.stackPrefix}-files-oac`,
      originAccessControlOriginType: "s3",
      signingBehavior: "always",
      signingProtocol: "sigv4",
    });

    // Custom cache policy for shared bytes: cache by PATH only. The signed-URL
    // query params (Expires/Signature/Key-Pair-Id) are validated by CloudFront
    // and then EXCLUDED from the cache key — otherwise every freshly-signed URL
    // is a distinct key and the edge cache never hits. Objects are
    // content-addressed and immutable, so long TTLs are safe.
    const sharedFilesCachePolicy = new aws.cloudfront.CachePolicy(
      `${ctx.stackPrefix}-shared-files-cache`,
      {
        name: `${ctx.stackPrefix}-shared-files-cache`,
        comment: "Path-keyed caching for content-addressed shared file bytes",
        minTtl: 0,
        defaultTtl: 86400, // 1 day
        maxTtl: 31536000, // 1 year — immutable content-addressed objects
        parametersInCacheKeyAndForwardedToOrigin: {
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
          queryStringsConfig: { queryStringBehavior: "none" },
          headersConfig: { headerBehavior: "none" },
          cookiesConfig: { cookieBehavior: "none" },
        },
      },
    );

    const filesOriginId = "shared-files-s3";

    const distribution = new aws.cloudfront.Distribution(
      `${ctx.stackPrefix}-cdn`,
      {
        enabled: true,
        // Default *.cloudfront.net domain — no custom domain / ACM cert.
        comment: `${ctx.stackPrefix} platform CDN`,
        origins: [
          {
            originId: gatewayOriginId,
            domainName: gatewayOriginDomain,
            customOriginConfig: {
              httpPort: 80,
              httpsPort: 443,
              originProtocolPolicy: "https-only",
              originSslProtocols: ["TLSv1.2"],
            },
          },
          {
            // Part B: the shared-data files bucket, locked with OAC.
            originId: filesOriginId,
            domainName: bucket.bucketRegionalDomainName,
            originAccessControlId: filesOac.id,
            // s3OriginConfig with an empty OAI is required by the API when
            // using OAC on an S3 origin (OAC supersedes the legacy OAI).
            s3OriginConfig: { originAccessIdentity: "" },
          },
        ],
        orderedCacheBehaviors: [
          {
            // Next.js content-hashed assets — immutable, safe for long TTLs.
            // Public (no auth headers), so CachingOptimized needs no origin
            // request policy.
            pathPattern: "/apps/*/_next/static/*",
            targetOriginId: gatewayOriginId,
            viewerProtocolPolicy: "redirect-to-https",
            allowedMethods: ["GET", "HEAD"],
            cachedMethods: ["GET", "HEAD"],
            cachePolicyId: cachingOptimizedId,
            compress: true,
          },
          {
            // Part B: content-addressed shared file bytes. Served from S3,
            // require CloudFront-signed requests from the key group, path-keyed
            // caching. `shared/*` matches the confirmed key layout
            // shared/<category>/<shard>/<hash> and never collides with the
            // gateway routes (which live under /apps/*).
            pathPattern: "shared/*",
            targetOriginId: filesOriginId,
            viewerProtocolPolicy: "redirect-to-https",
            allowedMethods: ["GET", "HEAD"],
            cachedMethods: ["GET", "HEAD"],
            cachePolicyId: sharedFilesCachePolicy.id,
            trustedKeyGroups: [keyGroup.id],
            compress: true,
          },
        ],
        defaultCacheBehavior: {
          // Everything else: SPA HTML entry points + all API routes. No caching;
          // forward all viewer headers except Host so JWT/HMAC auth passes
          // through and the gateway sees its own hostname.
          targetOriginId: gatewayOriginId,
          viewerProtocolPolicy: "redirect-to-https",
          allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          cachedMethods: ["GET", "HEAD"],
          cachePolicyId: cachingDisabledId,
          originRequestPolicyId: allViewerExceptHostId,
          compress: true,
        },
        restrictions: {
          geoRestriction: { restrictionType: "none" },
        },
        viewerCertificate: {
          cloudfrontDefaultCertificate: true,
        },
        tags: {
          "starkeep:managed": "true",
          "starkeep:appId": "cloud-data-server",
        },
      },
    );

    const publicBaseUrl = pulumi.interpolate`https://${distribution.domainName}`;

    // CloudFront signing config → written to one SSM SecureString by the
    // installer (under Manager creds) AFTER this stack comes up, not here: the
    // CDS role that runs this program is read-only on SSM by design. The three
    // pieces the Lambda needs are exported as stack outputs below —
    // cloudfrontKeyPairId, cloudfrontSigningDomain, and the (secret)
    // cloudfrontSigningPrivateKey. The Lambda still reads the finished
    // SecureString at `cloudfrontSigningParamName`; the leading underscore in
    // that name keeps it out of the real-appId keyspace so it can never collide
    // with a per-app HMAC secret at `app-creds/<appId>`. Only the CDS Lambda
    // role has app-creds read, so app code can never obtain the signing key.

    // Files bucket policy — the single policy document for the files bucket,
    // combining the redundant cross-app Deny (resource-side gate mirroring the
    // per-app IAM prefix isolation) with the CloudFront OAC Allow that admits
    // the distribution to read shared/* objects. S3 permits only one policy per
    // bucket, so both statements live here. Created after the distribution
    // because the Allow's SourceArn condition references the distribution ARN.
    const filesBucketPolicy = new aws.s3.BucketPolicy(`${ctx.stackPrefix}-files-policy`, {
      bucket: bucket.id,
      policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            // Deny object-level access under apps/* whose key does not live
            // under apps/<principal's starkeep:appId>/*. The IAM permissions
            // boundary already enforces this on the principal side; the
            // bucket policy is a redundant second gate on the resource side.
            //
            // The ArnNotLike condition on aws:ResourceArn expands the
            // ${aws:PrincipalTag/starkeep:appId} policy variable at
            // evaluation time and compares against the requested resource
            // ARN, so the same statement covers GetObject, PutObject,
            // DeleteObject, etc.
            //
            // cloud-data-server, when brokering on behalf of an app, uses
            // the assumed app role's credentials (which carry the matching
            // tag), so brokering naturally satisfies the condition.
            // Untagged principals get an empty expansion and are denied —
            // which is intentional for the apps/* keyspace. CloudFront's OAC
            // principal only ever reads shared/* (below), never apps/*, so
            // this Deny does not interfere with it.
            Sid: "DenyCrossAppPrefixAccess",
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: pulumi.interpolate`${bucket.arn}/apps/*`,
            Condition: {
              ArnNotLike: {
                "aws:ResourceArn": pulumi.interpolate`${bucket.arn}/apps/\${aws:PrincipalTag/starkeep:appId}/*`,
              },
            },
          },
          {
            // Part B: admit this distribution (and only this one, via the
            // SourceArn condition) to read shared/* object bytes through OAC.
            // Scoped to shared/* so the distribution can never read apps/*
            // (private app data) even if a behavior were mis-added.
            Sid: "AllowCloudFrontSharedRead",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:GetObject",
            Resource: pulumi.interpolate`${bucket.arn}/shared/*`,
            Condition: {
              StringEquals: {
                "AWS:SourceArn": distribution.arn,
              },
            },
          },
          {
            // Part C: admit the S3 inventory service to write this bucket's own
            // daily report back into it, under the reserved prefix only.
            //
            // Without this statement the inventory *configuration* still
            // creates and reports healthy, and no report is ever delivered —
            // the failure mode this whole backstop exists to avoid, arriving
            // one level up. Nothing surfaces it: S3 does not retry into a
            // console error, so availability would simply have no backstop
            // while appearing to have one.
            //
            // The conditions are what keep this from being "any bucket's
            // inventory may write here": SourceArn pins it to reports about
            // this bucket, SourceAccount to this account.
            Sid: "AllowInventoryDelivery",
            Effect: "Allow",
            Principal: { Service: "s3.amazonaws.com" },
            Action: "s3:PutObject",
            Resource: pulumi.interpolate`${bucket.arn}/${INVENTORY_PREFIX}*`,
            Condition: {
              StringEquals: {
                "aws:SourceArn": bucket.arn,
                "aws:SourceAccount": ctx.accountId,
              },
            },
          },
        ],
      }),
    });

    // -----------------------------------------------------------------------
    // Availability backstop — daily S3 Inventory
    // -----------------------------------------------------------------------
    //
    // Event delivery is at-least-once, not exactly-once, and the handler
    // deliberately swallows a malformed notification rather than letting S3
    // redeliver a batch forever. Both are right, and both mean something can be
    // lost — so without this a record can stay wrong indefinitely, and the
    // wrongness is invisible until somebody tries to read it.
    //
    // Inventory rather than a HeadObject sweep: at roughly $0.0025 per million
    // objects listed it is nearly free, where probing a 300k-object library
    // daily is 300k requests. That cost difference is the reason availability
    // is a maintained fact at all.
    //
    // Written back into the same bucket under a reserved prefix. A second
    // bucket would need its own policy, lifecycle and teardown for data that is
    // regenerated daily and worthless the moment it is read.
    //
    // Created after the bucket policy (and ordered on it explicitly): the
    // policy's AllowInventoryDelivery statement is what makes delivery
    // possible, and Pulumi would otherwise schedule the two in parallel.
    new aws.s3.Inventory(`${ctx.stackPrefix}-files-inventory`, {
      bucket: bucket.id,
      name: "availability",
      includedObjectVersions: "Current",
      schedule: { frequency: "Daily" },
      // Only shared blobs. App-syncable files are not subject to archiving,
      // so listing them would be paying to enumerate rows nothing reads.
      filter: { prefix: "shared/" },
      optionalFields: [
        "StorageClass",
        // The field that distinguishes a cheap-but-readable I-T object from
        // one that has sunk into an asynchronous archive tier. Without it the
        // reconcile would read storage class alone and call the second one
        // readable — the exact confusion `stat()` was widened to avoid.
        "IntelligentTieringAccessTier",
        "Size",
      ],
      destination: {
        bucket: {
          bucketArn: bucket.arn,
          format: "CSV",
          prefix: INVENTORY_PREFIX,
          accountId: ctx.accountId,
        },
      },
    }, { dependsOn: [filesBucketPolicy] });

    // -----------------------------------------------------------------------
    // Billing bucket + CUR report definition
    //
    // CUR is a global service (us-east-1 only), so we need a dedicated
    // provider for those resources regardless of the deployment region.
    // -----------------------------------------------------------------------
    const usEast1Provider = new aws.Provider("us-east-1-provider", { region: "us-east-1" });

    const billingBucket = new aws.s3.BucketV2(`${ctx.stackPrefix}-billing`, {
      bucket: `${ctx.stackPrefix}-billing-${ctx.accountId}-${ctx.region}`,
      tags: { "starkeep:managed": "true", "starkeep:appId": "cloud-data-server" },
    });

    const curSourceArn = `arn:aws:cur:us-east-1:${ctx.accountId}:definition/*`;
    const billingBucketPolicy = new aws.s3.BucketPolicy(`${ctx.stackPrefix}-billing-policy`, {
      bucket: billingBucket.id,
      policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowCurServiceCheck",
            Effect: "Allow",
            Principal: { Service: "billingreports.amazonaws.com" },
            Action: ["s3:GetBucketAcl", "s3:GetBucketPolicy"],
            Resource: billingBucket.arn,
            Condition: {
              StringEquals: {
                "aws:SourceArn": curSourceArn,
                "aws:SourceAccount": ctx.accountId,
              },
            },
          },
          {
            Sid: "AllowCurDelivery",
            Effect: "Allow",
            Principal: { Service: "billingreports.amazonaws.com" },
            Action: "s3:PutObject",
            Resource: pulumi.interpolate`${billingBucket.arn}/*`,
            Condition: {
              StringEquals: {
                "aws:SourceArn": curSourceArn,
                "aws:SourceAccount": ctx.accountId,
              },
            },
          },
        ],
      }),
    });

    const reportName = `${ctx.stackPrefix}-billing`;
    new aws.cur.ReportDefinition(reportName, {
      reportName,
      timeUnit: "DAILY",
      format: "textORcsv",
      compression: "GZIP",
      additionalSchemaElements: [],
      s3Bucket: billingBucket.bucket,
      s3Prefix: "reports",
      s3Region: ctx.region,
      refreshClosedReports: true,
      reportVersioning: "OVERWRITE_REPORT",
    }, { provider: usEast1Provider, dependsOn: [billingBucket, billingBucketPolicy] });

    // -----------------------------------------------------------------------
    // Stack outputs — matches what per-app installs read to attach their
    // own routes to this gateway.
    // -----------------------------------------------------------------------
    return {
      auroraHostname,
      bucketName: bucket.bucket,
      billingBucketName: billingBucket.bucket,
      apiGatewayId: api.id,
      apiGatewayExecutionArn: api.executionArn,
      // $default stage is served at the API root — do not append the stage name.
      apiGatewayUrl: pulumi.all([api.apiEndpoint, stage.name]).apply(([endpoint, name]) =>
        name === "$default" ? endpoint : `${endpoint}/${name}`,
      ),
      // Browser-facing base URL — the CloudFront distribution domain. Everything
      // downstream (runtime-config → SPA data-client / cloud-config / admin-web)
      // derives its origin from this. Server-to-server calls keep using
      // apiGatewayUrl directly (see the URL-plumbing decision in the plan).
      publicBaseUrl,
      // CloudFront URL-signing material (Part B). The installer bundles these
      // into the `cloudfrontSigningParamName` SecureString post-Pulumi under
      // Manager creds (the CDS role is read-only on SSM). keyPairId and domain
      // are plain resource outputs; privateKey is a secret output (already
      // sensitive via the tls provider, so it stays encrypted in stack state
      // and is only decrypted into the installer process to write the param).
      cloudfrontKeyPairId: cfPublicKey.id,
      cloudfrontSigningDomain: distribution.domainName,
      cloudfrontSigningPrivateKey: signingKey.privateKeyPem,
      authorizerId: authorizer.id,
      // Per-app installs read this to attach `auth: "session"` routes. See
      // ComputeContext.sessionAuthorizerId.
      sessionAuthorizerId: sessionAuthorizer.id,
      functionArn: fn.arn,
      region: ctx.region,
    };
  };
}
