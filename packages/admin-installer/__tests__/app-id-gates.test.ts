import { describe, it, expect } from "vitest";
import {
  assertNotReservedAppId,
  assertCloudInstallableAppId,
  buildAppRoleTrustPolicy,
  RESERVED_APP_IDS,
} from "../src/iam";
import { buildAppExecPolicy } from "../src/temp-policies";

describe("reserved app ids", () => {
  it("rejects every built-in id for third-party installs", () => {
    for (const id of ["cloud-data-server", "starkeep-drive", "local-watcher", "local-data-sync"]) {
      expect(RESERVED_APP_IDS.has(id)).toBe(true);
      expect(() => assertNotReservedAppId(id)).toThrow(/reserved for a built-in app/);
    }
  });

  it("passes ordinary app ids through", () => {
    expect(() => assertNotReservedAppId("photos")).not.toThrow();
  });
});

describe("cloud-installable app id format", () => {
  it("accepts conservative lowercase ids", () => {
    for (const id of ["photos", "my-app2", "a.b_c-d"]) {
      expect(() => assertCloudInstallableAppId(id)).not.toThrow();
    }
  });

  it("rejects ids that cannot survive IAM/PG/S3/URL naming", () => {
    for (const id of ["Photos", "@starkeep/x", "a/b", "a+b", "a=b", "-leading", ".leading", ""]) {
      expect(() => assertCloudInstallableAppId(id), id).toThrow(/not cloud-installable/);
    }
  });
});

describe("app data role trust policy", () => {
  function principalsOf(doc: {
    Statement: { Principal: Record<string, string> }[];
  }): string[] {
    return doc.Statement.map((s) => s.Principal.Service ?? s.Principal.AWS);
  }

  it("trusts Manager and the broker, and nothing else, for an ordinary app", () => {
    // Asserted as the exhaustive list rather than as the absence of
    // lambda.amazonaws.com: the property wanted is "nothing else can assume
    // this role", and an absence check does not say that.
    const doc = JSON.parse(buildAppRoleTrustPolicy("starkeep", "111122223333", true));
    expect(principalsOf(doc)).toEqual([
      "arn:aws:iam::111122223333:role/starkeep-manager-role",
      "arn:aws:iam::111122223333:role/starkeep-app-cloud-data-server-role",
    ]);
    for (const s of doc.Statement) expect(s.Effect).toBe("Allow");
  });

  it("does not let Lambda assume an app's data role", () => {
    // The line that used to make the manifest non-binding on the app that
    // wrote it. With Lambda here, an app's own handlers ran as the identity
    // holding its S3 and DSQL grants, so app code could reach every record row
    // of every type and any blob in a granted category — bypassing the broker
    // entirely. Handlers now run as the exec role instead.
    const doc = JSON.parse(buildAppRoleTrustPolicy("starkeep", "111122223333", true));
    expect(principalsOf(doc)).not.toContain("lambda.amazonaws.com");
  });

  it("keeps the Lambda principal on the broker's own role", () => {
    // Not an exception to the rule: the broker *is* what the grants exist for,
    // its Lambda has to run as the identity holding them, and there is no app
    // code inside it to confine.
    const doc = JSON.parse(buildAppRoleTrustPolicy("starkeep", "111122223333", false));
    expect(principalsOf(doc)).toEqual([
      "lambda.amazonaws.com",
      "arn:aws:iam::111122223333:role/starkeep-manager-role",
    ]);
  });
});

describe("app exec role policy", () => {
  /**
   * What the app's Lambdas run as. The point is what is absent.
   */
  const doc = JSON.parse(buildAppExecPolicy("starkeep", "photos")) as {
    Statement: { Sid: string; Action: string | string[]; Resource: unknown }[];
  };
  const actions = doc.Statement.flatMap((s) =>
    Array.isArray(s.Action) ? s.Action : [s.Action],
  );

  it("grants no S3, no DSQL, and no role assumption", () => {
    for (const forbidden of ["s3:", "dsql:", "sts:AssumeRole"]) {
      expect(
        actions.filter((a) => a.startsWith(forbidden)),
        `exec role must grant no ${forbidden}`,
      ).toEqual([]);
    }
  });

  it("grants exactly logs, its own creds parameter, its KMS decrypt, and its own lambdas", () => {
    expect(doc.Statement.map((s) => s.Sid).sort()).toEqual([
      "AppInvokeOwnLambdas",
      "AppLogWrites",
      "AppReadOwnCredsParameter",
      "AppReadOwnCredsParameterKmsDecrypt",
    ]);
  });

  it("scopes the creds parameter to one name, so there is nothing to enumerate", () => {
    const creds = doc.Statement.find((s) => s.Sid === "AppReadOwnCredsParameter")!;
    expect(creds.Action).toBe("ssm:GetParameter");
    expect(creds.Resource).toBe("arn:aws:ssm:*:*:parameter/starkeep/app-creds/photos");
    expect(String(creds.Resource)).not.toContain("app-creds/*");
  });

  it("scopes log writes and lambda invocation to the app's own resources", () => {
    for (const sid of ["AppLogWrites", "AppInvokeOwnLambdas"]) {
      expect(String(doc.Statement.find((s) => s.Sid === sid)!.Resource)).toContain("photos");
    }
  });
});
