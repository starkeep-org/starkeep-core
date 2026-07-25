// @vitest-environment jsdom
/**
 * `CapabilityModelsSection` — the operator model-registry editor (plan §3.6).
 *
 * What matters here is the sparse-override contract the UI is responsible for:
 * a field is only sent when its override toggle is ON (otherwise the model must
 * keep inheriting the platform default), pricing is a pair, and "reset to
 * platform" must DELETE rather than write an all-default row. The section's
 * cloud-config/credentials plumbing is mocked; `fetch` is the seam under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import type { ModelRow } from "@/lib/capability-models";

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

const { CapabilityModelsSection } = await import("@/components/CapabilityModelsSection");

function modelRow(over: Partial<ModelRow> = {}): ModelRow {
  return {
    modelId: "anthropic.claude-haiku-4-5",
    source: "platform",
    effective: {
      provider: "anthropic",
      inferenceProfileId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      vision: true,
      inputPerMTok: 1,
      outputPerMTok: 5,
      imageTokens: 1600,
    },
    platform: {
      provider: "anthropic",
      inferenceProfileId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      vision: true,
      inputPerMTok: 1,
      outputPerMTok: 5,
      imageTokens: 1600,
    },
    override: {},
    ...over,
  } as ModelRow;
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Script the list response; writes resolve { ok: true } unless overridden. */
function scriptFetch(models: ModelRow[], writeResponse?: { status: number; body: unknown }) {
  fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (String(url).endsWith("/api/capabilities/models")) {
      return { ok: true, status: 200, json: async () => ({ models }) };
    }
    const r = writeResponse ?? { status: 200, body: { ok: true } };
    return { ok: r.status < 400, status: r.status, json: async () => r.body, method: init?.method };
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** The body of the Nth override write (POST or DELETE). */
function writeCalls(): Array<{ method: string; body: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes("/models/override"))
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

async function renderReady(models: ModelRow[], writeResponse?: { status: number; body: unknown }) {
  scriptFetch(models, writeResponse);
  render(<CapabilityModelsSection />);
  await waitFor(() => expect(screen.getByText(models[0]!.modelId)).toBeTruthy());
}

describe("registry table", () => {
  it("renders each model's effective values", async () => {
    await renderReady([modelRow()]);
    const row = screen.getByText("anthropic.claude-haiku-4-5").closest("tr")!;
    expect(within(row).getByText("anthropic")).toBeTruthy();
    expect(within(row).getByText("$1")).toBeTruthy();
    expect(within(row).getByText("$5")).toBeTruthy();
    expect(within(row).getByText("1600")).toBeTruthy();
  });

  it("badges a platform model, an overridden platform model, and an operator model distinctly", async () => {
    await renderReady([
      modelRow(),
      modelRow({ modelId: "anthropic.claude-sonnet-5", override: { inputPerMTok: 2 } }),
      modelRow({ modelId: "acme.custom-1", source: "user", platform: null }),
    ]);
    expect(screen.getByText("platform")).toBeTruthy();
    expect(screen.getByText("overridden")).toBeTruthy();
    expect(screen.getByText("operator")).toBeTruthy();
  });

  it("renders an em dash for absent pricing / profile rather than 'null'", async () => {
    await renderReady([
      modelRow({
        modelId: "amazon.nova-reel-v1:1",
        effective: {
          provider: "amazon",
          inferenceProfileId: null,
          vision: false,
          inputPerMTok: null,
          outputPerMTok: null,
          imageTokens: null,
        },
        platform: null,
      } as Partial<ModelRow>),
    ]);
    const row = screen.getByText("amazon.nova-reel-v1:1").closest("tr")!;
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(4);
    expect(within(row).queryByText("null")).toBeNull();
  });

  it("prompts to sign in instead of erroring when there are no operator credentials", async () => {
    credsToReturn = null;
    scriptFetch([modelRow()]);
    render(<CapabilityModelsSection />);
    await waitFor(() =>
      expect(screen.getByText(/Sign in to the cloud to manage the model registry/)).toBeTruthy(),
    );
    // Never called the API without credentials.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a registry read failure as an error alert", async () => {
    fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: "DSQL query failed" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CapabilityModelsSection />);
    await waitFor(() => expect(screen.getByText("DSQL query failed")).toBeTruthy());
  });
});

