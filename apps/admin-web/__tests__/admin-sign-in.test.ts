/**
 * Admin-web refuses an account outside `starkeep-admins` before it asks the
 * identity pool, which would deny it with an error that names no reason.
 */
import { describe, expect, it } from "vitest";
import { getIdentityPoolCredentials, groupsOfIdToken, NOT_AN_ADMIN } from "../src/lib/cognito-auth";

const token = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

const CONFIG = { region: "us-east-2", userPoolId: "us-east-2_P", userPoolClientId: "c", identityPoolId: "us-east-2:id" };

describe("groupsOfIdToken", () => {
  it("reads the groups claim, and none from a token without one", () => {
    expect(groupsOfIdToken(token({ "cognito:groups": ["starkeep-users", "starkeep-admins"] }))).toEqual([
      "starkeep-users",
      "starkeep-admins",
    ]);
    expect(groupsOfIdToken(token({ sub: "x" }))).toEqual([]);
    expect(groupsOfIdToken("not a token")).toEqual([]);
  });
});

describe("signing in to admin-web", () => {
  it.each([
    ["a member", ["starkeep-users"]],
    ["a user in no group", []],
  ])("refuses %s, naming why, before calling the identity pool", async (_who, groups) => {
    await expect(
      getIdentityPoolCredentials(CONFIG as never, token({ "cognito:groups": groups })),
    ).rejects.toThrow(NOT_AN_ADMIN);
  });
});
