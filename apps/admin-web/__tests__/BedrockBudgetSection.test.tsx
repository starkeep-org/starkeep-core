// @vitest-environment jsdom
/**
 * `BedrockBudgetSection` — the operator panel for the Bedrock spend guardrail
 * (budget-guardrail plan §4.7).
 *
 * What this pins is what the operator can be MISLED about, since the panel's
 * whole job is telling the truth about a control they cannot see directly:
 *
 *   - a live freeze must read loudly, with the date it self-clears (so nobody
 *     believes their apps are permanently broken) and a way to lift it early;
 *   - a STANDBY action after a prior freeze must read as NOT frozen — that is
 *     the assertion that catches a cached-flag implementation;
 *   - the caveats must be present, because a guardrail believed to do more than
 *     it does is worse than none.
 *
 * The cloud-config/credentials plumbing is mocked; `fetch` is the seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import type { BedrockBudgetView } from "@/components/BedrockBudgetSection";

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

const { BedrockBudgetSection } = await import("@/components/BedrockBudgetSection");

function view(over: Partial<BedrockBudgetView> = {}): BedrockBudgetView {
  return {
    exists: true,
    limitMicros: 25_000_000,
    actualSpendMicros: 3_500_000,
    forecastedSpendMicros: 9_250_000,
    actionId: "action-1",
    actionStatus: "STANDBY",
    frozenRoleNames: [],
    targetRoleNames: ["starkeep-app-capability-broker-role"],
    lastExecuted: null,
    preferenceEnabled: true,
    preferenceLimitUsd: 25,
    frozen: false,
    selfClearsAt: "2026-08-01T00:00:00.000Z",
    globalCostGateUsd: 20,
    ...over,
  };
}

/** Serve the status route from `v`; record every edit-route POST body. */
function mockFetch(v: BedrockBudgetView): { edits: Record<string, unknown>[] } {
  const edits: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/edit")) {
        edits.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, json: async () => v } as Response;
    }),
  );
  return { edits };
}

