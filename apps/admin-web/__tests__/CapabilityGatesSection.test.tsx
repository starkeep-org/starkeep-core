// @vitest-environment jsdom
/**
 * `CapabilityGatesSection` — the operator usage-gate editor (plan §3.5).
 *
 * The gate table is the cost-governance control, so what this file pins is what
 * the operator can be misled about: that an app-consent gate is shown but not
 * editable (a reinstall would revert an edit), that a limit on an app-reported
 * dimension is caveated rather than presented as a hard cap, and that the posted
 * scope drops blank fields to wildcards instead of matching the empty string.
 *
 * The cloud-config/credentials plumbing is mocked; `fetch` is the seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import type { GateListResponse, GateView } from "@/lib/capability-gates";

const CREDS = { accessKeyId: "AKIA", secretAccessKey: "secret", sessionToken: "token" };
let credsToReturn: typeof CREDS | null = CREDS;

vi.mock("@/lib/cloud-config", () => ({
  readCloudConfig: async () => (credsToReturn ? { cognitoConfig: {}, region: "us-east-1" } : null),
  readCloudCredentials: async () => credsToReturn,
  writeCloudCredentials: async () => {},
  readCognitoSession: async () => ({ refreshToken: "rt" }),
  writeCognitoSession: async () => {},
  credentialsNearExpiry: () => false,
}));
vi.mock("@/lib/cognito-auth", () => ({
  refreshTokens: async () => ({ idToken: "id", refreshToken: "rt" }),
  getIdentityPoolCredentials: async () => CREDS,
}));

const { CapabilityGatesSection } = await import("@/components/CapabilityGatesSection");

const DIMENSIONS: GateListResponse["dimensions"] = [
  { key: "cost:usd_micros", dimension: "cost", unit: "usd_micros", source: "cds", timing: "post", generic: true },
  { key: "requests:all", dimension: "requests", unit: "all", source: "cds", timing: "pre", generic: true },
  {
    key: "input:pixels",
    dimension: "input",
    unit: "pixels",
    source: "app",
    timing: "pre",
    generic: false,
  },
];

function gateView(over: Partial<GateView> = {}): GateView {
  return {
    id: "operator:01ABC",
    capabilityName: "bedrock.invoke",
    dimension: "cost",
    unit: "usd_micros",
    scope: {},
    window: { kind: "calendar", period: "month" },
    limit: 50_000_000, // $50
    origin: "operator",
    editable: true,
    createdAt: null,
    ...over,
  };
}

function listResponse(gates: GateView[]): GateListResponse {
  return {
    gates,
    dimensions: DIMENSIONS,
    capabilities: ["bedrock.invoke"],
    providers: ["anthropic", "amazon"],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Script the list response; writes resolve { ok: true } unless overridden. */
function scriptFetch(gates: GateView[], writeResponse?: { status: number; body: unknown }) {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/capabilities/gates")) {
      return { ok: true, status: 200, json: async () => listResponse(gates) };
    }
    const r = writeResponse ?? { status: 200, body: { ok: true } };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** The bodies of the writes (POST/DELETE) sent to the edit route. */
function writeCalls(): Array<{ method: string; body: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes("/gates/edit"))
    .map((c) => ({
      method: (c[1] as { method: string }).method,
      body: JSON.parse((c[1] as { body: string }).body) as Record<string, unknown>,
    }));
}

