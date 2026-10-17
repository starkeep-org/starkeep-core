/**
 * @vitest-environment jsdom
 *
 * "This machine": joining a cloud, the pairing code, and "Connect this machine".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/operator-session", () => ({
  operatorSession: async () => ({
    credentials: { accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: "t", expiration: "x" },
    stackPrefix: "sktest",
    region: "us-east-2",
    userSub: "sub-admin",
  }),
}));

const { ThisMachineSection } = await import("../src/components/ThisMachineSection");

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let machine: Record<string, unknown>;

const NO_KEY = {
  deviceId: null,
  publicKeySpki: null,
  fingerprint: null,
  pairingCode: null,
  label: null,
  approval: { state: "no-key" },
  cloudUrl: "https://d1.cloudfront.net",
};

const KEYED = {
  ...NO_KEY,
  deviceId: "dev_laptop",
  publicKeySpki: "M".repeat(59) + "=",
  fingerprint: "ab12 cd34",
  pairingCode: "CODE123",
  label: "Laptop",
  approval: { state: "pending" },
};

beforeEach(() => {
  calls = [];
  machine = NO_KEY;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      calls.push(call);
      if (url === "/api/this-machine/key") {
        machine = { ...KEYED, label: (call.body?.label as string) ?? null };
        return Response.json(machine);
      }
      if (url === "/api/devices") {
        machine = { ...machine, approval: { state: "approved", userId: "sub-admin", label: machine.label } };
        return Response.json({ paired: {} });
      }
      if (url.startsWith("/api/this-machine")) return Response.json(machine);
      return Response.json({ error: `unexpected ${url}` }, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a machine with no key", () => {
  it("shows a pairing code and its fingerprint, and keeps asking the cloud", async () => {
    const user = userEvent.setup();
    render(<ThisMachineSection canConnect={false} />);
    await user.type(await screen.findByLabelText("Machine name"), "Laptop");
    expect(screen.queryByRole("button", { name: "Connect this machine" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show a pairing code" }));

    expect(((await screen.findByLabelText("Pairing code")) as HTMLTextAreaElement).value).toBe("CODE123");
    expect(screen.getByText("ab12 cd34")).toBeTruthy();
    expect(screen.getByText(/Waiting for an admin/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/this-machine/key")!.body).toEqual({ label: "Laptop" });
  });

  it("connects in one action for a signed-in admin, sending only the public half", async () => {
    const user = userEvent.setup();
    render(<ThisMachineSection canConnect />);
    await user.click(await screen.findByRole("button", { name: "Connect this machine" }));
    expect(await screen.findByText(/This machine syncs with https:\/\/d1.cloudfront.net/)).toBeTruthy();
    const registered = calls.find((c) => c.url === "/api/devices")!;
    expect(registered.body).toMatchObject({
      deviceId: "dev_laptop",
      publicKeySpki: KEYED.publicKeySpki,
      kind: "desktop",
      userId: "sub-admin",
      stackPrefix: "sktest",
    });
  });
});

describe("a machine with no cloud", () => {
  it("joins a cloud by its address", async () => {
    machine = { ...NO_KEY, cloudUrl: null };
    const user = userEvent.setup();
    render(<ThisMachineSection canConnect={false} />);
    await user.type(await screen.findByLabelText("Cloud address"), "https://d1.cloudfront.net");
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByText(/Restarting the local data server/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/this-machine/cloud")!.body).toEqual({ url: "https://d1.cloudfront.net" });
  });
});
