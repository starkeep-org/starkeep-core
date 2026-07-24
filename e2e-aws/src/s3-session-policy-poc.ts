/**
 * Proof-of-concept: session-policy downscoping for the capability broker's
 * S3-location I/O path (plan `plan-cloud-capability-broker-bedrock-2026-07-22`,
 * §3.4 risk callout + §7 sequencing step 1 — "de-risk first").
 *
 * WHY THIS EXISTS, AND WHY IT IS STEP ONE
 * ---------------------------------------
 * The wired capability broker is INLINE-ONLY today: the CDS reads a referenced
 * item under the app's own role and base64-inlines the bytes into the Bedrock
 * request, so the capability role needs no S3 access at all. §3.4 sketches a
 * second delivery path — pass the object to Bedrock BY S3 URI — which is needed
 * for large/many images that blow the inline request-size/timeout limit. But an
 * S3-location read happens under the *capability* role (Bedrock reads as the
 * invoking principal), so that role would need `s3:GetObject`. The plan's
 * mitigation is to hold NO standing object access on the role and, per invoke,
 * assume it with an INLINE SESSION POLICY scoped to exactly the one object key
 * that step-4 (the app-role read) just proved the app may read.
 *
 * That shifts the "which object" boundary from *IAM enforcing the app role's own
 * policy* (belt) to *broker logic computing a correct session policy*
 * (suspenders) — a new, security-load-bearing assumption. §7 makes validating it
 * the FIRST implementation step and gates the §3.3/§3.4 S3 decisions on the
 * result: if session-policy downscoping does not behave as assumed, the
 * increment stays inline-only.
 *
 * WHAT THIS POC EMPIRICALLY DETERMINES (against real AWS/IAM)
 * ----------------------------------------------------------
 * It stands up a disposable bucket (two objects: one "allowed", one "forbidden"),
 * a capability-broker-style permissions boundary that PERMITS s3:GetObject on the
 * bucket, and two roles under that boundary, then assumes them via STS in three
 * ways:
 *
 *   TC1 — Downscoping works (the core §7 claim).
 *     Role with BROAD s3:GetObject in its identity policy, assumed WITH an inline
 *     session policy scoped to the one allowed key.
 *       → GET allowed key  == success
 *       → GET forbidden key == AccessDenied
 *     Proves a per-assume inline session policy narrows s3:GetObject to exactly
 *     one key and denies every other. This is the assumption §7 step 1 exists to
 *     check; if it holds, the S3-location path is viable.
 *
 *   TC2 — The standing role is BROAD (the honest residual-risk shape).
 *     Same broad role, assumed with NO session policy.
 *       → GET forbidden key == success
 *     Documents that the narrowing is a BELT the broker must remember to fasten
 *     on every assume; the standing role can read the whole bucket. So the
 *     §3.4-step-4 app-role read stays the load-bearing SUSPENDERS (independent
 *     proof the app may read the object), and the boundary must scope the role's
 *     S3 to the app-data area only — not `*`.
 *
 *   TC3 — A session policy can only RESTRICT, never GRANT.
 *     Role with NO s3 in its identity policy (boundary still permits s3), assumed
 *     WITH a session policy that tries to grant the allowed key.
 *       → GET allowed key == AccessDenied
 *     Proves the plan's literal aspiration — "the standing role holds no object
 *     access; each assume scopes it to exactly one key" — is NOT achievable with
 *     session policies alone (effective perms are the INTERSECTION of identity ∩
 *     boundary ∩ session policy; a session policy cannot add what the identity
 *     policy lacks). The achievable design is therefore TC1+TC2: broad standing
 *     read on the app-data area, downscoped per-assume, with the app-role read as
 *     the independent authorization.
 *
 * VERDICT (consumed by the test + reported to the operator): the S3-location path
 * is viable IFF TC1 holds; TC2/TC3 fix the exact shape of the boundary and the
 * broker's per-assume obligation. All resources are torn down in a finally block.
 *
 * Self-contained: it does NOT need the bootstrap stack or a CDS deploy — just
 * ambient AWS credentials with IAM+S3+STS authority (the e2e-aws default profile).
 */

