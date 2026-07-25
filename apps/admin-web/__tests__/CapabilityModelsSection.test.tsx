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

const HAIKU_VALUES = {
  provider: "anthropic",
  inferenceProfileId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  vision: true,
  outputModality: "text" as const,
  pricing: { "input:tokens": 1, "output:tokens": 5 },
  imageTokens: 1600,
};

function modelRow(over: Partial<ModelRow> = {}): ModelRow {
  return {
    modelId: "anthropic.claude-haiku-4-5",
    source: "platform",
    effective: { ...HAIKU_VALUES, pricing: { ...HAIKU_VALUES.pricing } },
    platform: { ...HAIKU_VALUES, pricing: { ...HAIKU_VALUES.pricing } },
    override: {},
    ...over,
  } as ModelRow;
}

/** A generation model: priced per image, not per token. */
function canvasRow(over: Partial<ModelRow> = {}): ModelRow {
  const values = {
    provider: "amazon",
    inferenceProfileId: null,
    vision: false,
    outputModality: "image" as const,
    pricing: { "requests:image": 0.04 },
    imageTokens: null,
  };
  return {
    modelId: "amazon.nova-canvas-v1:0",
    source: "platform",
    effective: { ...values, pricing: { ...values.pricing } },
    platform: { ...values, pricing: { ...values.pricing } },
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
    expect(within(row).getByText("input:tokens $1")).toBeTruthy();
    expect(within(row).getByText("output:tokens $5")).toBeTruthy();
    expect(within(row).getByText("1600")).toBeTruthy();
  });

  it("shows the NON-token rate and modality of a generation model", async () => {
    // The token-only table rendered these models as unpriced "—" even though
    // they carry the rate the cost gate is derived from.
    await renderReady([canvasRow()]);
    const row = screen.getByText("amazon.nova-canvas-v1:0").closest("tr")!;
    expect(within(row).getByText("requests:image $0.04")).toBeTruthy();
    expect(within(row).getByText("image")).toBeTruthy();
  });

  it("badges a platform model, an overridden platform model, and an operator model distinctly", async () => {
    await renderReady([
      modelRow(),
      modelRow({
        modelId: "anthropic.claude-sonnet-5",
        override: { pricing: { "input:tokens": 2, "output:tokens": 8 } },
      }),
      modelRow({ modelId: "acme.custom-1", source: "user", platform: null }),
    ]);
    expect(screen.getByText("platform")).toBeTruthy();
    expect(screen.getByText("overridden")).toBeTruthy();
    expect(screen.getByText("operator")).toBeTruthy();
  });

  it("renders an em dash for absent pricing / profile rather than 'null'", async () => {
    await renderReady([
      modelRow({
        modelId: "acme.unpriced",
        effective: {
          provider: "amazon",
          inferenceProfileId: null,
          vision: false,
          outputModality: "text",
          pricing: {},
          imageTokens: null,
        },
        platform: null,
      } as Partial<ModelRow>),
    ]);
    const row = screen.getByText("acme.unpriced").closest("tr")!;
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

/** Open the edit dialog for the first model. */
async function openEdit() {
  fireEvent.click(screen.getAllByText("Edit")[0]!);
  await waitFor(() => expect(screen.getByText(/^Edit /)).toBeTruthy());
}

/** The "override this field" checkbox of a labelled OverrideField. Scoped to
 * the dialog — some labels ("Pricing") also name a table column behind it. */
function toggleFor(label: RegExp | string): HTMLInputElement {
  const field = within(screen.getByRole("dialog")).getByText(label).closest("div")!;
  return within(field).getByRole("checkbox") as HTMLInputElement;
}

/** The rate input for one "dimension:unit" row of the price editor. */
function rateInput(key: string): HTMLInputElement {
  return screen.getByLabelText(`Rate for ${key}`) as HTMLInputElement;
}

describe("the sparse-override contract", () => {
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
    fireEvent.click(toggleFor(/^Pricing$/));
    fireEvent.change(rateInput("input:tokens"), { target: { value: "2" } });
    fireEvent.change(rateInput("output:tokens"), { target: { value: "8" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    // Vision / profile / image tokens stay inherited — they are absent, not null.
    expect(writeCalls()[0]!.body.override).toEqual({
      pricing: { "input:tokens": 2, "output:tokens": 8 },
    });
  });

  it("seeds the price editor from the effective table, so a save KEEPS every rate", async () => {
    // The regression this guards: the editor could only express token rates, so
    // saving any override on a per-image model wiped `requests:image` — the rate
    // the cost gate is derived from.
    await renderReady([canvasRow()]);
    await openEdit();
    fireEvent.click(toggleFor(/^Pricing$/));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]!.body.override).toEqual({ pricing: { "requests:image": 0.04 } });
  });

  it("can add a NON-token rate alongside the token pair", async () => {
    await renderReady([modelRow()]);
    await openEdit();
    fireEvent.click(toggleFor(/^Pricing$/));
    fireEvent.click(screen.getByText("Add rate"));
    // The new row defaults to the first unused key; point it at requests:image.
    const selects = screen.getAllByLabelText("Price dimension") as HTMLSelectElement[];
    fireEvent.change(selects[selects.length - 1]!, { target: { value: "requests:image" } });
    fireEvent.change(rateInput("requests:image"), { target: { value: "0.04" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]!.body.override).toEqual({
      pricing: { "input:tokens": 1, "output:tokens": 5, "requests:image": 0.04 },
    });
  });

  it("can drop a rate entirely", async () => {
    await renderReady([modelRow()]);
    await openEdit();
    fireEvent.click(toggleFor(/^Pricing$/));
    fireEvent.click(screen.getByLabelText("Remove output:tokens"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(screen.getByText(/must be set together/)).toBeTruthy(),
    );
    // The token pair is enforced client-side too, so the server's 400 is
    // unreachable from the UI.
    expect(writeCalls()).toHaveLength(0);
  });

  it("rejects a negative price locally, without calling the API", async () => {
    await renderReady([modelRow()]);
    await openEdit();
    fireEvent.click(toggleFor(/^Pricing$/));
    fireEvent.change(rateInput("input:tokens"), { target: { value: "-1" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(screen.getByText(/must be a non-negative number/)).toBeTruthy(),
    );
    expect(writeCalls()).toHaveLength(0);
  });

  it("rejects a blank rate rather than posting a 0 the operator didn't mean", async () => {
    await renderReady([canvasRow()]);
    await openEdit();
    fireEvent.click(toggleFor(/^Pricing$/));
    fireEvent.change(rateInput("requests:image"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText(/must be a non-negative number/)).toBeTruthy());
    expect(writeCalls()).toHaveLength(0);
  });

  it("does not offer an output-modality control for a PLATFORM model", async () => {
    // Modality is intrinsic there; the API rejects it, so the UI must not ask.
    await renderReady([modelRow()]);
    await openEdit();
    expect(screen.queryByLabelText("Output modality")).toBeNull();
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

  it("declares an output modality, defaulting to text", async () => {
    // Every operator-defined model used to land as `text`, so a custom image or
    // video model was routed down the inline delivery channel.
    await renderReady([modelRow()]);
    fireEvent.click(screen.getByText("Add model"));
    const idInput = await screen.findByPlaceholderText(/provider\.model-id/);
    fireEvent.change(idInput, { target: { value: "acme.custom-1" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect((writeCalls()[0]!.body.override as Record<string, unknown>).outputModality).toBe("text");
  });

  it("sends the chosen modality for a generation model", async () => {
    await renderReady([modelRow()]);
    fireEvent.click(screen.getByText("Add model"));
    const idInput = await screen.findByPlaceholderText(/provider\.model-id/);
    fireEvent.change(idInput, { target: { value: "acme.video-1" } });
    fireEvent.change(screen.getByLabelText("Output modality"), { target: { value: "video" } });
    fireEvent.click(toggleFor(/^Pricing$/));
    const selects = screen.getAllByLabelText("Price dimension") as HTMLSelectElement[];
    fireEvent.change(selects[0]!, { target: { value: "output:duration_s" } });
    fireEvent.click(screen.getByLabelText("Remove output:tokens"));
    fireEvent.change(screen.getByLabelText("Rate for output:duration_s"), {
      target: { value: "0.08" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]!.body.override).toMatchObject({
      outputModality: "video",
      pricing: { "output:duration_s": 0.08 },
    });
  });
});
