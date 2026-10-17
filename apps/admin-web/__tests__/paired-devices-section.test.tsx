/**
 * @vitest-environment jsdom
 *
 * The dashboard's paired-phones section.
 *
 * Pins what the section promises: the private half of the key reaches the QR
 * code and never the server, the code disappears on "Done", the list comes from
 * the device records through the list route, the signed-in operator's `sub`
 * becomes the device's user, and revoking asks twice.
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

/** An unsigned ID token naming the operator; the section reads `sub` from it. */
const ID_TOKEN = `h.${btoa(JSON.stringify({ sub: "sub-operator" }))}.s`;

vi.mock("@/lib/cognito-auth", () => ({
  refreshTokens: async () => ({ idToken: ID_TOKEN, refreshToken: "rt2" }),
  getIdentityPoolCredentials: async () => ({
    accessKeyId: "AKIA",
    secretAccessKey: "s",
    sessionToken: "t",
    expiration: "2026-10-13T13:00:00.000Z",
  }),
}));

const { PairedDevicesSection } = await import("../src/components/PairedDevicesSection");

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

const PIXEL = {
  deviceId: "dev_pixel",
  label: "Pixel 8",
  kind: "phone",
  userId: "sub-operator",
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
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      calls.push(call);
      const override = respond(call);
      if (override) return Response.json(override.body, { status: override.status });
      if (url === "/api/devices/list") return Response.json({ devices });
      if (url === "/api/devices/inspect") {
        return Response.json({
          request: { deviceId: "dev_sam", label: "Sam's laptop", kind: "desktop" },
          fingerprint: "ab12 cd34",
        });
      }
      if (url === "/api/devices/approve") {
        devices = [...devices, { ...PIXEL, deviceId: "dev_sam", label: "Sam's laptop", kind: "desktop" }];
        return Response.json({ approved: { deviceId: "dev_sam" } });
      }
      if (call.method === "POST") {
        devices = [...devices, { ...PIXEL, deviceId: String(call.body!.deviceId), label: (call.body!.label as string) ?? null }];
        return Response.json({ paired: {}, baseUrl: "https://d123.cloudfront.net" });
      }
      if (call.method === "DELETE") {
        devices = devices.filter((d) => d.deviceId !== call.body!.deviceId);
        return Response.json({ revoked: call.body!.deviceId });
      }
      return Response.json({ error: `unexpected ${url}` }, { status: 404 });
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
  await user.click(screen.getByRole("button", { name: /Devices/ }));
  return user;
}

describe("the list", () => {
  it("shows each paired phone by name and id", async () => {
    await open();
    const list = await screen.findByRole("list", { name: "Paired devices" });
    expect(within(list).getByText("Pixel 8")).toBeTruthy();
    expect(within(list).getByText(/dev_pixel/)).toBeTruthy();
  });

  it("says so when no phone is paired", async () => {
    devices = [];
    await open();
    expect(await screen.findByText("No devices are paired.")).toBeTruthy();
  });

  it("reads the list with the operator's session", async () => {
    await open();
    await screen.findByRole("list", { name: "Paired devices" });
    const listCall = calls.find((c) => c.url === "/api/devices/list")!;
    expect(listCall.body).toMatchObject({ stackPrefix: "sktest", region: "us-east-2" });
    expect((listCall.body!.credentials as { accessKeyId: string }).accessKeyId).toBe("AKIA");
  });

  it("names the problem when the records cannot be read", async () => {
    respond = (call) =>
      call.url === "/api/devices/list" ? { status: 500, body: { error: "AccessDeniedException" } } : undefined;
    await open();
    expect(await screen.findByText("AccessDeniedException")).toBeTruthy();
  });
});

describe("pairing", () => {
  it("sends the public half only, and shows the private half as a QR code until Done", async () => {
    const user = await open();
    await user.type(screen.getByPlaceholderText(/Name this phone/), "Tablet");
    await user.click(screen.getByRole("button", { name: "Pair a phone" }));

    const code = await screen.findByRole("img", { name: "Pairing code for Tablet" });
    expect(code.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

    const post = calls.find((c) => c.url === "/api/devices" && c.method === "POST")!;
    const [keys] = generated;
    expect(post.body).toMatchObject({
      deviceId: keys!.deviceId,
      publicKeySpki: keys!.publicKeySpki,
      label: "Tablet",
      stackPrefix: "sktest",
      userId: "sub-operator",
    });
    // The seed appears nowhere in what reaches the server.
    expect(JSON.stringify(post.body)).not.toContain(keys!.privateKeySeed);

    // The list picked up the new phone.
    const list = await screen.findByRole("list", { name: "Paired devices" });
    await waitFor(() => expect(within(list).getByText("Tablet")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Pair a phone" })).toBeTruthy();
  });

  it("sends a blank name as no label", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Pair a phone" }));
    await screen.findByRole("img", { name: "Pairing code for Unnamed device" });
    expect(calls.find((c) => c.url === "/api/devices" && c.method === "POST")!.body!.label).toBeNull();
  });

  it("shows the route's error and no code when pairing fails", async () => {
    respond = (call) =>
      call.url === "/api/devices" && call.method === "POST"
        ? { status: 500, body: { error: "AccessDeniedException" } }
        : undefined;
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Pair a phone" }));
    expect(await screen.findByText("AccessDeniedException")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
  });
});

describe("revoking", () => {
  it("asks for confirmation, then revokes by id", async () => {
    const user = await open();
    const list = await screen.findByRole("list", { name: "Paired devices" });
    await user.click(within(list).getByRole("button", { name: "Revoke" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(within(list).getByRole("button", { name: "Confirm revoke" }));
    expect(await screen.findByText("Revoked Pixel 8")).toBeTruthy();
    expect(calls.find((c) => c.method === "DELETE")!.body).toMatchObject({ deviceId: "dev_pixel" });
    expect(await screen.findByText("No devices are paired.")).toBeTruthy();
  });

  it("can be cancelled", async () => {
    const user = await open();
    const list = await screen.findByRole("list", { name: "Paired devices" });
    await user.click(within(list).getByRole("button", { name: "Revoke" }));
    await user.click(within(list).getByRole("button", { name: "Cancel" }));
    expect(within(list).getByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("approving a device from its code", () => {
  it("shows the fingerprint before approving, then approves for the signed-in operator", async () => {
    const user = await open();
    await user.type(screen.getByLabelText("Pairing code to approve"), "CODE123");
    await user.click(screen.getByRole("button", { name: "Check the code" }));
    expect(await screen.findByText("ab12 cd34")).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/devices/approve")).toBe(false);

    await user.click(screen.getByRole("button", { name: /fingerprint matches/ }));
    expect(await screen.findByText(/Approved Sam's laptop/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/devices/approve")!.body).toMatchObject({
      code: "CODE123",
      userId: "sub-operator",
      stackPrefix: "sktest",
    });
    const list = await screen.findByRole("list", { name: "Paired devices" });
    expect(await within(list).findByText("Sam's laptop")).toBeTruthy();
  });
});