import {
  IAMClient,
  CreatePolicyCommand,
  CreateRoleCommand,
  PutRolePolicyCommand,
  DeletePolicyCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import { REGION, STACK_PREFIX } from "./env.js";

/** Result of one GET attempt against S3 under assumed creds. */
type GetOutcome = "success" | "access-denied" | { unexpectedError: string };

export interface PocCaseResult {
  name: string;
  /** Human-readable description of what the case proves. */
  what: string;
  passed: boolean;
  detail: string;
}

export interface PocResult {
  bucket: string;
  region: string;
  account: string;
  cases: PocCaseResult[];
  /** True iff every case matched its expectation. */
  allPassed: boolean;
  /** Plan-level conclusion derived from the cases. */
  verdict: string;
}

const ALLOWED_KEY = "allowed/a.txt";
const FORBIDDEN_KEY = "forbidden/b.txt";

/** Assume-role session policy scoping s3:GetObject to exactly one object key. */
function singleKeySessionPolicy(bucket: string, key: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowExactlyOneKey",
        Effect: "Allow",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucket}/${key}`,
      },
    ],
  });
}

/**
 * The PROPOSED capability-broker permissions boundary for the S3-location path:
 * the shipped Bedrock-invoke-only boundary PLUS the session-scoped s3:GetObject
 * the plan (§3.3 caveat) says the boundary would permit — scoped here to the one
 * disposable bucket (mirroring "the app-data area only", never `*`). The IAM
 * mutation deny is carried over from the real boundary as defense-in-depth.
 */
function boundaryPolicyDocument(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "CapabilityBedrockInvoke",
        Effect: "Allow",
        Action: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:Converse",
          "bedrock:ConverseStream",
        ],
        Resource: [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:*:*:inference-profile/*",
          "arn:aws:bedrock:*:*:application-inference-profile/*",
        ],
      },
      {
        // The S3-location addition under test: the boundary PERMITS GetObject on
        // the app-data area; the standing/session grant narrows within it.
        Sid: "CapabilitySessionScopedS3Read",
        Effect: "Allow",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
      {
        Sid: "DenyOtherIam",
        Effect: "Deny",
        Action: [
          "iam:Add*", "iam:Attach*", "iam:Change*", "iam:Create*", "iam:Deactivate*",
          "iam:Delete*", "iam:Detach*", "iam:Enable*", "iam:Generate*", "iam:Put*",
          "iam:Remove*", "iam:Reset*", "iam:Resync*", "iam:Set*", "iam:Tag*",
          "iam:Untag*", "iam:Update*", "iam:Upload*",
        ],
        Resource: "*",
      },
    ],
  });
}

/** Trust policy allowing the current account (root) to assume the PoC role. */
function trustPolicy(account: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${account}:root` },
        Action: "sts:AssumeRole",
      },
    ],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Classify a GetObject attempt as success / access-denied / unexpected. */
async function tryGet(s3: S3Client, bucket: string, key: string): Promise<GetOutcome> {
  try {
    await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return "success";
  } catch (err) {
    const name = (err as { name?: string }).name ?? "";
    // S3 returns AccessDenied (403) when identity ∩ boundary ∩ session policy
    // does not permit the key.
    if (name === "AccessDenied" || name === "AccessDeniedException") return "access-denied";
    return { unexpectedError: `${name}: ${(err as Error).message}` };
  }
}

/**
 * Assume `roleArn` (optionally with an inline session policy) and return an
 * S3 client bound to the resulting temporary credentials.
 *
 * Freshly-created roles/policies are eventually consistent, so the assume is
 * retried through the propagation window before giving up.
 */
async function assumeS3Client(
  sts: STSClient,
  roleArn: string,
  sessionPolicy: string | undefined,
): Promise<S3Client> {
  const deadline = Date.now() + 90_000;
  let lastErr: unknown;
  for (;;) {
    try {
      const out = await sts.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: "s3-poc",
          DurationSeconds: 900,
          Policy: sessionPolicy,
        }),
      );
      const c = out.Credentials!;
      return new S3Client({
        region: REGION,
        credentials: {
          accessKeyId: c.AccessKeyId!,
          secretAccessKey: c.SecretAccessKey!,
          sessionToken: c.SessionToken!,
        },
      });
    } catch (err) {
      lastErr = err;
      if (Date.now() > deadline) break;
      await sleep(3000);
    }
  }
  throw new Error(
    `AssumeRole never succeeded for ${roleArn}: ${(lastErr as Error)?.message ?? lastErr}`,
  );
}

/**
 * Poll an "expected success" GET until it stops returning AccessDenied — the
 * signal that the role's identity policy + session policy have propagated. Used
 * ONCE, on TC1's allowed key, so that the subsequent negative assertions are not
 * measuring propagation lag (which would deny for the wrong reason and false-pass).
 */
async function waitForGetToSucceed(s3: S3Client, bucket: string, key: string): Promise<GetOutcome> {
  const deadline = Date.now() + 90_000;
  let outcome: GetOutcome = "access-denied";
  for (;;) {
    outcome = await tryGet(s3, bucket, key);
    if (outcome === "success" || Date.now() > deadline) return outcome;
    await sleep(3000);
  }
}

