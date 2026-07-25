// @vitest-environment jsdom
/**
 * `CapabilityConsent` — the install-time consent UI (plan §3.2).
 *
 * The operator's decision here becomes the app's grant rows and its cost gate,
 * so two things are load-bearing in the markup itself: a REQUIRED capability
 * must not be deniable (denying it is an install-blocking error, not a UI
 * choice), and each reported dimension must be labelled honestly —
 * "app-reported" (an input value the app supplies and could under-report) vs
 * "best-effort" (an output value nobody can know in advance).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { CapabilityConsent } from "@/components/CapabilityConsent";
import type { CapabilityRequirement } from "@/lib/app-types";

afterEach(cleanup);

const BEDROCK: CapabilityRequirement = {
  name: "bedrock.invoke",
  required: false,
  models: ["anthropic.claude-haiku-4-5", "amazon.nova-lite"],
  requestedMonthlyBudgetUsd: 20,
  reports: ["input:pixels", "output:duration_ms"],
  rationale: "Generate photo captions.",
};

function renderConsent(
  capabilities: CapabilityRequirement[],
  denied: Set<string> = new Set(),
  onToggle = vi.fn(),
) {
  render(
    <CapabilityConsent capabilities={capabilities} denied={denied} onToggle={onToggle} />,
  );
  return onToggle;
}

/** The approve checkbox for a capability. */
function checkboxFor(name: string): HTMLInputElement {
  return screen.getByLabelText(`Approve ${name}`) as HTMLInputElement;
}

describe("rendering", () => {
  it("renders nothing at all when the app declares no capabilities", () => {
    const { container } = render(
      <CapabilityConsent capabilities={[]} denied={new Set()} onToggle={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows the capability name, rationale, budget and models", () => {
    renderConsent([BEDROCK]);
    expect(screen.getByText("bedrock.invoke")).toBeTruthy();
    expect(screen.getByText("Generate photo captions.")).toBeTruthy();
    // The consented figure the operator is agreeing to.
    expect(screen.getByText(/up to ~\$20\.00\/mo/)).toBeTruthy();
    expect(screen.getByText("anthropic.claude-haiku-4-5")).toBeTruthy();
    expect(screen.getByText("amazon.nova-lite")).toBeTruthy();
  });

  it("omits the budget row entirely when the app requested none", () => {
    const { requestedMonthlyBudgetUsd: _drop, ...noBudget } = BEDROCK;
    renderConsent([noBudget]);
    expect(screen.queryByText("Budget")).toBeNull();
  });

  it("shows a $0 budget rather than hiding it", () => {
    renderConsent([{ ...BEDROCK, requestedMonthlyBudgetUsd: 0 }]);
    expect(screen.getByText(/up to ~\$0\.00\/mo/)).toBeTruthy();
  });

  it("omits the models and reports rows when empty", () => {
    renderConsent([{ name: "bedrock.invoke", required: false, models: [], reports: [] }]);
    expect(screen.queryByText("Models")).toBeNull();
    expect(screen.queryByText("Reports")).toBeNull();
  });

  it("renders one card per declared capability", () => {
    renderConsent([BEDROCK, { name: "other.cap", required: true }]);
    expect(checkboxFor("bedrock.invoke")).toBeTruthy();
    expect(checkboxFor("other.cap")).toBeTruthy();
  });
});

describe("required vs optional", () => {
  it("marks an optional capability as optional and lets the operator deny it", () => {
    const onToggle = renderConsent([BEDROCK]);
    expect(screen.getByText("optional")).toBeTruthy();
    const box = checkboxFor("bedrock.invoke");
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
    box.click();
    expect(onToggle).toHaveBeenCalledWith("bedrock.invoke", false);
  });

  it("a REQUIRED capability cannot be toggled off", () => {
    renderConsent([{ ...BEDROCK, required: true }]);
    expect(screen.getByText("required")).toBeTruthy();
    const box = checkboxFor("bedrock.invoke");
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(true);
  });

  it("treats an OMITTED required flag as required (the schema's default)", () => {
    renderConsent([{ name: "bedrock.invoke", models: ["m"] }]);
    expect(screen.getByText("required")).toBeTruthy();
    expect(checkboxFor("bedrock.invoke").disabled).toBe(true);
  });

  it("shows a required capability as approved even if its name is in `denied`", () => {
    // A stale denial must never render a required capability as denied — the
    // install would abort, so the UI must not suggest it is an option.
    renderConsent([{ ...BEDROCK, required: true }], new Set(["bedrock.invoke"]));
    expect(checkboxFor("bedrock.invoke").checked).toBe(true);
    expect(screen.getByText("Approved")).toBeTruthy();
  });

  it("reflects a denied optional capability as unchecked and labelled Denied", () => {
    renderConsent([BEDROCK], new Set(["bedrock.invoke"]));
    expect(checkboxFor("bedrock.invoke").checked).toBe(false);
    expect(screen.getByText("Denied")).toBeTruthy();
  });

  it("re-approving a denied capability reports approve = true", () => {
    const onToggle = renderConsent([BEDROCK], new Set(["bedrock.invoke"]));
    checkboxFor("bedrock.invoke").click();
    expect(onToggle).toHaveBeenCalledWith("bedrock.invoke", true);
  });

  it("toggling one capability does not report another", () => {
    const onToggle = renderConsent([BEDROCK, { name: "second.cap", required: false }]);
    checkboxFor("second.cap").click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("second.cap", false);
  });
});

describe("report-dimension honesty labels (plan §3.5)", () => {
  it("labels an INPUT dimension app-reported and an OUTPUT dimension best-effort", () => {
    renderConsent([BEDROCK]);
    const megapixels = screen.getByText("input:pixels").parentElement!;
    expect(within(megapixels).getByText("app-reported")).toBeTruthy();
    const duration = screen.getByText("output:duration_ms").parentElement!;
    expect(within(duration).getByText("best-effort")).toBeTruthy();
  });

  it("labels a non-output dimension (credits) as app-reported", () => {
    renderConsent([{ ...BEDROCK, reports: ["credits:count"] }]);
    const credits = screen.getByText("credits:count").parentElement!;
    expect(within(credits).getByText("app-reported")).toBeTruthy();
  });

  it("labels every output unit best-effort, whatever the unit", () => {
    renderConsent([{ ...BEDROCK, reports: ["output:frames", "output:pixels"] }]);
    expect(screen.getAllByText("best-effort")).toHaveLength(2);
    expect(screen.queryByText("app-reported")).toBeNull();
  });
});
