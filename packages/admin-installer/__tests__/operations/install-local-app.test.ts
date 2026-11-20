/** `installLocalAppOp`: consent first, then the dependency install and the registration. */
import { describe, expect, it } from "vitest";
import { installLocalAppOp } from "../../src/operations/install-local-app.js";
import { exampleApp, starkeepDirWith, testContext, withCode } from "./helpers.js";

const up = (async () => new Response("{}")) as unknown as typeof fetch;
const down = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

function setup(fetchImpl = up, result: { ok: boolean; status?: number } = { ok: true }) {
  const installs: string[] = [];
  const t = testContext(starkeepDirWith(null), {
    fetch: fetchImpl,
    runCommand: async () => 0,
    installLocalApp: (async (o: { sourceDir: string }) => {
      installs.push(o.sourceDir);
      return result.ok
        ? { ok: true, appId: "example-app", secretPath: "/creds/example-app.json" }
        : { ok: false, status: result.status ?? 500, error: "The data server refused it." };
    }) as never,
  });
  return { t, installs };
}

describe("installLocalAppOp", () => {
  it("installs an approved app and needs no cloud credentials", async () => {
    const appDir = exampleApp();
    const { t, installs } = setup();
    await expect(
      installLocalAppOp(t.ctx, { appDir, approved: true, dataServerUrl: "http://x" }, t.emit),
    ).resolves.toEqual({ appId: "example-app", secretPath: "/creds/example-app.json" });
    expect(installs).toEqual([appDir]);
    expect(t.lanes).toEqual([]);
  });

  it("reports NOT_CONFIRMED with the consent words when not approved", async () => {
    const { t, installs } = setup();
    await expect(
      installLocalAppOp(
        t.ctx,
        { appDir: exampleApp(), approved: false, dataServerUrl: "http://x" },
        t.emit,
      ),
    ).rejects.toEqual(withCode("NOT_CONFIRMED"));
    expect(t.events.find((e) => e.type === "prompt-needed")).toMatchObject({ reason: "consent" });
    expect(installs).toEqual([]);
  });

  it("reports INSTALL_FAILED when the data server is not answering", async () => {
    const { t } = setup(down);
    await expect(
      installLocalAppOp(
        t.ctx,
        { appDir: exampleApp(), approved: true, dataServerUrl: "http://x" },
        t.emit,
      ),
    ).rejects.toEqual(withCode("INSTALL_FAILED"));
  });

  it("reports MANIFEST_INVALID for a folder with no manifest", async () => {
    const { t } = setup();
    await expect(
      installLocalAppOp(t.ctx, { appDir: starkeepDirWith(null), approved: true }, t.emit),
    ).rejects.toEqual(withCode("MANIFEST_INVALID"));
  });
});
