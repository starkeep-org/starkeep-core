import { describe, expect, it } from "vitest";
import { parseAppPath, parseObjectKey } from "../src/api-handler.js";
import type { AccessGrants } from "../src/access-enforcer.js";

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
    expect(parseObjectKey("photos", "shared/image/ab/abc123", g, "read")).toEqual({ ok: true });
    expect(parseObjectKey("photos", "shared/image/ab/abc123", g, "write")).toEqual({ ok: true });
  });

  it("403s a shared key outside the caller's grants, per mode", () => {
    const g = grants({ readableCategories: ["image"] });
    expect(parseObjectKey("photos", "shared/video/ab/abc123", g, "read")).toMatchObject({
      ok: false,
      status: 403,
    });
    // read-only image grant: write mode must still be forbidden
    expect(parseObjectKey("photos", "shared/image/ab/abc123", g, "write")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("400s malformed shared keys before authorization", () => {
    const g = grants({ readableCategories: ["image"] });
    expect(parseObjectKey("photos", "shared/image/onlyhash", g, "read")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(parseObjectKey("photos", "shared//ab/abc123", g, "read")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("all-access (Drive) passes any shared category, including other", () => {
    const g = grants({ allAccess: true });
    expect(parseObjectKey("starkeep-drive", "shared/other/ab/abc123", g, "write")).toEqual({
      ok: true,
    });
    expect(parseObjectKey("starkeep-drive", "shared/video/ab/abc123", g, "read")).toEqual({
      ok: true,
    });
  });
});

describe("parseObjectKey — apps/ namespace", () => {
  it("allows the caller's own syncable keys", () => {
    expect(
      parseObjectKey("photos", "apps/photos/syncable/files/thumb.png", grants(), "write"),
    ).toEqual({ ok: true });
  });

  it("403s another app's syncable keys, even for all-access", () => {
    expect(
      parseObjectKey("photos", "apps/notes/syncable/files/x", grants(), "read"),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      parseObjectKey("starkeep-drive", "apps/photos/syncable/files/x", grants({ allAccess: true }), "read"),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("400s app keys missing the syncable segment or a sub-key", () => {
    expect(parseObjectKey("photos", "apps/photos/private/x", grants(), "read")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(parseObjectKey("photos", "apps/photos/syncable", grants(), "read")).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("parseObjectKey — unknown namespaces", () => {
  it("400s keys outside shared/ and apps/", () => {
    expect(parseObjectKey("photos", "private/photos/x", grants({ allAccess: true }), "read")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(parseObjectKey("photos", "", grants(), "read")).toMatchObject({ ok: false, status: 400 });
  });
});
