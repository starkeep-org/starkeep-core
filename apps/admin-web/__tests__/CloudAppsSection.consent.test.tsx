// @vitest-environment jsdom
/**
 * `CloudAppsSection`'s consent phase (plan §3.2) — the step between clicking
 * Install and the installer actually running.
 *
 * Three behaviours carry weight: an app that declares capabilities must NOT
 * install until the operator approves (the install POST is gated on it), the
 * operator's denials must reach the route as `deniedCapabilities`, and the
 * denial set must RESET when the modal is reopened — a stale denial carried
 * across opens would silently strip a capability from the next install.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import type { LocalAppEntry } from "@/lib/app-types";

vi.mock("@/lib/cloud-config", () => ({
  readCloudConfig: async () => ({ cognitoConfig: {}, region: "us-east-1", publicBaseUrl: null }),
  readCognitoSession: async () => ({ refreshToken: "rt" }),
  writeCloudCredentials: async () => {},
  writeCognitoSession: async () => {},
}));
vi.mock("@/lib/cognito-auth", () => ({
  refreshTokens: async () => ({ idToken: "id", refreshToken: "rt" }),
  getIdentityPoolCredentials: async () => ({
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    sessionToken: "token",
  }),
}));

const { CloudAppsSection } = await import("@/components/CloudAppsSection");

/** An SSE body that immediately reports success, so the install "completes". */
function sseBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ appId: "photos" })}\n\n`),
      );
      controller.close();
    },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function scriptFetch() {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/apps/cloud/list")) {
      return { ok: true, status: 200, json: async () => ({ apps: [] }) };
    }
    return { ok: true, status: 200, body: sseBody() };
  });
  vi.stubGlobal("fetch", fetchMock);
}

function app(capabilities: unknown[]): LocalAppEntry {
  return {
    appId: "photos",
    sourceDir: "/apps/photos",
    status: "active",
    manifest: {
      id: "photos",
      name: "Photos",
      version: "1.0.0",
      infraRequirements: { capabilities },
    },
  } as LocalAppEntry;
}

const BEDROCK = {
  name: "bedrock.invoke",
  required: false,
  models: ["anthropic.claude-haiku-4-5"],
  requestedMonthlyBudgetUsd: 20,
  reports: [],
  rationale: "captions",
};

/** Install POSTs to the app's cloud-install route (not the registry read). */
function installCalls(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes("/cloud-install"))
    .map((c) => JSON.parse((c[1] as { body: string }).body) as Record<string, unknown>);
}

/**
 * Click Install, once it is actually clickable.
 *
 * The button renders from the first paint but starts `disabled` — `cloudReady`
 * is null until the mount effect's `readCloudConfig()` resolves. Clicking it
 * before then is silently a no-op, and the test fails several seconds later on
 * a dialog that was never asked to open. Waiting for the enabled state is the
 * whole fix; on a loaded machine that effect lost the race often enough to fail
 * roughly one run in fifteen.
 */
async function clickInstall() {
  const btn = await screen.findByRole("button", { name: "Install in cloud" });
  await waitFor(() => expect(btn.hasAttribute("disabled")).toBe(false));
  fireEvent.click(btn);
}

beforeEach(() => {
  // jsdom implements neither; the install log auto-scrolls on every new line.
  Element.prototype.scrollIntoView = () => {};
  scriptFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("consent gating", () => {
  it("shows the consent step and does NOT install until it is approved", async () => {
    render(<CloudAppsSection apps={[app([BEDROCK])]} />);
    await clickInstall();
    // Consent UI, not the install log.
    await screen.findByText("bedrock.invoke");
    expect(screen.getByText("Approve & install")).toBeTruthy();
    expect(installCalls()).toHaveLength(0);

    fireEvent.click(screen.getByText("Approve & install"));
    await waitFor(() => expect(installCalls()).toHaveLength(1));
  });

  it("installs immediately for an app that declares no capabilities", async () => {
    render(<CloudAppsSection apps={[app([])]} />);
    await clickInstall();
    await waitFor(() => expect(installCalls()).toHaveLength(1));
    expect(screen.queryByText("Approve & install")).toBeNull();
  });

  it("sends an empty denial list when everything is approved", async () => {
    render(<CloudAppsSection apps={[app([BEDROCK])]} />);
    await clickInstall();
    fireEvent.click(await screen.findByText("Approve & install"));
    await waitFor(() => expect(installCalls()).toHaveLength(1));
    expect(installCalls()[0]!.deniedCapabilities).toEqual([]);
  });

  it("forwards a denied optional capability to the install route", async () => {
    render(<CloudAppsSection apps={[app([BEDROCK])]} />);
    await clickInstall();
    fireEvent.click(await screen.findByLabelText("Approve bedrock.invoke"));
    fireEvent.click(screen.getByText("Approve & install"));
    await waitFor(() => expect(installCalls()).toHaveLength(1));
    expect(installCalls()[0]!.deniedCapabilities).toEqual(["bedrock.invoke"]);
  });

  it("carries the operator's STS credentials and region alongside the denials", async () => {
    render(<CloudAppsSection apps={[app([BEDROCK])]} />);
    await clickInstall();
    fireEvent.click(await screen.findByText("Approve & install"));
    await waitFor(() => expect(installCalls()).toHaveLength(1));
    expect(installCalls()[0]).toMatchObject({
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      sessionToken: "token",
      region: "us-east-1",
    });
  });

  it("RESETS the denial set when the modal is reopened", async () => {
    render(<CloudAppsSection apps={[app([BEDROCK])]} />);
    // First open: deny, then cancel out without installing.
    await clickInstall();
    fireEvent.click(await screen.findByLabelText("Approve bedrock.invoke"));
    expect((screen.getByLabelText("Approve bedrock.invoke") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByText("Cancel"));

    // Second open: the previous denial must not persist.
    await clickInstall();
    await waitFor(() =>
      expect((screen.getByLabelText("Approve bedrock.invoke") as HTMLInputElement).checked).toBe(true),
    );
    fireEvent.click(screen.getByText("Approve & install"));
    await waitFor(() => expect(installCalls()).toHaveLength(1));
    expect(installCalls()[0]!.deniedCapabilities).toEqual([]);
  });

  it("re-shows the consent step on every reopen (it is not a one-time gate)", async () => {
    render(<CloudAppsSection apps={[app([BEDROCK])]} />);
    await clickInstall();
    fireEvent.click(await screen.findByText("Cancel"));
    await clickInstall();
    expect(await screen.findByText("Approve & install")).toBeTruthy();
    expect(installCalls()).toHaveLength(0);
  });
});
