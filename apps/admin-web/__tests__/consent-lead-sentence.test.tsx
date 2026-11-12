/**
 * @vitest-environment jsdom
 *
 * The install consent dialog opens with one sentence that matches the
 * app's file grants: none, a list, or the User-Data-Owner's all-files access.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAppsSection } from "../src/components/LocalAppsSection";
import type { LocalAppEntry } from "../src/lib/app-types";

vi.mock("@/lib/operator-session", () => ({ operatorSessionIfSignedIn: async () => null }));

/** Every request fails, as with no daemon running; the dialog still opens. */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const key = `${init?.method ?? "GET"} ${url}`;
      throw new TypeError(`fetch failed: ${key}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function entry(
  name: string,
  infraRequirements: LocalAppEntry["manifest"]["infraRequirements"],
): LocalAppEntry {
  const appId = name.toLowerCase();
  return {
    appId,
    sourceDir: `/apps/${appId}`,
    configuredDir: "/apps",
    status: "not_installed",
    manifest: { id: appId, name, infraRequirements },
  };
}

async function openConsent(app: LocalAppEntry) {
  stubFetch();
  const user = userEvent.setup();
  render(<LocalAppsSection apps={[app]} refresh={async () => undefined} localOnline={true} />);
  await user.click(screen.getByRole("button", { name: `Install ${app.manifest.name}` }));
  await screen.findByRole("button", { name: "Approve & Install" });
}

describe("the install consent dialog's lead sentence", () => {
  it("says an app with no file grants accesses none of your files, and nothing more", async () => {
    await openConsent(entry("Dice", {}));
    expect(screen.getByText("Dice doesn't access any of your files.")).toBeTruthy();
    expect(screen.queryByText(/asks for access to these files/)).toBeNull();
    expect(screen.queryByText(/No file-type grants/)).toBeNull();
  });

  it("introduces the list for an app with file grants", async () => {
    await openConsent(
      entry("Notes", {
        fileAccess: [{ types: ["document/markdown"], access: "readwrite", rationale: "notes" }],
      }),
    );
    expect(screen.getByText("Notes asks for access to these files.")).toBeTruthy();
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.queryByText(/access any of your files/)).toBeNull();
  });

  it("states all-files access for the User-Data-Owner instead", async () => {
    await openConsent(entry("Drive", { fileAccessAll: true }));
    expect(screen.getByText("User-Data-Owner")).toBeTruthy();
    expect(screen.queryByText(/access any of your files/)).toBeNull();
    expect(screen.queryByText(/asks for access to these files/)).toBeNull();
  });
});
