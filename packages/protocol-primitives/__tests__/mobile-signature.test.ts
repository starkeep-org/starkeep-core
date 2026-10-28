/**
 * How a mobile app signs a data-plane request. The broker verifies exactly
 * this message, so a drift here is every phone refused.
 */
import { describe, expect, it } from "vitest";
import {
  MOBILE_KEY_ID_HEADER,
  MOBILE_KEY_SIG_HEADER,
  MOBILE_TS_HEADER,
  NoAttestedKeyError,
  mobileSignedMessage,
  withMobileKeySignature,
} from "../src/index.js";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const CHANNEL = "https://d1.cloudfront.net/apps/starkeep-drive";

function recordingFetch() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response("{}");
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("mobileSignedMessage", () => {
  it("signs the app, method, decoded path, time and body, as the app HMAC does", () => {
    const message = mobileSignedMessage(
      "starkeep-drive",
      "post",
      "/files/shared%2Fa?x=1",
      1700,
      new TextEncoder().encode('{"a":1}'),
    );
    expect(decode(message)).toBe('starkeep-drive:POST:/files/shared/a:1700:{"a":1}');
  });

  it("signs an empty body for GET and HEAD", () => {
    const body = new TextEncoder().encode("ignored");
    expect(decode(mobileSignedMessage("d", "GET", "/x", 1, body))).toBe("d:GET:/x:1:");
    expect(decode(mobileSignedMessage("d", "HEAD", "/x", 1, body))).toBe("d:HEAD:/x:1:");
  });
});

describe("withMobileKeySignature", () => {
  const signed: Uint8Array[] = [];
  const signer = {
    keyId: async () => "k".repeat(64),
    sign: async (message: Uint8Array) => {
      signed.push(message);
      return "c2ln";
    },
    now: () => 42,
  };

  it("signs a data-plane request with the path below the channel", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await withMobileKeySignature(
      fetchImpl,
      CHANNEL,
      signer,
    )(`${CHANNEL}/sync/exchange?x=1`, {
      method: "POST",
      body: "{}",
    });
    expect(decode(signed.at(-1)!)).toBe("starkeep-drive:POST:/sync/exchange:42:{}");
    expect(calls[0]!.headers.get(MOBILE_KEY_ID_HEADER)).toBe("k".repeat(64));
    expect(calls[0]!.headers.get(MOBILE_KEY_SIG_HEADER)).toBe("c2ln");
    expect(calls[0]!.headers.get(MOBILE_TS_HEADER)).toBe("42");
  });

  it("keeps the caller's own headers", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await withMobileKeySignature(
      fetchImpl,
      CHANNEL,
      signer,
    )(`${CHANNEL}/health`, {
      headers: { "X-Starkeep-User-Token": "t" },
    });
    expect(calls[0]!.headers.get("X-Starkeep-User-Token")).toBe("t");
  });

  it("never signs a presigned S3 or CloudFront URL, nor a lookalike channel", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const wrapped = withMobileKeySignature(fetchImpl, CHANNEL, signer);
    await wrapped("https://bucket.s3.amazonaws.com/shared/a?X-Amz-Signature=x");
    await wrapped("https://d1.cloudfront.net/shared/a?Signature=x");
    await wrapped(`${CHANNEL}-evil/sync/exchange`);
    for (const call of calls) expect(call.headers.get(MOBILE_KEY_SIG_HEADER)).toBeNull();
  });

  it("refuses to send a data-plane request with no registered key", async () => {
    const { fetchImpl } = recordingFetch();
    const wrapped = withMobileKeySignature(fetchImpl, CHANNEL, {
      ...signer,
      keyId: async () => null,
    });
    await expect(
      wrapped(`${CHANNEL}/sync/exchange`, { method: "POST", body: "{}" }),
    ).rejects.toThrow(NoAttestedKeyError);
  });
});
