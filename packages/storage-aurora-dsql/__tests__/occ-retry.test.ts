import { describe, it, expect } from "vitest";
import { isRetryableDsqlConflict, withOccRetry } from "../src/occ-retry.js";

const noSleep = async () => {};

function occError(over: { code?: string; message?: string } = {}) {
  return Object.assign(new Error(over.message ?? "conflict"), over);
}

describe("isRetryableDsqlConflict", () => {
  it("matches the OC* SQLSTATE family", () => {
    expect(isRetryableDsqlConflict(occError({ code: "OC000" }))).toBe(true);
    expect(isRetryableDsqlConflict(occError({ code: "OC001" }))).toBe(true);
  });

  it("matches conflict messages when no code is present", () => {
    expect(
      isRetryableDsqlConflict(
        occError({ message: "change conflicts with another transaction" }),
      ),
    ).toBe(true);
    expect(
      isRetryableDsqlConflict(
        occError({ message: "schema has been updated by another transaction" }),
      ),
    ).toBe(true);
  });

  it("does not match non-OCC errors", () => {
    expect(isRetryableDsqlConflict(occError({ code: "23505" }))).toBe(false); // unique violation
    expect(isRetryableDsqlConflict(occError({ code: "28000" }))).toBe(false); // auth
    expect(isRetryableDsqlConflict(new Error("boom"))).toBe(false);
    expect(isRetryableDsqlConflict(null)).toBe(false);
  });
});

describe("withOccRetry", () => {
  it("returns immediately on success without retrying", async () => {
    let calls = 0;
    const result = await withOccRetry("t", async () => {
      calls++;
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it("retries past OCC conflicts then succeeds", async () => {
    let calls = 0;
    const result = await withOccRetry(
      "t",
      async () => {
        calls++;
        if (calls < 3) throw occError({ code: "OC001" });
        return "ok";
      },
      { sleep: noSleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after maxAttempts, rethrowing the last conflict", async () => {
    let calls = 0;
    await expect(
      withOccRetry(
        "t",
        async () => {
          calls++;
          throw occError({ code: "OC000", message: "still conflicting" });
        },
        { sleep: noSleep, maxAttempts: 4 },
      ),
    ).rejects.toThrow("still conflicting");
    expect(calls).toBe(4);
  });

  it("is re-entrant: a nested call defers retrying to the outer loop, which re-reads", async () => {
    // Simulate a read-modify-write unit: the outer wraps read+write; the write
    // is a self-retrying (nested) withOccRetry. The write conflicts once; the
    // inner call must NOT swallow it — the outer must re-run the whole unit so
    // the read happens again.
    let reads = 0;
    let writeAttempts = 0;
    const result = await withOccRetry(
      "unit",
      async () => {
        const readValue = ++reads; // re-read on every outer attempt
        return withOccRetry(
          "write",
          async () => {
            writeAttempts++;
            if (writeAttempts === 1) throw occError({ code: "OC001" });
            return readValue;
          },
          { sleep: noSleep },
        );
      },
      { sleep: noSleep },
    );
    expect(reads).toBe(2); // outer unit re-ran, so the read happened twice
    expect(writeAttempts).toBe(2);
    expect(result).toBe(2); // value from the second (fresh) read
  });

  it("does not retry a non-OCC error — it propagates on the first attempt", async () => {
    let calls = 0;
    await expect(
      withOccRetry(
        "t",
        async () => {
          calls++;
          throw occError({ code: "23505", message: "unique violation" });
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow("unique violation");
    expect(calls).toBe(1);
  });
});
