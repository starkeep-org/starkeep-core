/**
 * The cloud's per-channel bytes-watermark store, against a recording client.
 *
 * What matters is where it reads and writes — the channel's own schema, never
 * `shared` — that values survive the round trip as HLCs, and that a missing
 * table fails loudly rather than reading as "nothing held".
 */

import { describe, expect, it } from "vitest";
import { serializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import { createDsqlByteCoverageStore } from "../src/byte-coverage.js";
import type { DatabaseClient } from "../src/types.js";

function recordingClient(answer: (text: string) => Record<string, unknown>[] | Error) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client: DatabaseClient = {
    async query(text, values) {
      calls.push({ text, values: values ?? [] });
      const result = answer(text);
      if (result instanceof Error) throw result;
      return { rows: result };
    },
    async end() {},
  };
  return { client, calls };
}

const hlc = (nodeId: string, wallTime: number): HLCTimestamp => ({ wallTime, counter: 0, nodeId });

describe("createDsqlByteCoverageStore", () => {
  it("reads the channel's table in the channel's own schema", async () => {
    const { client, calls } = recordingClient(() => [
      { node_id: "phone", hlc: serializeHLC(hlc("phone", 1_700_000_000_000)) },
    ]);
    const loaded = await createDsqlByteCoverageStore(client, "starkeep-drive", "user-a").load();

    expect(calls[0]!.text).toContain('from "app_starkeep_drive"."_starkeep_byte_coverage"');
    expect(loaded).toEqual({ phone: hlc("phone", 1_700_000_000_000) });
  });

  it("upserts every entry, so a lowered value replaces a higher one, then drops absent authors", async () => {
    const { client, calls } = recordingClient(() => []);
    await createDsqlByteCoverageStore(client, "photos", "user-a").save({
      a: hlc("a", 5),
      b: hlc("b", 7),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toContain('insert into "app_photos"."_starkeep_byte_coverage"');
    // An author the map omits has no rows left, so its stored value goes.
    expect(calls[1]!.text).toBe(
      'delete from "app_photos"."_starkeep_byte_coverage" where "node_id" not in ($1, $2) and "app_photos"."_starkeep_byte_coverage"."user_id" = $3',
    );
    expect(calls[1]!.values).toEqual(["a", "b", "user-a"]);
    expect(calls[0]!.text).toContain(
      'on conflict ("user_id", "node_id") do update set "hlc" = "excluded"."hlc"',
    );
    expect(calls[0]!.values).toEqual([
      "a",
      serializeHLC(hlc("a", 5)),
      "user-a",
      "b",
      serializeHLC(hlc("b", 7)),
      "user-a",
    ]);
  });

  it("clears the user's rows for an empty map, and only theirs", async () => {
    const { client, calls } = recordingClient(() => []);
    await createDsqlByteCoverageStore(client, "photos", "user-a").save({});
    expect(calls.map((c) => c.text)).toEqual([
      'delete from "app_photos"."_starkeep_byte_coverage" where "app_photos"."_starkeep_byte_coverage"."user_id" = $1',
    ]);
  });

  it("lets a missing table throw, so the responder omits its watermark", async () => {
    const { client } = recordingClient(() =>
      Object.assign(new Error('relation "app_photos._starkeep_byte_coverage" does not exist'), {
        code: "42P01",
      }),
    );
    await expect(createDsqlByteCoverageStore(client, "photos", "user-a").load()).rejects.toThrow(
      /does not exist/,
    );
  });
});
