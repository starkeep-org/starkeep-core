/**
 * @vitest-environment jsdom
 *
 * The update dialog that Start on a local card and Redeploy on a cloud card
 * share, when the local install, the cloud install or both run a manifest
 * other than the app folder's. After approval the cloud deploys first, the
 * local install updates second, and the app starts last, so the local app
 * never writes to a table the cloud lacks.
 *
 * Both sections render under one provider, as on the Dashboard. The Cognito
 * exchange and the cloud install stream are mocked; the flow is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LocalAppEntry, ManifestSummary } from "../src/lib/app-types";

const state = vi.hoisted(() => ({
  /** Every install, cloud deploy and daemon request, in order. */
  calls: [] as string[],
  cloudBodies: [] as Array<Record<string, unknown>>,
  cloudOutcome: { kind: "done", data: "{}" } as
    | { kind: "done"; data: string }
    | { kind: "error"; message: string; tokenExpired: boolean },
  signedIn: true,
}));

vi.mock("@/lib/cloud-config", () => ({
  readCloudConfig: async () => ({
    region: "us-east-2",
    publicBaseUrl: "https://d1.cloudfront.net",
    cognitoConfig: {},
  }),
  readCognitoSession: async () => (state.signedIn ? { refreshToken: "refresh" } : null),
  writeCloudCredentials: async () => {},
  writeCognitoSession: async () => {},
}));

vi.mock("@/lib/cognito-auth", () => ({
  refreshTokens: async () => ({ idToken: "id", refreshToken: "refresh" }),
  getIdentityPoolCredentials: async () => ({
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    sessionToken: "token",
  }),
}));

vi.mock("@/lib/install-stream-client", () => ({
  runInstallStream: async (url: string, body: Record<string, unknown>) => {
    state.calls.push(`cloud ${url}`);
    state.cloudBodies.push(body);
    return state.cloudOutcome;
  },
}));

const { LocalAppsSection } = await import("../src/components/LocalAppsSection");
const { CloudAppsSection } = await import("../src/components/CloudAppsSection");
const { AppUpdateProvider, SKEW_WARNING } = await import("../src/components/AppUpdate");

const CLOUD_DEPLOY = "cloud /api/apps/dice/cloud-install";

const approved: ManifestSummary = {
  id: "dice",
  name: "Dice",
  version: "1.0.0",
  targets: ["local", "cloud"],
  infraRequirements: { compute: { enabled: true } },
};
const folder: ManifestSummary = { ...approved, version: "1.1.0" };

/** Dice installed locally and in the cloud, its folder holding version 1.1.0. */
const CHANGED: LocalAppEntry = {
  appId: "dice",
  sourceDir: "/apps/dice",
  status: "active",
  manifest: approved,
  sourceState: "changed",
  folderManifest: folder,
};

let running = false;
let cloudBehind = true;
let cloudCodeBehind = false;
let cloudMobileOnly = false;
/** How `/api/apps/cloud/list` answers: the row, a failure, or never. */
let cloudList: "ok" | "fail" | "hang" = "ok";

