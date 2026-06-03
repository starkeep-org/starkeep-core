import type { IamStatement } from "../iam-utils.js";

/**
 * Policy statements for the ${StackPrefix}-install-ddl-permissions-boundary managed policy.
 *
 * This boundary is attached to the install-ddl-role, whose sole purpose is to
 * connect to DSQL as PG admin during app install/uninstall DDL. The ceiling is
 * exactly dsql:DbConnectAdmin plus a defense-in-depth IAM Deny so the role can
 * never be weaponized for IAM mutations even if its inline policies are changed.
 */
export function installDdlBoundaryStatements(stackPrefix: string): IamStatement[] {
  void stackPrefix; // no stack-scoped resources; boundary applies account-wide
  return [
    {
      Sid: "InstallDdlDbConnectAdmin",
      Effect: "Allow",
      Action: "dsql:DbConnectAdmin",
      Resource: "*",
    },
    {
      // Defense-in-depth: deny every mutating IAM verb. Mirrors the Deny block
      // in the app permissions boundary (permissions-boundary.ts).
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
