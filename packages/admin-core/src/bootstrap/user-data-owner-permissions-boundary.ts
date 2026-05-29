import type { IamStatement } from "../iam-utils.js";

/**
 * Policy statements for the ${StackPrefix}-user-data-owner-permissions-boundary
 * managed policy.
 *
 * This boundary is the *ceiling* for the single User-Data-Owner role minted at
 * Starkeep Drive install (the `starkeep-drive` app id). Drive is the standing
 * cloud-write identity for all shared-record sync: every shared record reaches
 * the cloud under Drive's role, type-confined locally before ship (layer 1) and
 * bounded here in the cloud by Drive's IAM grant (layer 2 — the hard floor).
 *
 * It is wider than the per-app boundary only in that it permits read/write
 * across the *entire* shared-data prefix (`shared/*`) rather than a single app's
 * own prefix. It is narrower than the foundational boundary: no Lambda, no API
 * Gateway, no per-app schema, no DSQL cluster admin, and no IAM mutation.
 *
 * A magic-string check in the installer (createAppRole) routes only the
 * `starkeep-drive` app id to this boundary, so a third-party app cannot opt into
 * the cross-cutting `shared/*` ceiling.
 */
export function userDataOwnerPermissionsBoundaryStatements(
  stackPrefix: string,
): IamStatement[] {
  return [
    {
      // dsql:DbConnect (not admin): Drive maps to a PG role with the wildcard
      // shared-type grants created by its install DDL. No cluster admin.
      Sid: "UserDataOwnerDsqlConnect",
      Effect: "Allow",
      Action: "dsql:DbConnect",
      Resource: "*",
    },
    {
      // The layer-2 hard floor: read/write across the whole shared-data prefix.
      // Drive's runtime policy narrows this to its granted types; the boundary
      // caps it at `shared/*` so a compromised host writing through Drive can
      // never exceed the shared-data prefix.
      Sid: "UserDataOwnerS3SharedData",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: `arn:aws:s3:::${stackPrefix}-files-*/shared/*`,
    },
    {
      // Bucket-level ListBucket, scoped to the shared prefix so Drive can
      // enumerate shared objects but not other apps' private prefixes.
      Sid: "UserDataOwnerS3ListShared",
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: `arn:aws:s3:::${stackPrefix}-files-*`,
      Condition: {
        StringLike: { "s3:prefix": ["shared/*"] },
      },
    },
    {
      // Defense-in-depth: deny every mutating IAM verb. Mirrors the Deny block
      // in the other boundaries.
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
