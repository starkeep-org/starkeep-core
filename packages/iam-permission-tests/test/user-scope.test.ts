/**
 * A per-app session reaches one user's objects, and only through the tag the
 * broker sets.
 *
 * The broker tags every per-app session with `starkeep:userId`. The per-app and
 * Drive boundaries and runtime policies scope shared data and the app's own
 * prefix to that user, so IAM refuses one user's session another user's
 * objects. Manager's install and uninstall sessions name no user: they reach
 * the app's own prefix whole, for the `.keep` marker and the uninstall cleanup,
 * and no shared data at all. See
 * `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, steps 4.6–4.7.
 */
import { describe, expect, test } from "vitest";
import { buildContext } from "../src/contexts";
import { simulateOne } from "../src/simulate";

const INPUT = {
  stackPrefix: "starkeep",
  accountId: "000000000000",
  region: "us-east-2",
  appId: "photos",
};
// A concrete bucket: a literal `*` in a requested ARN matches any path under
// the policy's own `starkeep-files-*`, which would allow every key.
const BUCKET = "arn:aws:s3:::starkeep-files-000000000000-us-east-2";

function context(name: string, user: string | null) {
  const ctx = buildContext(name, INPUT);
  const vars = { ...ctx.contextVariables };
  delete vars["aws:PrincipalTag/starkeep:userId"];
  return {
    ...ctx,
    contextVariables: user === null ? vars : { ...vars, "aws:PrincipalTag/starkeep:userId": user },
  };
}

async function verdict(name: string, user: string | null, action: string, resource: string) {
  const r = await simulateOne(context(name, user), INPUT.accountId, action, resource);
  return r.verdict;
}

describe.each(["runtime-app", "runtime-user-data-owner"])("%s", (name) => {
  test("reaches the session user's shared objects", async () => {
    expect(
      await verdict(name, "user-a", "s3:GetObject", `${BUCKET}/shared/user-a/image/ab/abc`),
    ).toBe("Allowed");
  });

  test("is refused another user's shared objects", async () => {
    for (const action of ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]) {
      expect(
        await verdict(name, "user-a", action, `${BUCKET}/shared/user-b/image/ab/abc`),
      ).not.toBe("Allowed");
    }
  });

  test("is refused the old layout, which names no user", async () => {
    expect(await verdict(name, "user-a", "s3:GetObject", `${BUCKET}/shared/image/ab/abc`)).not.toBe(
      "Allowed",
    );
  });

  test("reaches no shared object without a user", async () => {
    expect(
      await verdict(name, null, "s3:GetObject", `${BUCKET}/shared/user-a/image/ab/abc`),
    ).not.toBe("Allowed");
  });
});

describe("the app's own prefix", () => {
  test("a user's session reaches its own part, and not another user's", async () => {
    expect(
      await verdict(
        "runtime-app",
        "user-a",
        "s3:PutObject",
        `${BUCKET}/apps/photos/user-a/syncable/cover`,
      ),
    ).toBe("Allowed");
    expect(
      await verdict(
        "runtime-app",
        "user-a",
        "s3:GetObject",
        `${BUCKET}/apps/photos/user-b/syncable/cover`,
      ),
    ).not.toBe("Allowed");
    expect(
      await verdict("runtime-app", "user-a", "s3:PutObject", `${BUCKET}/apps/photos/.keep`),
    ).not.toBe("Allowed");
  });

  test("a session with no user reaches it whole, for install and uninstall", async () => {
    expect(
      await verdict("install-app-role", null, "s3:PutObject", `${BUCKET}/apps/photos/.keep`),
    ).toBe("Allowed");
    expect(
      await verdict(
        "install-app-role",
        null,
        "s3:DeleteObject",
        `${BUCKET}/apps/photos/user-b/syncable/cover`,
      ),
    ).toBe("Allowed");
  });

  test("never reaches another app's prefix", async () => {
    expect(
      await verdict(
        "runtime-app",
        "user-a",
        "s3:GetObject",
        `${BUCKET}/apps/memo/user-a/syncable/x`,
      ),
    ).not.toBe("Allowed");
    expect(
      await verdict("install-app-role", null, "s3:GetObject", `${BUCKET}/apps/memo/.keep`),
    ).not.toBe("Allowed");
  });
});
