import { describe, it, expect } from "vitest";
import {
  assertNotReservedAppId,
  assertCloudInstallableAppId,
  buildAppRoleTrustPolicy,
  RESERVED_APP_IDS,
} from "../src/iam";

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

describe("app role trust policy", () => {
  it("trusts lambda, Manager, and the cloud-data-server broker for ordinary apps", () => {
    const doc = JSON.parse(buildAppRoleTrustPolicy("starkeep", "111122223333", true));
    const principals = doc.Statement.map(
      (s: { Principal: Record<string, string> }) => s.Principal.Service ?? s.Principal.AWS,
    );
    expect(principals).toEqual([
      "lambda.amazonaws.com",
      "arn:aws:iam::111122223333:role/starkeep-manager-role",
      "arn:aws:iam::111122223333:role/starkeep-app-cloud-data-server-role",
    ]);
    for (const s of doc.Statement) expect(s.Effect).toBe("Allow");
  });

  it("omits the broker principal when minting the broker's own role", () => {
    const doc = JSON.parse(buildAppRoleTrustPolicy("starkeep", "111122223333", false));
    expect(doc.Statement).toHaveLength(2);
    const aws = doc.Statement.map(
      (s: { Principal: Record<string, string> }) => s.Principal.AWS,
    ).filter(Boolean);
    expect(aws).toEqual(["arn:aws:iam::111122223333:role/starkeep-manager-role"]);
  });
});
