/**
 * @vitest-environment jsdom
 *
 * An installed app's card when its pinned folder is gone, or holds a manifest
 * other than the one the user approved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAppsSection } from "../src/components/LocalAppsSection";
import { consentDiffers, type LocalAppEntry, type ManifestSummary } from "../src/lib/app-types";

vi.mock("@/lib/operator-session", () => ({ operatorSessionIfSignedIn: async () => null }));

const approved: ManifestSummary = {
  id: "dice",
  name: "Dice",
  version: "1.0.0",
  infraRequirements: {
    fileAccess: [{ types: ["image/png"], access: "read", rationale: "your images" }],
  },
};

const installed: LocalAppEntry = {
  appId: "dice",
  sourceDir: "/apps/dice",
  status: "active",
  manifest: approved,
};

let installs: unknown[] = [];

function serve() {
  installs = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/apps/install") {
        installs.push(JSON.parse(init!.body as string));
        return Response.json({ ok: true });
      }
      if (url.startsWith("/api/exec/daemon/status")) return Response.json({ running: false });
      return Response.json({});
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(entry: LocalAppEntry) {
  render(<LocalAppsSection apps={[entry]} refresh={async () => undefined} localOnline={true} />);
}

async function chooseFromMenu(label: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "More actions for Dice" }));
  await user.click(await screen.findByRole("menuitem", { name: label }));
  return user;
}

describe("a pinned folder that is gone", () => {
  it("names the folder, keeps Uninstall, and disables Start", async () => {
    serve();
    show({ ...installed, sourceState: "missing" });
    expect(screen.getByText(/Source folder not found/).textContent).toContain("/apps/dice");
    expect((screen.getByRole("button", { name: "Start Dice" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions for Dice" }));
    expect(await screen.findByRole("menuitem", { name: "Uninstall" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Update from folder" })).toBeNull();
  });
});

describe("a pinned folder whose manifest fails validation", () => {
  it("replaces the description with a note, keeps Start and Uninstall, and offers no update", async () => {
    serve();
    show({
      ...installed,
      manifest: { ...approved, description: "Roll some dice" },
      sourceState: "invalid",
      sourceError: "name: Required",
    });
    expect(screen.getByText(/^Note:/).closest("[data-slot=card-description]")?.textContent).toBe(
      "Note: The app’s folder holds an invalid manifest (name: Required). Starkeep keeps using the manifest you approved at install.",
    );
    expect(screen.queryByText("Roll some dice")).toBeNull();
    expect((screen.getByRole("button", { name: "Start Dice" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions for Dice" }));
    expect(await screen.findByRole("menuitem", { name: "Uninstall" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Update from folder" })).toBeNull();
  });
});

describe("Update from folder", () => {
  it("reinstalls at once when the folder's manifest asks for the same file access", async () => {
    serve();
    show({
      ...installed,
      sourceState: "changed",
      folderManifest: { ...approved, version: "1.1.0" },
    });
    await chooseFromMenu("Update from folder");
    await vi.waitFor(() => expect(installs).toEqual([{ appId: "dice", approved: true }]));
    expect(screen.queryByRole("button", { name: "Approve & Install" })).toBeNull();
  });

  it("asks for approval first when the folder's manifest asks for new file access", async () => {
    serve();
    show({
      ...installed,
      sourceState: "changed",
      folderManifest: {
        ...approved,
        infraRequirements: {
          fileAccess: [{ types: ["image/png"], access: "readwrite", rationale: "your images" }],
        },
      },
    });
    const user = await chooseFromMenu("Update from folder");
    expect(installs).toEqual([]);
    await user.click(await screen.findByRole("button", { name: "Approve & Install" }));
    await vi.waitFor(() => expect(installs).toEqual([{ appId: "dice", approved: true }]));
  });

  it("asks for approval first when the folder's manifest turns on public links", async () => {
    serve();
    show({
      ...installed,
      sourceState: "changed",
      folderManifest: {
        ...approved,
        infraRequirements: { ...approved.infraRequirements, publicSharing: true },
      },
    });
    await chooseFromMenu("Update from folder");
    expect(await screen.findByText(/can publish files to public links/)).toBeTruthy();
    expect(installs).toEqual([]);
  });
});

describe("consentDiffers", () => {
  it("ignores order and an absent metadataWrite, and sees access, types and all-access", () => {
    const base: ManifestSummary = {
      infraRequirements: {
        fileAccess: [
          { types: ["image/png", "image/jpeg"], access: "read", rationale: "a" },
          { types: ["video/mp4"], access: "read", metadataWrite: false, rationale: "b" },
        ],
      },
    };
    const reordered: ManifestSummary = {
      infraRequirements: {
        fileAccess: [
          { types: ["video/mp4"], access: "read", rationale: "changed wording" },
          { types: ["image/jpeg", "image/png"], access: "read", rationale: "a" },
        ],
      },
    };
    expect(consentDiffers(base, reordered)).toBe(false);
    expect(
      consentDiffers(base, {
        infraRequirements: { fileAccess: [...base.infraRequirements!.fileAccess!].slice(1) },
      }),
    ).toBe(true);
    expect(
      consentDiffers(base, {
        infraRequirements: { ...base.infraRequirements, fileAccessAll: true },
      }),
    ).toBe(true);
  });

  it("sees public links turned on with the same file access", () => {
    const base: ManifestSummary = {
      infraRequirements: { fileAccess: [{ types: ["image/png"], access: "read", rationale: "a" }] },
    };
    expect(
      consentDiffers(base, {
        infraRequirements: { ...base.infraRequirements, publicSharing: true },
      }),
    ).toBe(true);
    expect(
      consentDiffers(base, {
        infraRequirements: { ...base.infraRequirements, publicSharing: false },
      }),
    ).toBe(false);
  });
});
