import { describe, expect, it } from "vitest";
import { parseAppPath, parseObjectKey } from "../src/api-handler.js";
import type { BrokerSubject } from "../src/api-handler.js";
import type { AccessGrants } from "../src/access-enforcer.js";

/** A subject acting for user `u1`. */
function as(appId: string, userId = "u1"): BrokerSubject {
  return { appId, userId };
}

function grants(overrides: Partial<{
  readableCategories: string[];
  writableCategories: string[];
  allAccess: boolean;
}> = {}): AccessGrants {
  return {
    readableTypes: new Set(),
    writableTypes: new Set(),
    readableCategories: new Set(overrides.readableCategories ?? []),
    writableCategories: new Set(overrides.writableCategories ?? []),
    writableMetadataCategories: new Set(),
    allAccess: overrides.allAccess ?? false,
  };
}

describe("parseAppPath", () => {
  it("parses a bare app prefix with implicit root subPath", () => {
    expect(parseAppPath("/apps/photos")).toEqual({ appId: "photos", subPath: "/" });
  });

  it("parses nested subPaths", () => {
    expect(parseAppPath("/apps/photos/data/records/abc")).toEqual({
      appId: "photos",
      subPath: "/data/records/abc",
    });
  });

  it("accepts ids with dots, dashes, and underscores", () => {
    expect(parseAppPath("/apps/my-app.v2_x/health")).toEqual({
      appId: "my-app.v2_x",
      subPath: "/health",
    });
  });

  it("rejects uppercase app ids", () => {
    expect(parseAppPath("/apps/Photos/health")).toBeNull();
  });

  it("rejects ids starting with a separator and non-/apps paths", () => {
    expect(parseAppPath("/apps/-photos")).toBeNull();
    expect(parseAppPath("/apps/")).toBeNull();
    expect(parseAppPath("/health")).toBeNull();
    expect(parseAppPath("/other/photos")).toBeNull();
  });
});

describe("parseObjectKey — shared/ namespace", () => {
  it("allows a shared key whose category the caller can read/write", () => {
    const g = grants({ readableCategories: ["image"], writableCategories: ["image"] });
    expect(parseObjectKey(as("photos"), "shared/u1/image/ab/abc123", g, "read")).toEqual({ ok: true });
    expect(parseObjectKey(as("photos"), "shared/u1/image/ab/abc123", g, "write")).toEqual({ ok: true });
  });

  it("403s a shared key outside the caller's grants, per mode", () => {
    const g = grants({ readableCategories: ["image"] });
    expect(parseObjectKey(as("photos"), "shared/u1/video/ab/abc123", g, "read")).toMatchObject({
      ok: false,
      status: 403,
    });
    // read-only image grant: write mode must still be forbidden
    expect(parseObjectKey(as("photos"), "shared/u1/image/ab/abc123", g, "write")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("400s malformed shared keys before authorization", () => {
    const g = grants({ readableCategories: ["image"] });
    expect(parseObjectKey(as("photos"), "shared/u1/image/onlyhash", g, "read")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(parseObjectKey(as("photos"), "shared/u1//ab/abc123", g, "read")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("all-access (Drive) passes any shared category, including other", () => {
    const g = grants({ allAccess: true });
    expect(parseObjectKey(as("starkeep-drive"), "shared/u1/other/ab/abc123", g, "write")).toEqual({
      ok: true,
    });
    expect(parseObjectKey(as("starkeep-drive"), "shared/u1/video/ab/abc123", g, "read")).toEqual({
      ok: true,
    });
  });
});

describe("parseObjectKey — apps/ namespace", () => {
  it("allows the caller's own syncable keys", () => {
    expect(
      parseObjectKey(as("photos"), "apps/photos/u1/syncable/files/thumb.png", grants(), "write"),
    ).toEqual({ ok: true });
  });

  it("403s another app's syncable keys, even for all-access", () => {
    expect(
      parseObjectKey(as("photos"), "apps/notes/u1/syncable/files/x", grants(), "read"),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      parseObjectKey(as("starkeep-drive"), "apps/photos/u1/syncable/files/x", grants({ allAccess: true }), "read"),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("400s app keys missing the syncable segment or a sub-key", () => {
    expect(parseObjectKey(as("photos"), "apps/photos/u1/private/x", grants(), "read")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(parseObjectKey(as("photos"), "apps/photos/u1/syncable", grants(), "read")).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("parseObjectKey — the user segment", () => {
  it("403s another user's shared key, even for all-access", () => {
    const g = grants({ allAccess: true });
    expect(parseObjectKey(as("starkeep-drive"), "shared/u2/image/ab/abc123", g, "read")).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(parseObjectKey(as("starkeep-drive", "u2"), "shared/u2/image/ab/abc123", g, "read")).toEqual({
      ok: true,
    });
  });

  it("403s another user's syncable key of the caller's own app", () => {
    expect(
      parseObjectKey(as("photos"), "apps/photos/u2/syncable/files/x", grants(), "read"),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("400s the old layout, which names no user", () => {
    const g = grants({ allAccess: true });
    expect(parseObjectKey(as("starkeep-drive"), "shared/image/ab/abc123", g, "read")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      parseObjectKey(as("photos"), "apps/photos/syncable/files/x", grants(), "read"),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("400s a user segment outside the safe alphabet", () => {
    expect(
      parseObjectKey(as("photos"), "apps/photos/u.1/syncable/files/x", grants(), "read"),
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe("parseObjectKey — unknown namespaces", () => {
  it("400s keys outside shared/ and apps/", () => {
    expect(parseObjectKey(as("photos"), "private/photos/x", grants({ allAccess: true }), "read")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(parseObjectKey(as("photos"), "", grants(), "read")).toMatchObject({ ok: false, status: 400 });
  });
});
