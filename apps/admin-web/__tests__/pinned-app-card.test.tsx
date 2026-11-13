/**
 * @vitest-environment jsdom
 *
 * An installed app's card when its pinned folder is gone, or holds a manifest
 * other than the one the user approved. A changed manifest updates through
 * the update dialog that Start opens. The cloud side of that dialog is in
 * app-update.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAppsSection } from "../src/components/LocalAppsSection";
import { AppUpdateProvider, SKEW_WARNING } from "../src/components/AppUpdate";
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
/** Every install, daemon and dependency request, in order. */
let calls: string[] = [];
/** What `POST /api/apps/install` answers. */
let installAnswer: () => Response = () => Response.json({ ok: true });
let started = false;
let plan: unknown = { kind: "skip", reason: "The app's folder has no package.json." };
/** The dependency stream's frames, or null for a stream that is never requested. */
let depsStream: string | null = null;
let depsPosts = 0;

function serve() {
  installs = [];
  calls = [];
  depsPosts = 0;
  started = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/apps/install") {
        installs.push(JSON.parse(init!.body as string));
        calls.push("install");
        return installAnswer();
      }
      if (url === "/api/exec/daemon") {
        const action = (JSON.parse(init!.body as string) as { action: string }).action;
        calls.push(action);
        if (action === "start") started = true;
        return Response.json({ ok: true });
      }
      if (url === "/api/apps/dice/dependencies" && init?.method === "POST") {
        depsPosts++;
        return new Response(depsStream ?? "", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url === "/api/apps/dice/dependencies") return Response.json(plan);
      if (url === "/api/apps/dice/install-status")
        return Response.json({ appId: "dice", steps: [] });
      if (url.startsWith("/api/exec/daemon/status")) return Response.json({ running: started });
      return Response.json({});
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  plan = { kind: "skip", reason: "The app's folder has no package.json." };
  depsStream = null;
  installAnswer = () => Response.json({ ok: true });
});

