/**
 * `listRetainedAppData` on the cloud registry, and the redeploy message an
 * operator sees when the cluster predates `shared.retained_app_data`.
 *
 * A cloud uninstall calls it before it changes anything, so the error it
 * throws on a missing table is what stops an uninstall that could not record
 * the data it keeps. The pg Pool and the DSQL signer are module-mocked; the
 * registry's own query composition and error mapping are real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = {
  /** True for a cluster whose shared schema predates the kept-data table. */
  tableMissing: false,
  rows: [] as Record<string, unknown>[],
  statements: [] as string[],
};

vi.mock("@aws-sdk/dsql-signer", () => ({
  DsqlSigner: class {
    async getDbConnectAuthToken() {
      return "fake-token";
    }
  },
}));

vi.mock("pg", () => {
  function handleQuery(text: string) {
    state.statements.push(text);
    if (text.includes('"shared"."retained_app_data"') && state.tableMissing) {
      throw Object.assign(new Error('relation "shared.retained_app_data" does not exist'), {
        code: "42P01",
      });
    }
    return { rows: state.rows, rowCount: state.rows.length };
  }
  class FakePool {
    async query(text: string) {
      return handleQuery(text);
    }
    async connect() {
      return { query: async (text: string) => handleQuery(text), release() {} };
    }
    async end() {}
    on() {
      return this;
    }
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

import { RetainedDataTableMissingError, createDsqlRegistry } from "../src/registry";

function registry() {
  return createDsqlRegistry({
    hostname: "fake.dsql.us-east-1.on.aws",
    region: "us-east-1",
    stackPrefix: "starkeep",
    credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
  });
}

beforeEach(() => {
  state.tableMissing = false;
  state.rows = [];
  state.statements = [];
});

describe("listRetainedAppData", () => {
  it("lists the kept data, oldest first", async () => {
    state.rows = [{ app_id: "notes", name: "Notes", retained_at: "2026-11-17T10:00:00Z" }];
    await expect(registry().listRetainedAppData()).resolves.toEqual([
      { appId: "notes", name: "Notes", retainedAt: "2026-11-17T10:00:00Z" },
    ]);
    expect(state.statements.at(-1)).toContain('order by "retained_at" asc');
  });

  it("names the redeploy when the cluster has no kept-data table", async () => {
    state.tableMissing = true;
    const err = await registry()
      .listRetainedAppData()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetainedDataTableMissingError);
    expect((err as Error).message).toContain("cli:install-cloud-data-server");
    // Not retried: a missing table does not appear on a second attempt.
    expect(state.statements).toHaveLength(1);
  });
});