beforeEach(() => {
  state.calls = [];
  state.cloudBodies = [];
  state.cloudOutcome = { kind: "done", data: "{}" };
  state.signedIn = true;
  running = false;
  cloudBehind = true;
  cloudCodeBehind = false;
  cloudMobileOnly = false;
  cloudList = "ok";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/apps/cloud/list") {
        if (cloudList === "hang") return new Promise<Response>(() => {});
        if (cloudList === "fail") return Response.json({ error: "DSQL down" }, { status: 502 });
        return Response.json({
          apps: [
            {
              appId: "dice",
              name: "Dice",
              version: "1.0.0",
              webApp: !cloudMobileOnly,
              mobileApp: cloudMobileOnly,
              manifest: approved,
              behind: cloudBehind,
              codeBehind: cloudCodeBehind,
            },
          ],
        });
      }
      if (url === "/api/apps/install") {
        state.calls.push("install");
        // The route stops a running app.
        running = false;
        return Response.json({ ok: true });
      }
      if (url === "/api/exec/daemon") {
        const action = (JSON.parse(init!.body as string) as { action: string }).action;
        state.calls.push(action);
        running = action === "start";
        return Response.json({ ok: true });
      }
      if (url.startsWith("/api/exec/daemon/status")) return Response.json({ running });
      if (url === "/api/apps/dice/dependencies") {
        return Response.json({ kind: "skip", reason: "The app's folder has no package.json." });
      }
      if (url === "/api/apps/dice/install-status")
        return Response.json({ appId: "dice", steps: [] });
      return Response.json({ error: `unexpected ${url}` }, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function show(entry: LocalAppEntry = CHANGED) {
  render(
    <AppUpdateProvider cloudAdministered signedIn={state.signedIn}>
      <div data-testid="local">
        <LocalAppsSection apps={[entry]} refresh={async () => undefined} localOnline={true} />
      </div>
      <div data-testid="cloud">
        <CloudAppsSection apps={[entry]} />
      </div>
    </AppUpdateProvider>,
  );
  if (state.signedIn) {
    await vi.waitFor(() =>
      expect(within(screen.getByTestId("cloud")).getByText("Installed")).toBeTruthy(),
    );
  }
}

/** Click Start on the local card and return the update dialog. */
async function start() {
  const user = userEvent.setup();
  await user.click(within(screen.getByTestId("local")).getByRole("button", { name: "Start Dice" }));
  return { user, dialog: await updateDialog() };
}

async function updateDialog(): Promise<HTMLElement> {
  return (await screen.findByRole("heading", { name: "Update Dice?" })).parentElement!;
}

function checkbox(dialog: HTMLElement, where: "on this computer" | "in the cloud") {
  return within(dialog).getByRole("checkbox", { name: `Update Dice ${where}` }) as HTMLInputElement;
}

describe("Start when both installs are behind", () => {
  it("checks both installs, and deploys the cloud before it reinstalls and starts", async () => {
    await show();
    const { user, dialog } = await start();
    expect(checkbox(dialog, "on this computer").checked).toBe(true);
    expect(checkbox(dialog, "in the cloud").checked).toBe(true);
    expect(within(dialog).queryByText(SKEW_WARNING)).toBeNull();
    expect(
      within(dialog).getByText("The cloud update runs first and takes a few minutes."),
    ).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Update & Start" }));
    await vi.waitFor(() => expect(state.calls).toEqual([CLOUD_DEPLOY, "install", "start"]), {
      timeout: 3000,
    });
    expect(state.cloudBodies[0]).toMatchObject({ surfaces: ["web"], approved: true });
  });

  it("warns, and skips the cloud, when the operator unchecks it", async () => {
    await show();
    const { user, dialog } = await start();
    await user.click(checkbox(dialog, "in the cloud"));
    expect(within(dialog).getByText(SKEW_WARNING)).toBeTruthy();
    expect(within(dialog).queryByText(/The cloud update runs first/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Update & Start" }));
    await vi.waitFor(() => expect(state.calls).toEqual(["install", "start"]), { timeout: 3000 });
  });

  it("stops after a failed cloud deploy, without reinstalling or starting", async () => {
    state.cloudOutcome = {
      kind: "error",
      message: "Deploy exited with code 1",
      tokenExpired: false,
    };
    await show();
    const { user, dialog } = await start();
    await user.click(within(dialog).getByRole("button", { name: "Update & Start" }));
    const panel = (
      await screen.findByRole("heading", { name: "Update Dice in the cloud" })
    ).closest("[role=dialog]") as HTMLElement;
    expect(await within(panel).findByText(/Deploy exited with code 1/)).toBeTruthy();
    // The text button, not the dialog's corner icon of the same name.
    const close = within(panel)
      .getAllByRole("button", { name: "Close" })
      .find((b) => b.textContent === "Close")!;
    await user.click(close);
    await vi.waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Update Dice in the cloud" })).toBeNull(),
    );
    expect(state.calls).toEqual([CLOUD_DEPLOY]);
    expect(
      within(screen.getByTestId("local")).getByRole("button", { name: "Start Dice" }),
    ).toBeTruthy();
  });
});

describe("Start when only the cloud is behind", () => {
  it("offers the cloud alone, then deploys and starts", async () => {
    await show({ ...CHANGED, manifest: folder, sourceState: undefined, folderManifest: undefined });
    const { user, dialog } = await start();
    expect(within(dialog).queryByRole("checkbox", { name: /on this computer/ })).toBeNull();
    expect(checkbox(dialog, "in the cloud").checked).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Update & Start" }));
    await vi.waitFor(() => expect(state.calls).toEqual([CLOUD_DEPLOY, "start"]), {
      timeout: 3000,
    });
  });
});

describe("Start when only the cloud's code is behind", () => {
  const CURRENT: LocalAppEntry = {
    ...CHANGED,
    manifest: approved,
    sourceState: undefined,
    folderManifest: undefined,
  };

  it("offers the cloud web app alone, then deploys and starts", async () => {
    cloudBehind = false;
    cloudCodeBehind = true;
    await show(CURRENT);
    const { user, dialog } = await start();
    expect(within(dialog).queryByRole("checkbox", { name: /on this computer/ })).toBeNull();
    expect(checkbox(dialog, "in the cloud").checked).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Update & Start" }));
    await vi.waitFor(() => expect(state.calls).toEqual([CLOUD_DEPLOY, "start"]), {
      timeout: 3000,
    });
    expect(state.cloudBodies[0]).toMatchObject({ surfaces: ["web"] });
  });

  it("starts at once when the cloud has only a mobile registration, which runs no code", async () => {
    cloudBehind = false;
    cloudCodeBehind = true;
    cloudMobileOnly = true;
    render(
      <AppUpdateProvider cloudAdministered signedIn>
        <div data-testid="local">
          <LocalAppsSection apps={[CURRENT]} refresh={async () => undefined} localOnline={true} />
        </div>
      </AppUpdateProvider>,
    );
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/apps/cloud/list", expect.anything()),
    );
    await new Promise((r) => setTimeout(r, 50));
    await userEvent
      .setup()
      .click(within(screen.getByTestId("local")).getByRole("button", { name: "Start Dice" }));
    await vi.waitFor(() => expect(state.calls).toEqual(["start"]), { timeout: 3000 });
    expect(screen.queryByRole("heading", { name: "Update Dice?" })).toBeNull();
  });
});

describe("Start with no admin signed in to the cloud", () => {
  it("disables the cloud choice, says why, and warns", async () => {
    state.signedIn = false;
    await show();
    const { dialog } = await start();
    const cloud = checkbox(dialog, "in the cloud");
    expect(cloud.disabled).toBe(true);
    expect(cloud.checked).toBe(false);
    expect(within(dialog).getByText("Sign in to the cloud to update it.")).toBeTruthy();
    expect(within(dialog).getByText(SKEW_WARNING)).toBeTruthy();
  });
});

describe("Redeploy on the cloud card", () => {
  async function redeploy() {
    const user = userEvent.setup();
    const cloud = screen.getByTestId("cloud");
    await user.click(within(cloud).getByRole("button", { name: "More actions for Dice" }));
    await user.click(await screen.findByRole("menuitem", { name: "Redeploy Dice" }));
    return { user, dialog: await updateDialog() };
  }

  it("restarts a local app that was running before its reinstall", async () => {
    running = true;
    await show();
    // A running app without a reported port shows a disabled Open button.
    await within(screen.getByTestId("local")).findByRole("button", { name: "Open Dice ↗" });
    const { user, dialog } = await redeploy();
    await user.click(within(dialog).getByRole("button", { name: "Update" }));
    await vi.waitFor(() => expect(state.calls).toEqual([CLOUD_DEPLOY, "install", "start"]), {
      timeout: 3000,
    });
  });

  it("leaves a stopped local app stopped", async () => {
    await show();
    const { user, dialog } = await redeploy();
    await user.click(within(dialog).getByRole("button", { name: "Update" }));
    await vi.waitFor(() => expect(state.calls).toEqual([CLOUD_DEPLOY, "install"]));
    await new Promise((r) => setTimeout(r, 50));
    expect(state.calls).toEqual([CLOUD_DEPLOY, "install"]);
  });

  describe("when only the local install is behind", () => {
    beforeEach(() => {
      cloudBehind = false;
      cloudCodeBehind = false;
    });

    function redeployBox(dialog: HTMLElement) {
      return within(dialog).getByRole("checkbox", {
        name: "Redeploy Dice in the cloud",
      }) as HTMLInputElement;
    }

    it("still offers the cloud redeploy, checked, and runs it before the local update", async () => {
      await show();
      const { user, dialog } = await redeploy();
      expect(checkbox(dialog, "on this computer").checked).toBe(true);
      expect(redeployBox(dialog).checked).toBe(true);
      expect(redeployBox(dialog).disabled).toBe(false);
      await user.click(within(dialog).getByRole("button", { name: "Update" }));
      await vi.waitFor(() => expect(state.calls).toEqual([CLOUD_DEPLOY, "install"]), {
        timeout: 3000,
      });
      // The route refuses a deploy while the local install is behind, unless
      // the dialog approved the folder's manifest.
      expect(state.cloudBodies[0]).toMatchObject({ surfaces: ["web"], approved: true });
    });

    it("redeploys the cloud alone when the operator unchecks the local install", async () => {
      await show();
      const { user, dialog } = await redeploy();
      await user.click(checkbox(dialog, "on this computer"));
      expect(within(dialog).getByText(SKEW_WARNING)).toBeTruthy();
      await user.click(within(dialog).getByRole("button", { name: "Update" }));
      await vi.waitFor(() => expect(state.calls).toEqual([CLOUD_DEPLOY]), { timeout: 3000 });
    });

    it("does not warn when the operator leaves the current cloud alone", async () => {
      await show();
      const { user, dialog } = await redeploy();
      await user.click(redeployBox(dialog));
      expect(within(dialog).queryByText(SKEW_WARNING)).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: "Update" }));
      await vi.waitFor(() => expect(state.calls).toEqual(["install"]), { timeout: 3000 });
    });
  });

  it("disables Update when the operator unchecks every install", async () => {
    await show();
    const { user, dialog } = await redeploy();
    await user.click(checkbox(dialog, "on this computer"));
    await user.click(checkbox(dialog, "in the cloud"));
    const update = within(dialog).getByRole("button", { name: "Update" }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
  });
});