interface PocResources {
  bucket: string;
  boundaryArn: string;
  broadRoleName: string;
  broadRoleArn: string;
  noAccessRoleName: string;
  noAccessRoleArn: string;
}

async function setup(
  iam: IAMClient,
  s3: S3Client,
  account: string,
  suffix: string,
): Promise<PocResources> {
  const bucket = `${STACK_PREFIX}-s3poc-${suffix}`.toLowerCase();
  const boundaryName = `${STACK_PREFIX}-s3poc-boundary-${suffix}`;
  const broadRoleName = `${STACK_PREFIX}-s3poc-role-broad-${suffix}`;
  const noAccessRoleName = `${STACK_PREFIX}-s3poc-role-noaccess-${suffix}`;

  // Bucket + objects. us-east-1 rejects an explicit LocationConstraint.
  await s3.send(
    new CreateBucketCommand({
      Bucket: bucket,
      ...(REGION === "us-east-1"
        ? {}
        : { CreateBucketConfiguration: { LocationConstraint: REGION as never } }),
    }),
  );
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: ALLOWED_KEY, Body: "ALLOWED" }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: FORBIDDEN_KEY, Body: "FORBIDDEN" }));

  // Permissions boundary (managed policy) permitting Bedrock invoke + scoped S3.
  const boundary = await iam.send(
    new CreatePolicyCommand({
      PolicyName: boundaryName,
      PolicyDocument: boundaryPolicyDocument(bucket),
      Description: "PoC: capability-broker boundary with session-scoped s3:GetObject",
    }),
  );
  const boundaryArn = boundary.Policy!.Arn!;

  // Role A — broad identity GetObject on the whole bucket, under the boundary.
  const broad = await iam.send(
    new CreateRoleCommand({
      RoleName: broadRoleName,
      AssumeRolePolicyDocument: trustPolicy(account),
      PermissionsBoundary: boundaryArn,
      Description: "PoC broad-read capability role (session policy narrows per assume)",
    }),
  );
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: broadRoleName,
      PolicyName: "broad-s3-get",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` },
        ],
      }),
    }),
  );

  // Role B — NO s3 in identity (only a harmless self-identity read), same boundary.
  const noAccess = await iam.send(
    new CreateRoleCommand({
      RoleName: noAccessRoleName,
      AssumeRolePolicyDocument: trustPolicy(account),
      PermissionsBoundary: boundaryArn,
      Description: "PoC no-standing-access role (tests session policy cannot grant)",
    }),
  );
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: noAccessRoleName,
      PolicyName: "sts-selfid-only",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" }],
      }),
    }),
  );

  return {
    bucket,
    boundaryArn,
    broadRoleName,
    broadRoleArn: broad.Role!.Arn!,
    noAccessRoleName,
    noAccessRoleArn: noAccess.Role!.Arn!,
  };
}

async function teardown(iam: IAMClient, s3: S3Client, r: Partial<PocResources>): Promise<string[]> {
  const problems: string[] = [];
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      problems.push(`${label}: ${(err as Error).message}`);
    }
  };

  if (r.broadRoleName) {
    await attempt("delete broad inline policy", () =>
      iam.send(new DeleteRolePolicyCommand({ RoleName: r.broadRoleName!, PolicyName: "broad-s3-get" })),
    );
    await attempt("delete broad role", () =>
      iam.send(new DeleteRoleCommand({ RoleName: r.broadRoleName! })),
    );
  }
  if (r.noAccessRoleName) {
    await attempt("delete noaccess inline policy", () =>
      iam.send(
        new DeleteRolePolicyCommand({ RoleName: r.noAccessRoleName!, PolicyName: "sts-selfid-only" }),
      ),
    );
    await attempt("delete noaccess role", () =>
      iam.send(new DeleteRoleCommand({ RoleName: r.noAccessRoleName! })),
    );
  }
  if (r.boundaryArn) {
    await attempt("delete boundary policy", () =>
      iam.send(new DeletePolicyCommand({ PolicyArn: r.boundaryArn! })),
    );
  }
  if (r.bucket) {
    for (const key of [ALLOWED_KEY, FORBIDDEN_KEY]) {
      await attempt(`delete object ${key}`, () =>
        s3.send(new DeleteObjectCommand({ Bucket: r.bucket!, Key: key })),
      );
    }
    await attempt("delete bucket", () => s3.send(new DeleteBucketCommand({ Bucket: r.bucket! })));
  }
  return problems;
}

/** Run the full PoC (setup → three cases → teardown) and return the verdict. */
export async function runS3SessionPolicyPoc(): Promise<PocResult> {
  const iam = new IAMClient({ region: REGION });
  const sts = new STSClient({ region: REGION });
  const s3Admin = new S3Client({ region: REGION });

  const account = (await sts.send(new GetCallerIdentityCommand({})))!.Account!;
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let resources: Partial<PocResources> = {};
  const cases: PocCaseResult[] = [];
  try {
    resources = await setup(iam, s3Admin, account, suffix);
    const { bucket, broadRoleArn, noAccessRoleArn } = resources as PocResources;

    // --- TC1: downscoping works ------------------------------------------------
    const s3Narrowed = await assumeS3Client(
      sts,
      broadRoleArn,
      singleKeySessionPolicy(bucket, ALLOWED_KEY),
    );
    // Settle propagation on the positive read first, so the negative reads below
    // are not measuring lag.
    const tc1Allowed = await waitForGetToSucceed(s3Narrowed, bucket, ALLOWED_KEY);
    const tc1Forbidden = await tryGet(s3Narrowed, bucket, FORBIDDEN_KEY);
    cases.push({
      name: "TC1 session-policy downscoping narrows to one key",
      what: "broad role + inline session policy scoped to the allowed key → reads it, denies all others",
      passed: tc1Allowed === "success" && tc1Forbidden === "access-denied",
      detail: `allowed=${fmt(tc1Allowed)} forbidden=${fmt(tc1Forbidden)}`,
    });

    // --- TC2: the standing role is broad --------------------------------------
    const s3Standing = await assumeS3Client(sts, broadRoleArn, undefined);
    // Positive-first settle, then the residual-risk read.
    await waitForGetToSucceed(s3Standing, bucket, ALLOWED_KEY);
    const tc2Forbidden = await tryGet(s3Standing, bucket, FORBIDDEN_KEY);
    cases.push({
      name: "TC2 standing role (no session policy) reads the whole bucket",
      what: "same role assumed WITHOUT a session policy → reads the forbidden key too (narrowing is belt-only)",
      passed: tc2Forbidden === "success",
      detail: `forbidden=${fmt(tc2Forbidden)}`,
    });

    // --- TC3: a session policy cannot grant -----------------------------------
    const s3NoAccess = await assumeS3Client(
      sts,
      noAccessRoleArn,
      singleKeySessionPolicy(bucket, ALLOWED_KEY),
    );
    // No positive to settle on (there should be none); allow propagation time so
    // a slow-to-attach identity policy can't spuriously make this "succeed".
    await sleep(15_000);
    const tc3Allowed = await tryGet(s3NoAccess, bucket, ALLOWED_KEY);
    cases.push({
      name: "TC3 session policy cannot GRANT beyond the identity policy",
      what: "role with no s3 in identity + session policy granting the key → still denied (effective = intersection)",
      passed: tc3Allowed === "access-denied",
      detail: `allowed=${fmt(tc3Allowed)} (expected access-denied)`,
    });
  } finally {
    const problems = await teardown(iam, s3Admin, resources);
    if (problems.length) {
      // Teardown problems don't fail the PoC's finding, but must be visible so
      // the disposable account doesn't accumulate orphaned roles/buckets.
      cases.push({
        name: "teardown",
        what: "all PoC resources removed",
        passed: false,
        detail: `left behind: ${problems.join("; ")}`,
      });
    }
  }

  const findingCases = cases.filter((c) => c.name !== "teardown");
  const allPassed = cases.every((c) => c.passed);
  const downscopeHeld = findingCases.find((c) => c.name.startsWith("TC1"))?.passed === true;
  const verdict = downscopeHeld
    ? "VIABLE — session-policy downscoping narrows s3:GetObject to a single key (TC1). " +
      "The standing role holds BROAD read (TC2) and a session policy cannot grant what the " +
      "identity policy lacks (TC3), so the S3-location path must: (a) scope the boundary's " +
      "s3:GetObject to the app-data area only, (b) attach a single-key session policy on EVERY " +
      "assume, and (c) keep the §3.4-step-4 app-role read as the independent authorization. " +
      "Per §7 step 1, proceed to implement the S3-location path."
    : "NOT VIABLE as assumed — session-policy downscoping did not narrow to one key. " +
      "Per §7 step 1, keep the initial increment INLINE-ONLY and revisit.";

  return {
    bucket: resources.bucket ?? "(not created)",
    region: REGION,
    account,
    cases,
    allPassed,
    verdict,
  };
}

function fmt(o: GetOutcome): string {
  return typeof o === "string" ? o : `unexpected(${o.unexpectedError})`;
}
