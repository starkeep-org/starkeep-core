/**
 * @vitest-environment jsdom
 *
 * Hide on the example app's card: removes the example app's folder from
 * Discover apps, after a confirm that names the folder to add it back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAppsSection } from "../src/components/LocalAppsSection";
import { APPS_CHANGED_EVENT } from "../src/components/AppDiscovery";
import type { LocalAppEntry } from "../src/lib/app-types";

vi.mock("@/lib/operator-session", () => ({ operatorSessionIfSignedIn: async () => null }));

const EXAMPLE_DIR = "/core/example-app";

const example: LocalAppEntry = {
  appId: "example-app",
  sourceDir: EXAMPLE_DIR,
  configuredDir: EXAMPLE_DIR,
  bundledExample: true,
  status: "not_installed",
  manifest: { id: "example-app", name: "Example App", version: "0.1.0" },
};

let patches: unknown[] = [];

function serve() {
  patches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/config" && init?.method === "PATCH") {
        patches.push(JSON.parse(init.body as string));
        return Response.json({ config: {} });
      }
      if (url === "/api/config") {
        return Response.json({ config: { appParentDirs: ["~/starkeep-apps", EXAMPLE_DIR] } });
      }
      return Response.json({});
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function menuItems(entry: LocalAppEntry): Promise<string[]> {
  const user = userEvent.setup();
  render(<LocalAppsSection apps={[entry]} refresh={async () => undefined} localOnline={true} />);
  const more = screen.queryByRole("button", { name: `More actions for ${entry.manifest.name}` });
  if (!more) return [];
  await user.click(more);
  return (await screen.findAllByRole("menuitem")).map((m) => m.textContent ?? "");
}

describe("Hide on the example app's card", () => {
  it("is offered for the bundled example while it is not installed", async () => {
    serve();
    expect(await menuItems(example)).toContain("Hide");
  });

  it("is not offered for a copy, an installed example, or an unknown status", async () => {
    serve();
    for (const entry of [
      { ...example, bundledExample: undefined },
      { ...example, status: "active" as const },
      { ...example, status: "unknown" as const },
    ]) {
      expect(await menuItems(entry)).not.toContain("Hide");
      cleanup();
    }
  });

  it("names the folder in the confirm, and removes only that folder", async () => {
    serve();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const changed = vi.fn();
    window.addEventListener(APPS_CHANGED_EVENT, changed);

    const user = userEvent.setup();
    await menuItems(example);
    await user.click(screen.getByRole("menuitem", { name: "Hide" }));

    expect(confirm).toHaveBeenCalledWith(
      `Hide the Example App? To show it again, add ${EXAMPLE_DIR} in Discover apps.`,
    );
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(patches).toEqual([{ appParentDirs: ["~/starkeep-apps"] }]);
    window.removeEventListener(APPS_CHANGED_EVENT, changed);
  });

  it("changes nothing when the confirm is declined", async () => {
    serve();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    await menuItems(example);
    await user.click(screen.getByRole("menuitem", { name: "Hide" }));
    expect(patches).toEqual([]);
  });
});