// The cloud can never run an app whose folder manifest leaves out the cloud
// target, so the dialog offers no cloud choice, whatever the registry's state.
describe("Start on a local-only app while the cloud registry is unread", () => {
  const LOCAL_ONLY: LocalAppEntry = {
    ...CHANGED,
    manifest: { id: "dice", name: "Dice", version: "1.0.0", targets: ["local"] },
    folderManifest: { id: "dice", name: "Dice", version: "1.1.0", targets: ["local"] },
  };

  it.each([
    ["signed out", () => (state.signedIn = false)],
    ["still loading", () => (cloudList = "hang")],
    ["failing", () => (cloudList = "fail")],
  ])("offers the local install alone when the registry is %s", async (_case, arrange) => {
    arrange();
    render(
      <AppUpdateProvider cloudAdministered signedIn={state.signedIn}>
        <div data-testid="local">
          <LocalAppsSection
            apps={[LOCAL_ONLY]}
            refresh={async () => undefined}
            localOnline={true}
          />
        </div>
      </AppUpdateProvider>,
    );
    if (state.signedIn) {
      await vi.waitFor(() =>
        expect(fetch).toHaveBeenCalledWith("/api/apps/cloud/list", expect.anything()),
      );
    }
    await new Promise((r) => setTimeout(r, 50));
    const { dialog } = await start();
    expect(checkbox(dialog, "on this computer").checked).toBe(true);
    expect(within(dialog).queryByRole("checkbox", { name: /in the cloud/ })).toBeNull();
    expect(within(dialog).queryByText(SKEW_WARNING)).toBeNull();
  });
});