function show(entry: LocalAppEntry) {
  render(
    <AppUpdateProvider cloudAdministered={false} signedIn={false}>
      <LocalAppsSection apps={[entry]} refresh={async () => undefined} localOnline={true} />
    </AppUpdateProvider>,
  );
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
    const note = screen.getByText(/Source folder not found/).textContent;
    expect(note).toContain("/apps/dice");
    expect(note).toContain("Uninstalling deletes its data on this machine.");
    expect((screen.getByRole("button", { name: "Start Dice" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions for Dice" }));
    expect(await screen.findByRole("menuitem", { name: "Uninstall" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Update from folder" })).toBeNull();
  });

  it("warns that Uninstall deletes the app's data on this machine, and uninstalls nothing on cancel", async () => {
    serve();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    show({ ...installed, sourceState: "missing" });
    await chooseFromMenu("Uninstall");
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("This deletes Dice's own data on this machine"),
    );
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).not.toContain("/api/apps/uninstall");
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

describe("Start with a changed folder manifest", () => {
  const CHANGED: LocalAppEntry = {
    ...installed,
    sourceState: "changed",
    folderManifest: { ...approved, version: "1.1.0" },
  };

  async function clickStart() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start Dice" }));
    return user;
  }

  it("says Start applies the change, and offers no Update from folder", async () => {
    serve();
    show(CHANGED);
    expect(
      screen.getByText("Its folder holds a changed manifest. Start the app to apply it."),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions for Dice" }));
    expect(await screen.findByRole("menuitem", { name: "Uninstall" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Update from folder" })).toBeNull();
  });

  it("opens the update dialog, then reinstalls and starts the app", async () => {
    serve();
    show(CHANGED);
    const user = await clickStart();
    expect(await screen.findByRole("heading", { name: "Update Dice?" })).toBeTruthy();
    const local = screen.getByRole("checkbox", { name: "Update Dice on this computer" });
    expect((local as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "Update Dice in the cloud" })).toBeNull();
    expect(screen.queryByText(SKEW_WARNING)).toBeNull();
    // The file access did not change, so the dialog does not show it again.
    expect(screen.queryByText(/asks for access to these files/)).toBeNull();
    expect(calls).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Update & Start" }));
    await vi.waitFor(() => expect(calls).toEqual(["install", "start"]), { timeout: 3000 });
    // The update dialog showed the folder's manifest, so the install approves that one.
    expect(installs).toEqual([{ appId: "dice", approvedManifest: CHANGED.folderManifest }]);
  });

  it("shows the file access when the folder's manifest changes it", async () => {
    serve();
    show({
      ...CHANGED,
      folderManifest: {
        ...approved,
        infraRequirements: {
          fileAccess: [{ types: ["image/png"], access: "readwrite", rationale: "your images" }],
        },
      },
    });
    await clickStart();
    expect(await screen.findByText(/asks for access to these files/)).toBeTruthy();
  });

  it("shows public links when the folder's manifest turns them on", async () => {
    serve();
    show({
      ...CHANGED,
      folderManifest: {
        ...approved,
        infraRequirements: { ...approved.infraRequirements, publicSharing: true },
      },
    });
    await clickStart();
    expect(await screen.findByText(/can create web links to your images/)).toBeTruthy();
  });

  it("warns, and starts the approved manifest, when the operator unchecks the update", async () => {
    serve();
    show(CHANGED);
    const user = await clickStart();
    await user.click(await screen.findByRole("checkbox", { name: "Update Dice on this computer" }));
    expect(screen.getByText(SKEW_WARNING)).toBeTruthy();
    // The dialog's approve button now names the start alone.
    const dialog = screen.getByRole("heading", { name: "Update Dice?" }).parentElement!;
    await user.click(within(dialog).getByRole("button", { name: "Start Dice" }));
    await vi.waitFor(() => expect(calls).toEqual(["start"]), { timeout: 3000 });
    expect(installs).toEqual([]);
  });

  it("changes nothing on Cancel", async () => {
    serve();
    show(CHANGED);
    const user = await clickStart();
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Update Dice?" })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("leaves the app stopped, and shows the failure, when the reinstall fails", async () => {
    serve();
    installAnswer = () => Response.json({ error: "The schema step failed." }, { status: 500 });
    show(CHANGED);
    const user = await clickStart();
    await user.click(await screen.findByRole("button", { name: "Update & Start" }));
    expect(await screen.findByRole("heading", { name: "Install of dice failed" })).toBeTruthy();
    expect(screen.getByText("The schema step failed.")).toBeTruthy();
    expect(calls).toEqual(["install"]);
  });

  it("starts at once when nothing is behind", async () => {
    serve();
    show(installed);
    await clickStart();
    await vi.waitFor(() => expect(calls).toEqual(["start"]), { timeout: 3000 });
    expect(screen.queryByRole("heading", { name: "Update Dice?" })).toBeNull();
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

describe("the dependency install at Install", () => {
  const notInstalled: LocalAppEntry = { ...installed, status: "not_installed" };

  async function approve() {
    const user = userEvent.setup();
    show(notInstalled);
    await user.click(screen.getByRole("button", { name: "Install Dice" }));
    return user;
  }

  it("names the command and folder in the consent dialog", async () => {
    plan = { kind: "run", display: "pnpm install --frozen-lockfile", cwd: "/apps/dice" };
    serve();
    await approve();
    const line = await screen.findByText(/which runs the app.s own install scripts/);
    expect(line.textContent).toBe(
      "Install runs pnpm install --frozen-lockfile in /apps/dice, which runs the app\u2019s own install scripts.",
    );
  });

  it("runs the command, then registers the app and closes its output", async () => {
    plan = { kind: "run", display: "pnpm install --frozen-lockfile", cwd: "/apps/dice" };
    depsStream = 'data: "Packages: +12"\n\n' + 'event: done\ndata: {"appId":"dice"}\n\n';
    serve();
    const user = await approve();
    await user.click(await screen.findByRole("button", { name: "Approve & Install" }));
    await vi.waitFor(() =>
      expect(installs).toEqual([{ appId: "dice", approvedManifest: approved }]),
    );
    expect(depsPosts).toBe(1);
    expect(screen.queryByText(/Installing Dice.s dependencies/)).toBeNull();
  });

  it("stops before registering when the command fails", async () => {
    plan = { kind: "run", display: "pnpm install --frozen-lockfile", cwd: "/apps/dice" };
    depsStream = 'event: error\ndata: {"message":"`pnpm install` exited with code 1"}\n\n';
    serve();
    const user = await approve();
    await user.click(await screen.findByRole("button", { name: "Approve & Install" }));
    // The output stays up to explain the failure.
    expect(await screen.findByText(/Installing Dice.s dependencies/)).toBeTruthy();
    expect(await screen.findByText(/exited with code 1/)).toBeTruthy();
    expect(installs).toEqual([]);
  });

  it("registers without running a refused command, and says what to run by hand", async () => {
    plan = {
      kind: "refused",
      display: "make deps",
      cwd: "/apps/dice",
      reason: "make is not an approved package manager.",
    };
    serve();
    const user = await approve();
    expect(await screen.findByText(/Install will not run/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approve & Install" }));
    await vi.waitFor(() =>
      expect(installs).toEqual([{ appId: "dice", approvedManifest: approved }]),
    );
    expect(depsPosts).toBe(0);
    expect(screen.getByText(/Run it yourself in \/apps\/dice before you start Dice/)).toBeTruthy();
  });
});