beforeEach(() => {
  credsToReturn = CREDS;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderReady(gates: GateView[], writeResponse?: { status: number; body: unknown }) {
  scriptFetch(gates, writeResponse);
  render(<CapabilityGatesSection />);
  await waitFor(() => expect(screen.getByText("Add gate")).toBeTruthy());
  if (gates.length > 0) {
    await waitFor(() => expect(screen.getAllByText(/bedrock\.invoke/).length).toBeGreaterThan(0));
  } else {
    await waitFor(() => expect(screen.getByText(/No gates configured/)).toBeTruthy());
  }
}

async function openAdd() {
  fireEvent.click(screen.getByText("Add gate"));
  await waitFor(() => expect(screen.getByText("Add gate", { selector: "h2" })).toBeTruthy());
}

describe("gate table", () => {
  it("renders a gate's meter, scope, window and limit", async () => {
    await renderReady([gateView()]);
    const row = screen.getByText("bedrock.invoke").closest("tr")!;
    expect(within(row).getByText("cost:usd_micros")).toBeTruthy();
    expect(within(row).getByText("global")).toBeTruthy();
    expect(within(row).getByText("per month")).toBeTruthy();
    expect(within(row).getByText("$50")).toBeTruthy(); // 50_000_000 micros
  });

  it("summarizes a scoped burst gate", async () => {
    await renderReady([
      gateView({
        dimension: "requests",
        unit: "all",
        scope: { provider: "anthropic", appId: "photos" },
        window: { kind: "burst", seconds: 30 },
        limit: 100,
      }),
    ]);
    const row = screen.getByText("requests:all").closest("tr")!;
    expect(within(row).getByText("app photos · provider anthropic")).toBeTruthy();
    expect(within(row).getByText("30s burst")).toBeTruthy();
  });

  it("says plainly that spend is unbounded when no gate exists", async () => {
    await renderReady([]);
    expect(screen.getByText(/spend is unbounded/)).toBeTruthy();
  });

  it("flags a limit on an app-reported dimension rather than showing it as a hard cap", async () => {
    await renderReady([gateView({ dimension: "input", unit: "pixels", limit: 1000 })]);
    const row = screen.getByText("input:pixels").closest("tr")!;
    expect(within(row).getByText("app-reported")).toBeTruthy();
  });

  it("does NOT flag a CDS-measured dimension", async () => {
    await renderReady([gateView()]);
    const row = screen.getByText("cost:usd_micros").closest("tr")!;
    expect(within(row).queryByText("app-reported")).toBeNull();
  });

  it("flags a stored gate whose dimension the platform no longer meters", async () => {
    // Such a row never sums, so it enforces nothing — the table must not let it
    // read as a working limit.
    await renderReady([gateView({ dimension: "gpu", unit: "seconds" })]);
    const row = screen.getByText("gpu:seconds").closest("tr")!;
    expect(within(row).getByText("unmetered")).toBeTruthy();
  });

  it("shows an app-consent gate as read-only, with no way to edit it", async () => {
    await renderReady([
      gateView({
        id: "consent:photos:bedrock.invoke",
        origin: "app-consent",
        scope: { appId: "photos" },
        limit: 20_000_000, // typed "20" in the $ field
        editable: false,
      }),
    ]);
    expect(screen.getByText("app consent")).toBeTruthy();
    expect(screen.getByText("read-only")).toBeTruthy();
    expect(screen.queryByText("Edit")).toBeNull();
  });

  it("still offers Edit for the operator's own gates in the same table", async () => {
    await renderReady([
      gateView(),
      gateView({ id: "consent:photos:bedrock.invoke", origin: "app-consent", editable: false }),
    ]);
    expect(screen.getAllByText("Edit")).toHaveLength(1);
  });

  it("prompts to sign in instead of erroring without operator credentials", async () => {
    credsToReturn = null;
    scriptFetch([gateView()]);
    render(<CapabilityGatesSection />);
    await waitFor(() =>
      expect(screen.getByText(/Sign in to the cloud to manage usage gates/)).toBeTruthy(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a list failure as an error alert", async () => {
    fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: "DSQL query failed" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CapabilityGatesSection />);
    await waitFor(() => expect(screen.getByText("DSQL query failed")).toBeTruthy());
  });
});

describe("adding a gate", () => {
  it("posts a global monthly cost cap", async () => {
    await renderReady([]);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Limit ($)"), { target: { value: "100" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]!.method).toBe("POST");
    expect(writeCalls()[0]!.body.gate).toEqual({
      capabilityName: "bedrock.invoke",
      dimension: "cost",
      unit: "usd_micros",
      scope: {},
      window: { kind: "calendar", period: "month" },
      limit: 100_000_000, // typed "100" in the $ field -> canonical micros
    });
  });

  it("omits blank scope fields so they stay wildcards", async () => {
    await renderReady([]);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Limit ($)"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Scope model"), { target: { value: "   " } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect((writeCalls()[0]!.body.gate as { scope: object }).scope).toEqual({});
  });

  it("posts each scope key the operator does fill in", async () => {
    await renderReady([]);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Limit ($)"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Scope provider"), { target: { value: "amazon" } });
    fireEvent.change(screen.getByLabelText("Scope model"), { target: { value: "amazon.nova-lite" } });
    fireEvent.change(screen.getByLabelText("Scope app"), { target: { value: "photos" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect((writeCalls()[0]!.body.gate as { scope: object }).scope).toEqual({
      provider: "amazon",
      model: "amazon.nova-lite",
      appId: "photos",
    });
  });

  it("posts a burst window in seconds", async () => {
    await renderReady([]);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Meters"), { target: { value: "requests:all" } });
    // A count dimension: the field is "Limit", not "Limit ($)" — the label
    // tracks the selected meter, so a count is never typed as dollars.
    fireEvent.change(screen.getByLabelText("Limit"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Window kind"), { target: { value: "burst" } });
    fireEvent.change(screen.getByLabelText("Burst seconds"), { target: { value: "10" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]!.body.gate).toMatchObject({
      dimension: "requests",
      unit: "all",
      window: { kind: "burst", seconds: 10 },
    });
  });

  it("warns before saving that an app-reported meter also DENIES apps that don't declare it", async () => {
    await renderReady([]);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Meters"), { target: { value: "input:pixels" } });
    expect(screen.getByText(/under-report/)).toBeTruthy();
    expect(screen.getByText(/DENIES any app/)).toBeTruthy();
  });

  it("says a CDS-measured meter holds against a misbehaving app", async () => {
    await renderReady([]);
    await openAdd();
    expect(screen.getByText(/holds even against a misbehaving app/)).toBeTruthy();
  });

  it("rejects a blank or negative limit locally, without calling the API", async () => {
    await renderReady([]);
    await openAdd();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText(/Limit must be a non-negative dollar amount/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Limit ($)"), { target: { value: "-5" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText(/Limit must be a non-negative dollar amount/)).toBeTruthy());
    expect(writeCalls()).toHaveLength(0);
  });

  it("rejects a fractional burst window locally", async () => {
    await renderReady([]);
    await openAdd();
    fireEvent.change(screen.getByLabelText("Limit ($)"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Window kind"), { target: { value: "burst" } });
    fireEvent.change(screen.getByLabelText("Burst seconds"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(screen.getByText(/positive whole number of seconds/)).toBeTruthy(),
    );
    expect(writeCalls()).toHaveLength(0);
  });

  it("surfaces a server rejection and keeps the dialog open", async () => {
    await renderReady([], { status: 400, body: { error: "Unknown provider \"acme\"." } });
    await openAdd();
    fireEvent.change(screen.getByLabelText("Limit ($)"), { target: { value: "10" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText('Unknown provider "acme".')).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("editing and deleting a gate", () => {
  async function openEdit() {
    fireEvent.click(screen.getAllByText("Edit")[0]!);
    await waitFor(() => expect(screen.getByText("Edit gate")).toBeTruthy());
  }

  it("pre-fills the dialog from the gate and posts its id back", async () => {
    await renderReady([
      gateView({ id: "operator:FIXED", scope: { appId: "photos" }, limit: 20_000_000 }),
    ]);
    await openEdit();
    expect((screen.getByLabelText("Limit ($)") as HTMLInputElement).value).toBe("20");
    expect((screen.getByLabelText("Scope app") as HTMLInputElement).value).toBe("photos");
    fireEvent.change(screen.getByLabelText("Limit ($)"), { target: { value: "5" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]!.body.gate).toMatchObject({ id: "operator:FIXED", limit: 5_000_000 });
  });

  it("pre-fills a burst window's seconds", async () => {
    await renderReady([gateView({ window: { kind: "burst", seconds: 45 } })]);
    await openEdit();
    expect((screen.getByLabelText("Burst seconds") as HTMLInputElement).value).toBe("45");
  });

  it("deletes by id", async () => {
    await renderReady([gateView({ id: "operator:FIXED" })]);
    await openEdit();
    fireEvent.click(screen.getByText("Delete gate"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]!.method).toBe("DELETE");
    expect(writeCalls()[0]!.body.gateId).toBe("operator:FIXED");
  });

  it("offers no delete when creating (there is nothing to delete yet)", async () => {
    await renderReady([]);
    await openAdd();
    expect(screen.queryByText("Delete gate")).toBeNull();
  });

  it("reloads the list after a successful save", async () => {
    await renderReady([gateView()]);
    const listsBefore = fetchMock.mock.calls.filter((c) =>
      String(c[0]).endsWith("/api/capabilities/gates"),
    ).length;
    await openEdit();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/capabilities/gates")).length,
      ).toBe(listsBefore + 1),
    );
  });
});
