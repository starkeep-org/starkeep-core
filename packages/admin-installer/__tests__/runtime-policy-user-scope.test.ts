/**
 * The per-app runtime policy scopes every object to the session's user.
 *
 * The broker tags each per-app session with `starkeep:userId`, so a user's
 * request reaches only that user's shared data and that user's part of the
 * app's own prefix, under IAM as well as under the broker's key checks. A
 * session that names no user — Manager's install and uninstall — reaches the
 * app's own prefix whole and no shared data. See
 * `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, steps 4.6–4.7.
 */
import { describe, expect, it } from "vitest";
import { buildRuntimePolicy } from "../src/temp-policies.js";

type Statement = { Sid: string; Resource: string | string[]; Condition?: Record<string, Record<string, unknown>> };
const USER = "${aws:PrincipalTag/starkeep:userId}";

function statements(categories: string[], fileAccessAll: boolean): Map<string, Statement> {
  const doc = JSON.parse(buildRuntimePolicy("starkeep", "photos", categories, true, fileAccessAll)) as {
    Statement: Statement[];
  };
  return new Map(doc.Statement.map((s) => [s.Sid, s]));
}

describe("the runtime policy's user scope", () => {
  it("scopes each granted category to the session's user", () => {
    expect(statements(["image", "video"], false).get("AppS3SharedData")!.Resource).toEqual([
      `arn:aws:s3:::starkeep-files-*/shared/${USER}/image/*`,
      `arn:aws:s3:::starkeep-files-*/shared/${USER}/video/*`,
    ]);
  });

  it("scopes Drive's all-category grant to the session's user", () => {
    expect(statements([], true).get("AppS3SharedData")!.Resource).toEqual([
      `arn:aws:s3:::starkeep-files-*/shared/${USER}/*`,
    ]);
  });

  it("gives a user's session only its part of the app's own prefix", () => {
    const s = statements(["image"], false);
    expect(s.get("AppS3OwnUserPrefix")!.Resource).toBe(`arn:aws:s3:::starkeep-files-*/apps/photos/${USER}/*`);
    expect(s.get("AppS3ListOwnPrefix")!.Condition!["StringLike"]!["s3:prefix"]).toEqual([`apps/photos/${USER}/*`]);
  });

  it("gives the whole own prefix only to a session that names no user", () => {
    const s = statements(["image"], false);
    for (const sid of ["AppS3OwnPrefixNoUser", "AppS3ListOwnPrefixNoUser"]) {
      expect(s.get(sid)!.Condition!["Null"]).toEqual({ "aws:PrincipalTag/starkeep:userId": "true" });
    }
    expect(s.get("AppS3OwnPrefixNoUser")!.Resource).toBe("arn:aws:s3:::starkeep-files-*/apps/photos/*");
  });
});
