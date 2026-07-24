import type { IamStatement } from "../iam-utils.js";

/**
 * Policy statements for the ${StackPrefix}-capability-broker-permissions-boundary
 * managed policy (plan §3.3).
 *
 * This boundary is the ceiling for the single ${StackPrefix}-capability-broker-role
 * minted at cloud-data-server deploy. That role holds the borrowed Bedrock-invoke
 * power the CDS assumes PER capability request — the CDS's own foundational
 * boundary never carries bedrock:*; it only gains sts:AssumeRole onto this role.
 *
 * ARN scope is ALL-OR-NOTHING, by decision (plan §3.3 / open question 7): IAM is
 * NOT the layer that decides which providers or models are allowed. There is
 * nothing special about any one provider, and encoding a model/provider
 * allowlist in the boundary would recreate the platform-cadence problem one
 * layer down. So the invoke actions are scoped to ALL Bedrock foundation models
 * and inference profiles (arn:aws:bedrock:*:*:*), and ALL provider/model
 * restriction lives in the usage-limitation framework (effective model registry
 * + per-app grant models list + per-provider/per-model gates). The compensating
 * floor is that this role can STILL ONLY invoke Bedrock — no data, no other
 * services — and the gate framework bounds cost, a dimension IAM cannot express.
 *
 * S3-LOCATION I/O (plan §3.4, open-question 10 — PoC PASSED 2026-07-24). Besides
 * inline base64, the broker also delivers large/many images to Bedrock BY S3 URI,
 * which Bedrock reads under the *invoking* (capability) principal — so the role
 * needs s3:GetObject. The §7-step-1 PoC proved (TC3) a session policy can only
 * TRIM, never grant, so the achievable design is: this boundary permits
 * s3:GetObject scoped to the APP-DATA AREA (the files bucket) — never `*` (TC2:
 * whatever the standing role can reach is the blast radius of a missing session
 * policy) — the role's identity policy carries that same broad-within-app-data
 * read, and the broker attaches a SINGLE-KEY inline session policy on EVERY
 * capability assume so each call's reach is exactly the one object the app was
 * just proven able to read (the §3.4-step-4 app-role read stays the independent
 * authorization). The async S3-*output* path (§3.8) is the mirror: Bedrock's
 * StartAsyncInvoke WRITES the generated output under the capability role, so this
 * boundary also permits a per-assume-narrowed s3:PutObject on the app-data area
 * plus the async invoke verbs (Start/Get/ListAsyncInvoke).
 */
export function capabilityBrokerPermissionsBoundaryStatements(
  stackPrefix: string,
): IamStatement[] {
  return [
    {
      // All-Bedrock invoke. Covers both foundation-model and inference-profile
      // ARNs across regions, so new cross-region profiles work with no boundary
      // change. Streaming variant included (table stakes, §3.6).
      Sid: "CapabilityBedrockInvoke",
      Effect: "Allow",
      Action: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:Converse",
        "bedrock:ConverseStream",
        // Async generation (§3.8): the output is written to S3 out-of-band and
        // the job is polled to completion.
        "bedrock:StartAsyncInvoke",
        "bedrock:GetAsyncInvoke",
        "bedrock:ListAsyncInvokes",
      ],
      Resource: [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*",
        "arn:aws:bedrock:*:*:application-inference-profile/*",
        // Async invocation ARNs are the resource of Get/ListAsyncInvoke.
        "arn:aws:bedrock:*:*:async-invoke/*",
      ],
    },
    {
      // S3-location I/O ceiling (plan §3.4 / §3.8 / open-question 10). Scoped to
      // the APP-DATA AREA — the files bucket, never `*` — because TC2 proved the
      // standing role's reach IS the blast radius of a forgotten session policy.
      // The role's identity policy carries the same grant (TC3: a session policy
      // can only trim it); the broker narrows it to one key (GetObject, S3-location
      // INPUT) or one prefix (PutObject, async S3 OUTPUT §3.8) per assume.
      Sid: "CapabilitySessionScopedS3IO",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject"],
      Resource: `arn:aws:s3:::${stackPrefix}-files-*/*`,
    },
    {
      // Defense-in-depth: deny every mutating IAM verb, mirroring the other
      // boundaries. Read-only IAM verbs stay implicitly denied (nothing Allows
      // them). Nothing else is permitted — this role is invoke-only.
      Sid: "DenyOtherIam",
      Effect: "Deny",
      Action: [
        "iam:Add*",
        "iam:Attach*",
        "iam:Change*",
        "iam:Create*",
        "iam:Deactivate*",
        "iam:Delete*",
        "iam:Detach*",
        "iam:Enable*",
        "iam:Generate*",
        "iam:Put*",
        "iam:Remove*",
        "iam:Reset*",
        "iam:Resync*",
        "iam:Set*",
        "iam:Tag*",
        "iam:Untag*",
        "iam:Update*",
        "iam:Upload*",
      ],
      Resource: "*",
    },
  ];
}
