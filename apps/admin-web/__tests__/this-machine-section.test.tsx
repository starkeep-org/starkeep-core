/**
 * @vitest-environment jsdom
 *
 * "This machine": joining a cloud, signing in to sync — including the first
 * sign-in's new password — and signing out.
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
/** What the sign-in route answers next. */
let signInAnswer: () => Response;

const SIGNED_OUT = { cloudUrl: "https://d1.cloudfront.net", state: "signed-out", email: null };
const SIGNED_IN = { cloudUrl: "https://d1.cloudfront.net", state: "signed-in", email: "sam@example.com" };

beforeEach(() => {
  calls = [];
  machine = SIGNED_OUT;
  signInAnswer = () => {
    machine = SIGNED_IN;
    return Response.json({ ok: true, email: "sam@example.com" });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      calls.push(call);
      if (url === "/api/this-machine/sign-in") return signInAnswer();
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
  it("signs in to sync with an email and password", async () => {
    const user = userEvent.setup();
    render(<ThisMachineSection />);
    await user.type(await screen.findByLabelText("Email"), "sam@example.com");
    await user.type(screen.getByLabelText("Password"), "Sam-password-1");
    await user.click(screen.getByRole("button", { name: "Sign in to sync" }));

    expect(await screen.findByText(/This machine syncs with https:\/\/d1.cloudfront.net as sam@example.com/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/this-machine/sign-in")!.body).toEqual({
      email: "sam@example.com",
      password: "Sam-password-1",
    });
  });

  it("asks for a new password at an account's first sign-in, and sends it with the temporary one", async () => {
    let first = true;
    signInAnswer = () => {
      if (first) {
        first = false;
        return Response.json({ challenge: "NEW_PASSWORD_REQUIRED" });
      }
      machine = SIGNED_IN;
      return Response.json({ ok: true });
    };
    const user = userEvent.setup();
    render(<ThisMachineSection />);
    await user.type(await screen.findByLabelText("Email"), "sam@example.com");
    await user.type(screen.getByLabelText("Password"), "Temp-1");
    await user.click(screen.getByRole("button", { name: "Sign in to sync" }));

    await user.type(await screen.findByLabelText("New password"), "Chosen-password-2");
    await user.type(screen.getByLabelText("Confirm new password"), "Chosen-password-2");
    await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

    expect(await screen.findByText(/This machine syncs with/)).toBeTruthy();
    const sent = calls.filter((c) => c.url === "/api/this-machine/sign-in").map((c) => c.body);
    expect(sent).toEqual([
      { email: "sam@example.com", password: "Temp-1" },
      { email: "sam@example.com", password: "Temp-1", newPassword: "Chosen-password-2" },
    ]);
  });

  it("does not send new passwords that differ", async () => {
    signInAnswer = () => Response.json({ challenge: "NEW_PASSWORD_REQUIRED" });
    const user = userEvent.setup();
    render(<ThisMachineSection />);
    await user.type(await screen.findByLabelText("Email"), "sam@example.com");
    await user.type(screen.getByLabelText("Password"), "Temp-1");
    await user.click(screen.getByRole("button", { name: "Sign in to sync" }));
    await user.type(await screen.findByLabelText("New password"), "Chosen-password-2");
    await user.type(screen.getByLabelText("Confirm new password"), "Chosen-password-3");
    await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

    expect(await screen.findByText("The two new passwords do not match.")).toBeTruthy();
    expect(calls.filter((c) => c.url === "/api/this-machine/sign-in")).toHaveLength(1);
  });

  it("says why a sign-in failed", async () => {
    signInAnswer = () => Response.json({ error: "Incorrect username or password." }, { status: 401 });
    const user = userEvent.setup();
    render(<ThisMachineSection />);
    await user.type(await screen.findByLabelText("Email"), "sam@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in to sync" }));
    expect(await screen.findByText("Incorrect username or password.")).toBeTruthy();
  });
});

describe("a signed-in machine", () => {
  it("signs out", async () => {
    machine = SIGNED_IN;
    const user = userEvent.setup();
    render(<ThisMachineSection />);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in to sync" })).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/this-machine/sign-out" && c.method === "POST")).toBe(true);
  });

  it("says when its library belongs to another account", async () => {
    machine = { ...SIGNED_IN, state: "bound-elsewhere", message: "This library belongs to another account." };
    render(<ThisMachineSection />);
    expect(await screen.findByText("This library belongs to another account.")).toBeTruthy();
  });
});

describe("a machine with no cloud", () => {
  it("joins a cloud by its address", async () => {
    machine = { ...SIGNED_OUT, cloudUrl: null };
    const user = userEvent.setup();
    render(<ThisMachineSection />);
    await user.type(await screen.findByLabelText("Cloud address"), "https://d1.cloudfront.net");
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByText(/Restarting the local data server/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/this-machine/cloud")!.body).toEqual({ url: "https://d1.cloudfront.net" });
  });
});

describe("the address other devices sign in with", () => {
  const GATEWAY = "https://abc123.execute-api.us-east-2.amazonaws.com";

  it("names the cloud's public address on the administering machine, not the gateway it syncs through", async () => {
    machine = { ...SIGNED_IN, cloudUrl: GATEWAY };
    render(<ThisMachineSection deviceAddress="https://d1.cloudfront.net" />);
    expect(await screen.findByText(/This machine syncs with this cloud as sam@example.com/)).toBeTruthy();
    expect(screen.getByText("https://d1.cloudfront.net")).toBeTruthy();
    expect(screen.queryByText(new RegExp(GATEWAY))).toBeNull();
  });

  it("copies the address", async () => {
    machine = SIGNED_IN;
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<ThisMachineSection deviceAddress="https://d1.cloudfront.net" />);
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("https://d1.cloudfront.net");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("is not offered by a machine that joined someone else's cloud", async () => {
    machine = SIGNED_IN;
    render(<ThisMachineSection />);
    expect(await screen.findByText(/This machine syncs with https:\/\/d1.cloudfront.net/)).toBeTruthy();
    expect(screen.queryByLabelText("Address for other devices")).toBeNull();
  });
});