beforeEach(() => {
  credsToReturn = CREDS;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("armed (not frozen)", () => {
  it("renders the limit, month-to-date spend, and the global gate beside them", async () => {
    mockFetch(view());
    render(<BedrockBudgetSection />);
    await waitFor(() => expect(screen.getByTestId("budget-status").textContent).toContain("Armed"));
    expect(screen.getByTestId("budget-limit").textContent).toContain("$25.00");
    expect(screen.getByTestId("budget-spend").textContent).toContain("$3.50");
    // The soft ceiling shown next to the hard one: they are independent, so
    // showing them together is the only thing that makes a divergence legible.
    expect(screen.getByTestId("budget-gate-limit").textContent).toContain("$20/month");
  });

  it("renders NOT frozen on a Standby action even after a prior freeze", async () => {
    // The §3 self-clear case. A cached "we froze it" flag would still be showing
    // the freeze banner here, long after the apps recovered.
    mockFetch(view({ actionStatus: "STANDBY", frozen: false, lastExecuted: "2026-06-14T10:00:00Z" }));
    render(<BedrockBudgetSection />);
    await waitFor(() => expect(screen.getByTestId("budget-status").textContent).toContain("Armed"));
    expect(screen.queryByText(/Bedrock is frozen/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
  });

  it("carries the honest caveats", async () => {
    mockFetch(view());
    render(<BedrockBudgetSection />);
    await waitFor(() => expect(screen.getByTestId("budget-status")).toBeTruthy());
    // Not decoration — each of these is a limit of the control that the operator
    // would otherwise assume away.
    expect(screen.getByText(/not your whole AWS bill/i)).toBeTruthy();
    expect(screen.getByText(/cost data lags/i)).toBeTruthy();
    expect(screen.getByText(/In-flight jobs already/i)).toBeTruthy();
    expect(screen.getByText(/the next install re-creates it/i)).toBeTruthy();
  });

  it("posts set-limit with the edited value", async () => {
    const { edits } = mockFetch(view());
    render(<BedrockBudgetSection />);
    await waitFor(() => expect(screen.getByLabelText("Monthly limit ($)")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Monthly limit ($)"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: /save limit/i }));
    await waitFor(() => expect(edits).toHaveLength(1));
    expect(edits[0]).toMatchObject({ action: "set-limit", limitUsd: 40 });
  });

  it("offers a manual freeze", async () => {
    const { edits } = mockFetch(view());
    render(<BedrockBudgetSection />);
    await waitFor(() => expect(screen.getByRole("button", { name: /freeze bedrock now/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /freeze bedrock now/i }));
    await waitFor(() => expect(edits).toHaveLength(1));
    expect(edits[0]).toMatchObject({ action: "freeze" });
  });
});

describe("frozen", () => {
  const frozen = view({
    frozen: true,
    frozenRoleNames: ["starkeep-app-capability-broker-role"],
    actionStatus: "EXECUTION_SUCCESS",
    lastExecuted: "2026-07-14T10:00:00.000Z",
  });

  it("renders loudly, with the fire date and the self-clear date", async () => {
    mockFetch(frozen);
    render(<BedrockBudgetSection />);
    await waitFor(() => expect(screen.getByText(/Bedrock is frozen/i)).toBeTruthy());
    expect(screen.getByTestId("budget-status").textContent).toContain("Frozen");
    // Both dates: when it happened, and when it ends without intervention. The
    // second is what stops the operator believing this is permanent. Asserted on
    // the banner's whole text, since JSX interpolation splits it across nodes.
    const banner = screen.getByRole("alert").textContent ?? "";
    expect(banner).toContain("Jul 14, 2026");
    expect(banner).toContain("Aug 1, 2026");
  });

  it("offers Resume, framed as lifting it now", async () => {
    const { edits } = mockFetch(frozen);
    render(<BedrockBudgetSection />);
    const button = await screen.findByRole("button", { name: /resume bedrock now/i });
    fireEvent.click(button);
    await waitFor(() => expect(edits).toHaveLength(1));
    expect(edits[0]).toMatchObject({ action: "resume" });
  });

  it("hides the manual freeze button while already frozen", async () => {
    mockFetch(frozen);
    render(<BedrockBudgetSection />);
    await waitFor(() => expect(screen.getByText(/Bedrock is frozen/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /freeze bedrock now/i })).toBeNull();
  });
});

describe("disabled and not-created", () => {
  it("offers to turn the guardrail on when the operator disabled it", async () => {
    const { edits } = mockFetch(view({ exists: false, preferenceEnabled: false, limitMicros: null }));
    render(<BedrockBudgetSection />);
    await waitFor(() => expect(screen.getByTestId("budget-status").textContent).toContain("Off"));
    fireEvent.click(screen.getByRole("button", { name: /turn guardrail on/i }));
    await waitFor(() => expect(edits).toHaveLength(1));
    expect(edits[0]).toMatchObject({ action: "enable" });
  });

  it("flags an enabled-but-missing budget as a failed install, not as off", async () => {
    mockFetch(view({ exists: false, preferenceEnabled: true, limitMicros: null }));
    render(<BedrockBudgetSection />);
    await waitFor(() => expect(screen.getByTestId("budget-status").textContent).toContain("Not created"));
    expect(screen.getByText(/no budget exists in AWS/i)).toBeTruthy();
    expect(screen.getByText(/bootstrap CloudFormation/i)).toBeTruthy();
  });

  it("tells an unsigned-in operator to sign in", async () => {
    credsToReturn = null;
    mockFetch(view());
    render(<BedrockBudgetSection />);
    await waitFor(() =>
      expect(screen.getByText(/Sign in to the cloud to manage the spend guardrail/i)).toBeTruthy(),
    );
  });

  it("surfaces a status-route error instead of rendering a blank panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "assume failed" }) }) as Response),
    );
    render(<BedrockBudgetSection />);
    await waitFor(() => expect(screen.getByText("assume failed")).toBeTruthy());
  });
});
