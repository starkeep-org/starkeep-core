/**
 * The entry helper's contract: it resolves an upstream that has already
 * started, and it fails loudly at INIT when the module exports nothing usable.
 *
 * The invariant it exists for — that the graph loads during INIT — is enforced
 * by the *type* of `upstream` rather than by anything runnable: a promise
 * handed to a top-level `await` has already started. What is left to test is
 * that the helper does not undo that, and that a missing export names itself.
 */
import { describe, expect, it } from "vitest";
import { createLambdaEntry } from "../src/lambda.js";

describe("createLambdaEntry", () => {
  it("returns the upstream handler", async () => {
    const upstreamHandler = async (event: { n: number }) => ({ n: event.n + 1 });
    const handler = await createLambdaEntry({ upstream: Promise.resolve({ handler: upstreamHandler }) });
    await expect(handler({ n: 1 })).resolves.toEqual({ n: 2 });
  });

  it("does not defer the import: the module has settled before the handler exists", async () => {
    let settled = false;
    const upstream = Promise.resolve({ handler: () => undefined }).then((m) => {
      settled = true;
      return m;
    });
    await createLambdaEntry({ upstream });
    expect(settled).toBe(true);
  });

  it("names the upstream when it exports no handler", async () => {
    await expect(
      createLambdaEntry({
        upstream: Promise.resolve({}) as Promise<{ handler: () => void }>,
        label: "./app/index.mjs",
      }),
    ).rejects.toThrow(/\.\/app\/index\.mjs does not export a `handler` function \(got undefined\)/);
  });

  it("rejects a handler export that is not callable", async () => {
    await expect(
      createLambdaEntry({
        upstream: Promise.resolve({ handler: "nope" }) as unknown as Promise<{
          handler: () => void;
        }>,
      }),
    ).rejects.toThrow(/got string/);
  });

  it("propagates an import that failed, so INIT fails rather than the first request", async () => {
    await expect(
      createLambdaEntry({ upstream: Promise.reject(new Error("ERR_MODULE_NOT_FOUND")) }),
    ).rejects.toThrow("ERR_MODULE_NOT_FOUND");
  });
});
