/**
 * The foundational boundary's S3 ceiling, tested on its own.
 *
 * The boundary caps the cloud-data-server role. The identity policy here
 * allows everything, so each verdict is the boundary's alone: what any temp
 * policy, however wide, could reach on the files and billing buckets.
 *
 * IAM's `*` in a resource ARN spans `/`, so the bucket globs also match every
 * object. The boundary therefore keeps object reads out through its action
 * patterns, `s3:GetBucket*` and `s3:Get*Configuration`. S3Objects
 * admits plain object reads, writes and deletes on the files bucket only; the
 * version, ACL and tag reads stay out of both buckets. BillingObjects
 * admits only deletes of a billing object, so an ephemeral uninstall's destroy
 * can empty the bucket; nothing under this role reads or writes one.
 */
import { describe, expect, test } from "vitest";
import { foundationalPermissionsBoundaryStatements } from "../../aws-bootstrap/src/bootstrap/foundational-permissions-boundary";
import type { IamContext } from "../src/contexts";
import { simulateOne } from "../src/simulate";

const PREFIX = "starkeep";
const ACCOUNT = "000000000000";
const FILES = `arn:aws:s3:::${PREFIX}-files-${ACCOUNT}-us-east-2`;
const BILLING = `arn:aws:s3:::${PREFIX}-billing-${ACCOUNT}-us-east-2`;

const ctx: IamContext = {
  principalArn: `arn:aws:sts::${ACCOUNT}:assumed-role/${PREFIX}-app-cloud-data-server-role/test`,
  principalRoleName: `${PREFIX}-app-cloud-data-server-role`,
  identityPolicies: [
    {
      name: "everything",
      policy: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
      },
    },
  ],
  permissionBoundaryPolicies: [
    {
      name: "foundational-boundary",
      policy: {
        Version: "2012-10-17",
        Statement: foundationalPermissionsBoundaryStatements(PREFIX),
      },
    },
  ],
  contextVariables: {},
};

async function verdict(action: string, resource: string) {
  return (await simulateOne(ctx, ACCOUNT, action, resource)).verdict;
}

describe("foundational boundary, S3", () => {
  test("allows s3:GetObject on a files object, through S3Objects", async () => {
    expect(await verdict("s3:GetObject", `${FILES}/shared/u1/a.jpg`)).toBe("Allowed");
  });

  test.each(["s3:GetObject", "s3:PutObject"])("refuses %s on a billing object", async (action) => {
    expect(await verdict(action, `${BILLING}/cur/report.csv.gz`)).toBe("ImplicitlyDenied");
  });

  test.each(["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:DeleteObjectTagging"])(
    "allows %s on a billing object, through BillingObjects",
    async (action) => {
      expect(await verdict(action, `${BILLING}/cur/report.csv.gz`)).toBe("Allowed");
    },
  );

  test("allows s3:ListBucketVersions on the billing bucket", async () => {
    expect(await verdict("s3:ListBucketVersions", BILLING)).toBe("Allowed");
  });

  test.each([
    ["s3:ListBucketVersions", FILES],
    ["s3:DeleteObjectVersion", `${FILES}/shared/u1/a.jpg`],
  ])("refuses %s on %s", async (action, resource) => {
    expect(await verdict(action, resource)).toBe("ImplicitlyDenied");
  });

  test.each(
    ["s3:GetObjectVersion", "s3:GetObjectAcl", "s3:GetObjectTagging"].flatMap((action) => [
      [action, `${FILES}/shared/u1/a.jpg`],
      [action, `${BILLING}/cur/report.csv.gz`],
    ]),
  )("refuses %s on %s", async (action, resource) => {
    expect(await verdict(action, resource)).toBe("ImplicitlyDenied");
  });

  test.each(
    ["s3:GetBucketPolicy", "s3:GetLifecycleConfiguration"].flatMap((action) => [
      [action, FILES],
      [action, BILLING],
    ]),
  )("allows %s on %s", async (action, resource) => {
    expect(await verdict(action, resource)).toBe("Allowed");
  });
});
