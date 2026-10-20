/**
 * admin-web's boundary against other sites: the `Host` check and `Origin`
 * check in front of every route, and the cross-site guard on the sign-in,
 * sign-out, Join and config-write routes.
 *
 * admin-web listens on loopback, and any page open in the person's browser can
 * send it requests. A DNS-rebinding page is the case that matters most: its
 * domain resolves to 127.0.0.1, so its requests reach admin-web carrying the
 * attacker's domain in both `Origin` and `Host`.
 *
 * The rebinding cases started as `it.fails` in the 2026-10-18 test-gap review.
 * See `~/projects/starkeep/assessment-failing-tests-device-sign-in-2026-10-18.md`,
 * section "1. The loopback guard: rethink the boundary".
 */
import { afterEach, describe, expect, it } from "vitest";
import { fromOwnPage, hostAllowed, serverRefusal } from "../src/lib/same-origin";
import { POST_SIGN_IN } from "../src/routes/this-machine";

const REBIND = "rebind.attacker.example:3000";

/** A POST as the server sees it: the URL is built from the `Host` header. */
function post(host: string, origin: string | null): Request {
  return new Request(`http://${host}/api/this-machine/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }) },
    body: JSON.stringify({ email: "a@example.com", password: "pw" }),
  });
}

afterEach(() => {
  delete process.env.STARKEEP_ADMIN_DEV_ORIGINS;
});

describe("the cross-site guard", () => {
  it("passes admin-web's own page, on either loopback spelling", () => {
    expect(fromOwnPage(post("localhost:3000", "http://localhost:3000"))).toBe(true);
    expect(fromOwnPage(post("127.0.0.1:3000", "http://127.0.0.1:3000"))).toBe(true);
  });

  it("refuses another site's page, and a request with no Origin", () => {
    expect(fromOwnPage(post("localhost:3000", "https://evil.example"))).toBe(false);
    expect(fromOwnPage(post("localhost:3000", "null"))).toBe(false);
    expect(fromOwnPage(post("localhost:3000", null))).toBe(false);
  });

  it("refuses a DNS-rebinding page, whose Origin and Host both name the attacker", () => {
    expect(fromOwnPage(post(REBIND, `http://${REBIND}`))).toBe(false);
  });

  it("keeps a DNS-rebinding page from driving this machine's sign-in", async () => {
    const res = await POST_SIGN_IN(post(REBIND, `http://${REBIND}`));
    expect(res.status).toBe(403);
  });

  it("passes a LAN name the operator listed, from that name's own page", () => {
    process.env.STARKEEP_ADMIN_DEV_ORIGINS = "192.168.1.51, laptop.local";
    expect(fromOwnPage(post("192.168.1.51:3000", "http://192.168.1.51:3000"))).toBe(true);
    expect(fromOwnPage(post(REBIND, `http://${REBIND}`))).toBe(false);
  });
});

describe("hostAllowed", () => {
  it("accepts loopback names with or without a port, and refuses look-alikes", () => {
    for (const host of ["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(hostAllowed(host), host).toBe(true);
    }
    for (const host of [
      REBIND,
      "localhost.attacker.example",
      "127.0.0.1.nip.io:3000",
      "192.168.1.51:3000",
      "",
    ]) {
      expect(hostAllowed(host), host).toBe(false);
    }
  });
});

describe("the check in front of every route", () => {
  it("refuses a rebinding page's Host, on reads as well as writes", () => {
    expect(serverRefusal({ method: "GET", host: REBIND, origin: undefined })).toMatch(
      /own address/,
    );
    expect(serverRefusal({ method: "POST", host: REBIND, origin: `http://${REBIND}` })).toMatch(
      /own address/,
    );
  });

  it("refuses another site's write, and lets its read through to the browser's own rule", () => {
    expect(
      serverRefusal({ method: "POST", host: "localhost:3000", origin: "https://evil.example" }),
    ).toMatch(/own page/);
    expect(serverRefusal({ method: "DELETE", host: "localhost:3000", origin: "null" })).toMatch(
      /own page/,
    );
    expect(
      serverRefusal({ method: "GET", host: "localhost:3000", origin: "https://evil.example" }),
    ).toBeNull();
  });

  it("passes admin-web's own page, and a caller with no Origin", () => {
    expect(
      serverRefusal({ method: "POST", host: "localhost:3000", origin: "http://localhost:3000" }),
    ).toBeNull();
    expect(serverRefusal({ method: "POST", host: "127.0.0.1:3000", origin: undefined })).toBeNull();
    expect(serverRefusal({ method: "GET", host: "localhost:3000", origin: undefined })).toBeNull();
  });

  it("refuses a page on one loopback spelling writing to another", () => {
    // The browser treats the two spellings as different sites, so admin-web does too.
    expect(
      serverRefusal({ method: "POST", host: "127.0.0.1:3000", origin: "http://localhost:3000" }),
    ).toMatch(/own page/);
  });
});