describe("the sparse-override contract", () => {
  /** Open the edit dialog for the first model. */
  async function openEdit() {
    fireEvent.click(screen.getAllByText("Edit")[0]!);
    await waitFor(() => expect(screen.getByText(/^Edit /)).toBeTruthy());
  }

  function toggleFor(label: RegExp | string): HTMLInputElement {
    const field = screen.getByText(label).closest("div")!;
    return within(field).getByRole("checkbox") as HTMLInputElement;
  }

  it("sends an EMPTY override when no field is toggled on (the reset-to-default path)", async () => {
    await renderReady([modelRow()]);
    await openEdit();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    const [call] = writeCalls();
    expect(call!.method).toBe("POST");
    // The server turns an empty override on a platform model into a DELETE.
    expect(call!.body.override).toEqual({});
    expect(call!.body.modelId).toBe("anthropic.claude-haiku-4-5");
  });

  it("sends ONLY the fields whose override toggle is on", async () => {
    await renderReady([modelRow()]);
    await openEdit();
    fireEvent.click(toggleFor(/Token pricing/));
    const inputs = screen.getAllByPlaceholderText(/^(in|out)$/) as HTMLInputElement[];
    fireEvent.change(inputs[0]!, { target: { value: "2" } });
    fireEvent.change(inputs[1]!, { target: { value: "8" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    // Vision / profile / image tokens stay inherited — they are absent, not null.
    expect(writeCalls()[0]!.body.override).toEqual({ inputPerMTok: 2, outputPerMTok: 8 });
  });

  it("sends pricing as a PAIR, so the server's half-set rejection can't be hit from the UI", async () => {
    await renderReady([modelRow()]);
    await openEdit();
    fireEvent.click(toggleFor(/Token pricing/));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    const override = writeCalls()[0]!.body.override as Record<string, unknown>;
    expect("inputPerMTok" in override).toBe(true);
    expect("outputPerMTok" in override).toBe(true);
  });

  it("rejects a negative price locally, without calling the API", async () => {
    await renderReady([modelRow()]);
    await openEdit();
    fireEvent.click(toggleFor(/Token pricing/));
    const inputs = screen.getAllByPlaceholderText(/^(in|out)$/) as HTMLInputElement[];
    fireEvent.change(inputs[0]!, { target: { value: "-1" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(screen.getByText(/must be non-negative numbers/)).toBeTruthy(),
    );
    expect(writeCalls()).toHaveLength(0);
  });

  it("surfaces a server rejection in the dialog and keeps it open", async () => {
    await renderReady([modelRow()], { status: 400, body: { error: "input and output $/MTok must be set together" } });
    await openEdit();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(screen.getByText("input and output $/MTok must be set together")).toBeTruthy(),
    );
    // Still open — the operator can correct and retry.
    expect(screen.getByText(/^Edit /)).toBeTruthy();
  });
});

describe("adding an operator-defined model", () => {
  it("requires a model id", async () => {
    await renderReady([modelRow()]);
    fireEvent.click(screen.getByText("Add model"));
    await screen.findByPlaceholderText(/provider\.model-id/);
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText("Model id is required.")).toBeTruthy());
    expect(writeCalls()).toHaveLength(0);
  });

  it("refuses an id that already exists in the registry", async () => {
    await renderReady([modelRow()]);
    fireEvent.click(screen.getByText("Add model"));
    const idInput = await screen.findByPlaceholderText(/provider\.model-id/);
    fireEvent.change(idInput, { target: { value: "anthropic.claude-haiku-4-5" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText(/already exists/)).toBeTruthy());
    expect(writeCalls()).toHaveLength(0);
  });

  it("always sends a provider for a new model (it can't be gated/metered without one)", async () => {
    await renderReady([modelRow()]);
    fireEvent.click(screen.getByText("Add model"));
    const idInput = await screen.findByPlaceholderText(/provider\.model-id/);
    fireEvent.change(idInput, { target: { value: "acme.custom-1" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    const body = writeCalls()[0]!.body;
    expect(body.modelId).toBe("acme.custom-1");
    expect((body.override as Record<string, unknown>).provider).toBeTruthy();
  });
});
