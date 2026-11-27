/**
 * @vitest-environment jsdom
 *
 * "This machine": joining a cloud, signing in to sync on the managed login
 * page, and signing out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { ThisMachineSection } = await import("../src/components/ThisMachineSection");

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let machine: Record<string, unknown>;
/** Whether this admin-web can receive the sign-in page's redirect. */
let browserSignIn: { available: boolean; reason?: string };

const SIGNED_OUT = { cloudUrl: "https://d1.cloudfront.net", state: "signed-out", email: null };
const SIGNED_IN = {
  cloudUrl: "https://d1.cloudfront.net",
  state: "signed-in",
  email: "sam@example.com",
};

beforeEach(() => {
  calls = [];
  machine = SIGNED_OUT;
  browserSignIn = { available: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      calls.push(call);
      if (url === "/api/admin-session") {
        return Response.json({
          signedIn: false,
          email: null,
          sub: null,
          expiresAt: null,
          browserSignIn,
        });
      }
      if (url === "/api/this-machine/sign-out") {
        machine = SIGNED_OUT;
        return Response.json({ ok: true, revocation: "revoked" });
      }
      if (url === "/api/this-machine/cloud") return Response.json({ ok: true });
      if (url === "/api/this-machine") return Response.json(machine);
      return Response.json({ error: `unexpected ${url}` }, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a signed-out machine", () => {
  it("sends the person to the managed login page to sign in, and asks for no password", async () => {
    render(<ThisMachineSection />);
    const link = (await screen.findByRole("link", {
      name: "Sign in to sync",
    })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toMatch(/^\/auth\/start\?client=device&returnTo=/);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(calls.some((c) => c.url.includes("sign-in"))).toBe(false);
  });

  it("says why when this admin-web cannot receive the sign-in page's redirect", async () => {
    browserSignIn = {
      available: false,
      reason: "Browser sign-in returns to admin-web on port 3000. Sign in with `starkeep login`.",
    };
    render(<ThisMachineSection />);
    expect(await screen.findByText(/starkeep login/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in to sync" })).toBeNull();
  });
});

describe("a signed-in machine", () => {
  it("signs out", async () => {
    machine = SIGNED_IN;
    const user = userEvent.setup();
    render(<ThisMachineSection />);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Sign in to sync" })).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/this-machine/sign-out" && c.method === "POST")).toBe(
      true,
    );
  });

  it("says when its library belongs to another account", async () => {
    machine = {
      ...SIGNED_IN,
      state: "bound-elsewhere",
      message: "This library belongs to another account.",
    };
    render(<ThisMachineSection />);
    expect(await screen.findByText("This library belongs to another account.")).toBeTruthy();
  });
});

describe("a machine with no cloud", () => {
  it("addresses the owner's second computer as well as someone else's cloud", async () => {
    machine = { ...SIGNED_OUT, cloudUrl: null };
    render(<ThisMachineSection />);
    expect(
      await screen.findByText(/Already deployed Starkeep Cloud from another computer/),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "This machine" })).toBeTruthy();
  });

  it("drops its heading when something beside it names it", async () => {
    machine = { ...SIGNED_OUT, cloudUrl: null };
    render(<ThisMachineSection untitled />);
    expect(await screen.findByLabelText("Cloud address")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "This machine" })).toBeNull();
  });

  it("joins a cloud by its address", async () => {
    machine = { ...SIGNED_OUT, cloudUrl: null };
    const user = userEvent.setup();
    render(<ThisMachineSection />);
    await user.type(await screen.findByLabelText("Cloud address"), "https://d1.cloudfront.net");
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByText(/Restarting the local data server/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/this-machine/cloud")!.body).toEqual({
      url: "https://d1.cloudfront.net",
    });
  });
});

describe("the administering machine", () => {
  const GATEWAY = "https://abc123.execute-api.us-east-2.amazonaws.com";

  it("names this cloud rather than the gateway it syncs through, with a sign-out link", async () => {
    machine = { ...SIGNED_IN, cloudUrl: GATEWAY };
    render(<ThisMachineSection administering />);
    expect(
      await screen.findByText(/Local apps sync with this cloud as sam@example.com/),
    ).toBeTruthy();
    expect(screen.queryByText(new RegExp(GATEWAY))).toBeNull();
    expect(screen.queryByRole("heading", { name: "This machine" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
