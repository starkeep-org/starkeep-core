/**
 * The cross-site guard on admin-web's sign-in, sign-out, Join and config-write
 * routes.
 *
 * admin-web listens on loopback, and any page open in the person's browser can
 * send it requests. The guard must pass admin-web's own page and refuse every
 * other site. A DNS-rebinding page is the case that matters most: its domain
 * resolves to 127.0.0.1, so its requests reach admin-web carrying the
 * attacker's domain in both `Origin` and `Host`.
 *
 * See `~/projects/starkeep/review-test-gaps-device-sign-in-multi-user-2026-10-18.md`,
 * problem 5.
 */
import { describe, expect, it } from "vitest";
import { fromOwnPage } from "../src/lib/same-origin";
import { POST_SIGN_IN } from "../src/routes/this-machine";

/** A POST as the server sees it: the URL is built from the `Host` header. */
function post(host: string, origin: string | null): Request {
  return new Request(`http://${host}/api/this-machine/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }) },
    body: JSON.stringify({ email: "a@example.com", password: "pw" }),
  });
}

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

  it.fails("refuses a DNS-rebinding page, whose Origin and Host both name the attacker", () => {
    // `fromOwnPage` compares `Origin` with an origin built from `Host`, and the
    // rebinding page controls both. Admin-web's own origin is a loopback
    // address; nothing else is.
    expect(fromOwnPage(post("rebind.attacker.example:3000", "http://rebind.attacker.example:3000"))).toBe(false);
  });

  it.fails("keeps a DNS-rebinding page from driving this machine's sign-in", async () => {
    // The same gap at the route: the request passes the guard and is forwarded
    // to the local data server, which would sign the machine in to whatever
    // account the page names.
    const res = await POST_SIGN_IN(post("rebind.attacker.example:3000", "http://rebind.attacker.example:3000"));
    expect(res.status).toBe(403);
  });
});
