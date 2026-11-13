/**
 * @vitest-environment jsdom
 *
 * The terminal install (`cli:install-app-local`) prints its consent words
 * from consent-text.ts, and Admin's consent dialog renders the same words
 * with markup. This test holds the dialog's text to those functions, so a
 * wording change in either place fails here rather than letting the two
 * installs ask for approval in different words.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConsentDialog } from "../src/components/ConsentDialog";
import {
  accessLead,
  dependencyConsent,
  publicSharingConsent,
  type DependencyPlan,
  type LocalAppEntry,
} from "../src/lib/app-types";

vi.mock("@/lib/operator-session", () => ({ operatorSessionIfSignedIn: async () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function entry(infraRequirements: LocalAppEntry["manifest"]["infraRequirements"]): LocalAppEntry {
  return {
    appId: "notes",
    sourceDir: "/apps/notes",
    configuredDir: "/apps",
    status: "not_installed",
    manifest: { id: "notes", name: "Notes", infraRequirements },
  };
}

/** The dialog's text with whitespace collapsed, once the dependency plan loads. */
async function dialogText(app: LocalAppEntry, plan: DependencyPlan): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === `/api/apps/${app.appId}/dependencies`
        ? Response.json(plan)
        : Response.json({ error: "not here" }, { status: 404 }),
    ),
  );
  render(<ConsentDialog entry={app} onApprove={() => {}} onCancel={() => {}} />);
  await screen.findByRole("button", { name: "Approve & Install" });
  if (plan.kind !== "skip") await screen.findByText(plan.display);
  return document.body.textContent!.replace(/\s+/g, " ");
}

describe("the consent dialog and the terminal install say the same words", () => {
  it.each<[string, LocalAppEntry["manifest"]["infraRequirements"], DependencyPlan]>([
    ["no file grants and no dependency install", {}, { kind: "skip", reason: "none" }],
    [
      "file grants, public links and a dependency install",
      {
        fileAccess: [{ types: ["image/jpeg"], access: "readwrite", rationale: "photos" }],
        publicSharing: true,
      },
      { kind: "run", display: "pnpm install --frozen-lockfile", cwd: "/apps/notes" },
    ],
    [
      "the User-Data-Owner and a refused dependency install",
      { fileAccessAll: true },
      {
        kind: "refused",
        display: "pnpm install",
        cwd: "/apps",
        reason: "/apps/notes/pnpm-workspace.yaml hides the app. Delete it.",
      },
    ],
  ])("for %s", async (_case, infraRequirements, plan) => {
    const app = entry(infraRequirements);
    const text = await dialogText(app, plan);
    expect(text).toContain(accessLead(app.manifest));
    const links = publicSharingConsent(app.manifest);
    if (links) expect(text).toContain(links);
    const dependencies = dependencyConsent(plan);
    if (dependencies) expect(text).toContain(dependencies);
  });
});
