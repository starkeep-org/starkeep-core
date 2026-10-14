/**
 * @vitest-environment jsdom
 *
 * The dashboard's paired-phones section.
 *
 * Pins what the section promises: the private half of the key reaches the QR
 * code and never the server, the code disappears on "Done", the list comes from
 * the library's settings file, and revoking asks twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DeviceKeys } from "../src/lib/device-pairing";

const generated: DeviceKeys[] = [];

vi.mock("@/lib/device-pairing", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/device-pairing")>();
  return {
    ...actual,
    generateDeviceKeys: async () => {
      const keys = await actual.generateDeviceKeys();
      generated.push(keys);
      return keys;
    },
  };
});

vi.mock("@/lib/cloud-config", () => ({
  readCloudConfig: async () => ({ cognitoConfig: {}, stackPrefix: "sktest", region: "us-east-2" }),
  readCognitoSession: async () => ({ refreshToken: "rt", userEmail: "me@example.com" }),
  writeCloudCredentials: async () => undefined,
  writeCognitoSession: async () => undefined,
}));

vi.mock("@/lib/cognito-auth", () => ({
  refreshTokens: async () => ({ idToken: "id", refreshToken: "rt2" }),
  getIdentityPoolCredentials: async () => ({
    accessKeyId: "AKIA",
    secretAccessKey: "s",
    sessionToken: "t",
    expiration: "2026-10-13T13:00:00.000Z",
  }),
}));

const { PairedDevicesSection } = await import("../src/components/PairedDevicesSection");

interface Call {
  method: string;
  body: Record<string, unknown> | null;
}

const PIXEL = {
  deviceId: "dev_pixel",
  label: "Pixel 8",
  appIds: ["starkeep-drive"],
  pairedAt: "2026-10-01T12:00:00.000Z",
};

let calls: Call[];
let devices: Array<typeof PIXEL>;
let respond: (call: Call) => { status: number; body: unknown } | undefined;

beforeEach(() => {
  calls = [];
  generated.length = 0;
  devices = [PIXEL];
  respond = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      calls.push(call);
      const override = respond(call);
      if (override) return Response.json(override.body, { status: override.status });
      if (call.method === "POST") {
        devices = [...devices, { ...PIXEL, deviceId: String(call.body!.deviceId), label: (call.body!.label as string) ?? null }];
        return Response.json({ paired: {}, baseUrl: "https://d123.cloudfront.net", devices });
      }
      if (call.method === "DELETE") {
        devices = devices.filter((d) => d.deviceId !== call.body!.deviceId);
        return Response.json({ revoked: call.body!.deviceId, devices });
      }
      return Response.json({ devices, problems: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  const user = userEvent.setup();
  render(<PairedDevicesSection />);
  await user.click(screen.getByRole("button", { name: /Paired phones/ }));
  return user;
}

describe("the list", () => {
  it("shows each paired phone by name and id", async () => {
    await open();
    const list = await screen.findByRole("list", { name: "Paired phones" });
    expect(within(list).getByText("Pixel 8")).toBeTruthy();
    expect(within(list).getByText(/dev_pixel/)).toBeTruthy();
  });

  it("says so when no phone is paired", async () => {
    devices = [];
    await open();
    expect(await screen.findByText("No phones are paired.")).toBeTruthy();
  });

  it("says the machine cannot read the list yet, rather than showing it empty", async () => {
    respond = (call) =>
      call.method === "GET" ? { status: 200, body: { devices: null, problems: ["not here yet"] } } : undefined;
    await open();
    expect(await screen.findByText(/has not received the library's settings file yet/)).toBeTruthy();
  });

  it("names the problem when the daemon is down", async () => {
    respond = (call) =>
      call.method === "GET" ? { status: 503, body: { error: "The local data server is not running." } } : undefined;
    await open();
    expect(await screen.findByText("The local data server is not running.")).toBeTruthy();
  });
});

describe("pairing", () => {
  it("sends the public half only, and shows the private half as a QR code until Done", async () => {
    const user = await open();
    await user.type(screen.getByPlaceholderText(/Name this phone/), "Tablet");
    await user.click(screen.getByRole("button", { name: "Pair a phone" }));

    const code = await screen.findByRole("img", { name: "Pairing code for Tablet" });
    expect(code.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

    const post = calls.find((c) => c.method === "POST")!;
    const [keys] = generated;
    expect(post.body).toMatchObject({
      deviceId: keys!.deviceId,
      publicKeySpki: keys!.publicKeySpki,
      label: "Tablet",
      stackPrefix: "sktest",
      userId: "me@example.com",
    });
    // The seed appears nowhere in what reaches the server.
    expect(JSON.stringify(post.body)).not.toContain(keys!.privateKeySeed);

    // The list picked up the new phone.
    const list = await screen.findByRole("list", { name: "Paired phones" });
    await waitFor(() => expect(within(list).getByText("Tablet")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Pair a phone" })).toBeTruthy();
  });

  it("sends a blank name as no label", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Pair a phone" }));
    await screen.findByRole("img", { name: "Pairing code for Unnamed device" });
    expect(calls.find((c) => c.method === "POST")!.body!.label).toBeNull();
  });

  it("shows the route's error and no code when pairing fails", async () => {
    respond = (call) =>
      call.method === "POST" ? { status: 503, body: { error: "The local data server is not running." } } : undefined;
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Pair a phone" }));
    expect(await screen.findByText("The local data server is not running.")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
  });
});

describe("revoking", () => {
  it("asks for confirmation, then revokes by id", async () => {
    const user = await open();
    const list = await screen.findByRole("list", { name: "Paired phones" });
    await user.click(within(list).getByRole("button", { name: "Revoke" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(within(list).getByRole("button", { name: "Confirm revoke" }));
    expect(await screen.findByText("Revoked Pixel 8")).toBeTruthy();
    expect(calls.find((c) => c.method === "DELETE")!.body).toMatchObject({ deviceId: "dev_pixel" });
    expect(await screen.findByText("No phones are paired.")).toBeTruthy();
  });

  it("can be cancelled", async () => {
    const user = await open();
    const list = await screen.findByRole("list", { name: "Paired phones" });
    await user.click(within(list).getByRole("button", { name: "Revoke" }));
    await user.click(within(list).getByRole("button", { name: "Cancel" }));
    expect(within(list).getByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("says the phone is revoked even when the list could not be updated", async () => {
    respond = (call) =>
      call.method === "DELETE"
        ? { status: 200, body: { revoked: "dev_pixel", listError: "The local data server is not running." } }
        : undefined;
    const user = await open();
    const list = await screen.findByRole("list", { name: "Paired phones" });
    await user.click(within(list).getByRole("button", { name: "Revoke" }));
    await user.click(within(list).getByRole("button", { name: "Confirm revoke" }));
    expect(await screen.findByText(/can no longer sync, but the list could not be updated/)).toBeTruthy();
  });
});
