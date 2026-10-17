import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_STAND_IN_STANDARDS as STD } from "@starkeep/protocol-primitives";
import type { RawDatabase } from "@starkeep/storage-adapter";
import { createLibrarySettings, type DeploymentSettingsCache } from "../src/library-settings.js";
import { createSqliteDeploymentSettingsCache } from "../src/deployment-settings-cache-sqlite.js";

/** A source that answers what the test says, counting reads. */
function source(answer: () => unknown) {
  let reads = 0;
  return {
    read: async () => {
      reads += 1;
      return answer();
    },
    reads: () => reads,
  };
}

const failing = () => {
  throw new Error("cloud unreachable");
};

function memoryCache(initial?: unknown): DeploymentSettingsCache & { saved: unknown[] } {
  const saved: unknown[] = [];
  let current: { document: unknown } | undefined = initial === undefined ? undefined : { document: initial };
  return {
    saved,
    load: () => current,
    save: (document) => {
      saved.push(document);
      current = { document };
    },
  };
}

describe("createLibrarySettings", () => {
  it("knows the defaults are the value when no document is set", async () => {
    const settings = createLibrarySettings({ read: async () => null, cloudConfigured: () => true });
    await settings.refresh();
    expect(settings.knowsLibraryValue()).toBe(true);
    expect(settings.standards()).toEqual(STD);
    expect(settings.status()).toMatchObject({ set: false, settings: null, problems: [] });
  });

  it("reads a document and knows its value", async () => {
    const settings = createLibrarySettings({
      read: async () => ({ standIns: { image: { canonicalThreshold: 6000 } } }),
      cloudConfigured: () => true,
    });
    await settings.refresh();
    expect(settings.knowsLibraryValue()).toBe(true);
    expect(settings.standards().image.canonicalThreshold).toBe(6000);
    expect(settings.status().set).toBe(true);
  });

  it("is in the dark with a cloud until a read succeeds", async () => {
    const settings = createLibrarySettings({ read: async () => failing(), cloudConfigured: () => true });
    expect(settings.knowsLibraryValue()).toBe(false);
    await settings.refresh();
    expect(settings.knowsLibraryValue()).toBe(false);
    expect(settings.status().problems.join("\n")).toMatch(/cloud unreachable/);
  });

  it("knows the defaults without a cloud, read or not", () => {
    const settings = createLibrarySettings({ read: async () => failing(), cloudConfigured: () => false });
    expect(settings.knowsLibraryValue()).toBe(true);
    expect(settings.standards()).toEqual(STD);
  });

  it("keeps the last good value through a failed read", async () => {
    let fail = false;
    const settings = createLibrarySettings({
      read: async () => (fail ? failing() : { standIns: { image: { canonicalThreshold: 6000 } } }),
      cloudConfigured: () => true,
    });
    await settings.refresh();
    fail = true;
    await settings.refresh();
    expect(settings.knowsLibraryValue()).toBe(true);
    expect(settings.standards().image.canonicalThreshold).toBe(6000);
    expect(settings.status().problems).toHaveLength(1);
  });

  it("does not take a document that fails its checks as the defaults", async () => {
    const settings = createLibrarySettings({
      read: async () => ({ standIns: { image: { canonicalThreshold: 100 } } }),
      cloudConfigured: () => true,
    });
    await settings.refresh();
    expect(settings.knowsLibraryValue()).toBe(false);
    expect(settings.status().problems.join("\n")).toMatch(/1280 to 16384/);
  });

  it("acquires the retention window through the source on every call", async () => {
    const src = source(() => ({ trash: { retentionDays: 90 } }));
    const settings = createLibrarySettings({ read: src.read, cloudConfigured: () => true });
    expect(await settings.acquireRetentionWindow()).toEqual({ known: true, days: 90 });
    expect(await settings.acquireRetentionWindow()).toEqual({ known: true, days: 90 });
    expect(src.reads()).toBe(2);
  });

  it("answers with the default window when no document is set", async () => {
    const settings = createLibrarySettings({ read: async () => null, cloudConfigured: () => true });
    expect(await settings.acquireRetentionWindow()).toEqual({ known: true, days: 30 });
  });

  it("refuses the window when the read fails, whatever it held before", async () => {
    let fail = false;
    const settings = createLibrarySettings({
      read: async () => (fail ? failing() : { trash: { retentionDays: 90 } }),
      cloudConfigured: () => false,
    });
    await settings.refresh();
    fail = true;
    const window = await settings.acquireRetentionWindow();
    expect(window.known).toBe(false);
    if (!window.known) expect(window.problems.join("\n")).toMatch(/cloud unreachable/);
  });

  it("refuses the window when the document fails its checks", async () => {
    const settings = createLibrarySettings({
      read: async () => ({ trash: { retentionDays: -1 } }),
      cloudConfigured: () => true,
    });
    expect((await settings.acquireRetentionWindow()).known).toBe(false);
  });
});

describe("the cache", () => {
  it("knows the cached value before the first read, so an offline restart can stamp", () => {
    const settings = createLibrarySettings({
      read: async () => failing(),
      cloudConfigured: () => true,
      cache: memoryCache({ standIns: { image: { canonicalThreshold: 6000 } } }),
    });
    expect(settings.knowsLibraryValue()).toBe(true);
    expect(settings.standards().image.canonicalThreshold).toBe(6000);
  });

  it("remembers that no document is set", () => {
    const settings = createLibrarySettings({
      read: async () => failing(),
      cloudConfigured: () => true,
      cache: memoryCache(null),
    });
    expect(settings.knowsLibraryValue()).toBe(true);
    expect(settings.standards()).toEqual(STD);
  });

  it("saves each good read, and nothing from a failed one", async () => {
    let fail = false;
    const cache = memoryCache();
    const settings = createLibrarySettings({
      read: async () => (fail ? failing() : { trash: { retentionDays: 7 } }),
      cloudConfigured: () => true,
      cache,
    });
    await settings.refresh();
    fail = true;
    await settings.refresh();
    expect(cache.saved).toEqual([{ trash: { retentionDays: 7 } }]);
  });

  it("never answers the retention window from the cache", async () => {
    const settings = createLibrarySettings({
      read: async () => failing(),
      cloudConfigured: () => true,
      cache: memoryCache({ trash: { retentionDays: 365 } }),
    });
    expect((await settings.acquireRetentionWindow()).known).toBe(false);
  });

  it("survives a restart in SQLite, null included", () => {
    const db = new DatabaseSync(":memory:") as unknown as RawDatabase;
    const first = createSqliteDeploymentSettingsCache({ db });
    expect(first.load()).toBeUndefined();
    first.save(null);
    expect(createSqliteDeploymentSettingsCache({ db }).load()).toEqual({ document: null });
    first.save({ trash: { retentionDays: 5 } });
    expect(createSqliteDeploymentSettingsCache({ db }).load()).toEqual({
      document: { trash: { retentionDays: 5 } },
    });
  });
});
