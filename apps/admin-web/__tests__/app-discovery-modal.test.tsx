/**
 * @vitest-environment jsdom
 *
 * Discover apps: what each scanned directory contributed, and the alert icon
 * on the header button while any directory has a problem.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppDiscovery, foundAppsLine } from "../src/components/AppDiscovery";
import type { ScannedDir } from "../src/lib/app-types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function dir(path: string, appNames: string[], reasons: string[] = []): ScannedDir {
  return {
    dir: path,
    apps: appNames.map((name) => ({ appId: name.toLowerCase(), name })),
    problems: reasons.map((reason) => ({ configuredDir: path, dir: path, reason })),
  };
}

/** Serve `/api/config` and `/api/apps/list` for the scanned `dirs`. */
function serve(dirs: ScannedDir[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/config") {
        return Response.json({ config: { appParentDirs: dirs.map((d) => d.dir) } });
      }
      if (url === "/api/apps/list") {
        return Response.json({ apps: [], problems: dirs.flatMap((d) => d.problems), dirs });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

async function openModal() {
  const user = userEvent.setup();
  render(<AppDiscovery />);
  await user.click(screen.getByRole("button", { name: "Discover apps" }));
  return screen.findByRole("dialog");
}

/** The list item for a configured directory. */
async function entry(dialog: HTMLElement, path: string): Promise<HTMLElement> {
  return (await within(dialog).findByText(path)).closest("li")!;
}

describe("foundAppsLine", () => {
  it("names up to two apps and counts the rest", () => {
    expect(foundAppsLine([])).toBeNull();
    expect(foundAppsLine(["Photos"])).toBe("Found Photos");
    expect(foundAppsLine(["Photos", "Drive"])).toBe("Found Photos and Drive");
    expect(foundAppsLine(["Photos", "Drive", "Dice"])).toBe("Found Photos, Drive, and 1 more app");
    expect(foundAppsLine(["Photos", "Drive", "Dice", "Notes"])).toBe(
      "Found Photos, Drive, and 2 more apps",
    );
  });
});

describe("the status line under each directory", () => {
  it("says what each directory contributed", async () => {
    serve([
      dir("~/empty", []),
      dir("~/one", ["Photos"]),
      dir("~/two", ["Photos", "Drive"]),
      dir("~/four", ["Photos", "Drive", "Dice", "Notes"]),
    ]);
    const dialog = await openModal();
    expect((await entry(dialog, "~/empty")).textContent).toContain("No apps found");
    expect((await entry(dialog, "~/one")).textContent).toContain("Found Photos");
    expect((await entry(dialog, "~/two")).textContent).toContain("Found Photos and Drive");
    expect((await entry(dialog, "~/four")).textContent).toContain(
      "Found Photos, Drive, and 2 more apps",
    );
  });

  it("shows only the problem for a directory with no valid app", async () => {
    serve([dir("~/gone", [], ["The folder does not exist."])]);
    const item = await entry(await openModal(), "~/gone");
    expect(item.textContent).toContain("The folder does not exist.");
    expect(item.textContent).not.toContain("No apps found");
  });

  it("shows the apps and then each problem for a directory with both", async () => {
    serve([
      dir(
        "~/starkeep-apps",
        ["Photos"],
        ["Invalid manifest found for dice: name: Required", "The folder could not be read."],
      ),
    ]);
    const item = await entry(await openModal(), "~/starkeep-apps");
    const lines = [...item.querySelectorAll("p")].map((p) => p.textContent);
    expect(lines).toEqual([
      "Found Photos",
      "Invalid manifest found for dice: name: Required",
      "The folder could not be read.",
    ]);
  });
});

describe("the alert icon on the Discover apps button", () => {
  it("shows while any directory has a problem", async () => {
    serve([dir("~/one", ["Photos"]), dir("~/gone", [], ["The folder does not exist."])]);
    render(<AppDiscovery />);
    expect(await screen.findByRole("img", { name: "App discovery found problems" })).toBeTruthy();
  });

  it("is absent when no directory has a problem", async () => {
    serve([dir("~/one", ["Photos"])]);
    const dialog = await openModal();
    // The status line proves the scan answered, so the icon's absence is an answer too.
    await within(dialog).findByText("Found Photos");
    expect(screen.queryByRole("img", { name: "App discovery found problems" })).toBeNull();
  });
});
