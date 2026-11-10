/**
 * The default sign-in page: what every cloud app must answer at `/sign-in`,
 * because CloudFront's signed-out redirect sends signed-out navigations there.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createSignInPage } from "../src/auth/index.js";

afterEach(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
});

describe("createSignInPage", () => {
  it("starts the platform's sign-in for this app and returns to the app root", async () => {
    const res = createSignInPage({ appId: "dice", appName: "Dice" })();
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('<form method="get" action="/auth/start">');
    expect(html).toContain('<input type="hidden" name="app" value="dice">');
    expect(html).toContain('<input type="hidden" name="return" value="/apps/dice/">');
    expect(html).toContain("<h1>Dice</h1>");
  });

  it("restores a live session first in the cloud", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    const html = await createSignInPage({ appId: "dice" })().text();
    expect(html).toContain('fetch("/apps/dice/api/session/refresh"');
    expect(html).toContain('location.replace("/apps/dice/")');
  });

  it("leaves the restore script out on the local surface", async () => {
    const html = await createSignInPage({ appId: "dice" })().text();
    expect(html).not.toContain("<script>");
  });

  it("escapes the name it shows", async () => {
    const html = await createSignInPage({ appId: "dice", appName: '<b>"Dice"</b>' })().text();
    expect(html).toContain("<h1>&lt;b&gt;&quot;Dice&quot;&lt;/b&gt;</h1>");
  });
});
