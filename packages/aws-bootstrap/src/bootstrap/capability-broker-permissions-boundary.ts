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
 * The wired increment is INLINE-ONLY (base64 content inlined by the CDS): the
 * capability role needs no S3 access, so this boundary is purely Bedrock invoke
 * + the IAM-mutation deny. The S3-location input path (and the deferred async
 * S3-output path) would add a session-scoped s3:GetObject/s3:PutObject here,
 * gated on the §7-step-1 session-policy proof-of-concept — not built yet.
 */
export function capabilityBrokerPermissionsBoundaryStatements(
  _stackPrefix: string,
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
      ],
      Resource: [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*",
        "arn:aws:bedrock:*:*:application-inference-profile/*",
      ],
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
