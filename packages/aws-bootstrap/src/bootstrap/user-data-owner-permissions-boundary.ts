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
 * It is wider than the per-app boundary in that it permits read/write across the
 * *entire* shared-data prefix (`shared/*`); it also retains the same per-app
 * own-prefix grant every per-app role gets (`apps/<appId>/*`), which the generic
 * install/uninstall flow relies on (the `.keep` sentinel write and the
 * files-bucket cleanup both target `apps/starkeep-drive/*`). It is narrower than
 * the foundational boundary: no Lambda, no API Gateway, no per-app schema, no
 * DSQL cluster admin, and no IAM mutation.
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
      // Per-object verbs on the app's own prefix, scoped by the principal tag
      // (every Manager-minted role is tagged starkeep:appId). The generic
      // install flow writes apps/<appId>/.keep and the uninstall flow deletes
      // apps/<appId>/* under this role, so the own-prefix grant must be
      // reachable through the ceiling just as it is on the regular per-app
      // boundary. Plain ${aws:PrincipalTag/...} literal (no Fn::Sub — the slash
      // in the variable name is rejected by Sub; stackPrefix is interpolated at
      // generation time).
      Sid: "UserDataOwnerS3OwnPrefix",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: `arn:aws:s3:::${stackPrefix}-files-*/apps/\${aws:PrincipalTag/starkeep:appId}/*`,
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
      // Bucket-level ListBucket, scoped to the app's own prefix and the shared
      // prefix so Drive can enumerate its own objects (uninstall cleanup) and
      // shared objects, but not other apps' private prefixes.
      Sid: "UserDataOwnerS3ListOwnAndShared",
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: `arn:aws:s3:::${stackPrefix}-files-*`,
      Condition: {
        StringLike: {
          "s3:prefix": [
            `apps/\${aws:PrincipalTag/starkeep:appId}/*`,
            "shared/*",
          ],
        },
      },
    },
    {
      // Drive's per-app HMAC credential. Same shape as the per-app boundary;
      // narrowed in Drive's runtime policy to /${stackPrefix}/app-creds/
      // starkeep-drive only.
      Sid: "UserDataOwnerReadAppCreds",
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource: `arn:aws:ssm:*:*:parameter/${stackPrefix}/app-creds/*`,
    },
    {
      Sid: "UserDataOwnerReadAppCredsKmsDecrypt",
      Effect: "Allow",
      Action: "kms:Decrypt",
      Resource: "*",
      Condition: {
        StringLike: { "kms:ViaService": "ssm.*.amazonaws.com" },
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
