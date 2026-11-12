/**
 * @vitest-environment jsdom
 *
 * The cloud apps on the dashboard: one tile per surface an app's manifest
 * offers, what each tile says is installed, and which surface each of its
 * actions asks the installer for.
 *
 * The registry reports two surfaces per app, the cloud web app and the mobile
 * app. Each tile reads only its own column and installs only its own surface,
 * and the install route turns the surface into the installer's `--web` or
 * `--mobile` flag (`install-stream.test.ts`). The Cognito exchange and the
 * install stream are mocked; the section's own logic is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LocalAppEntry } from "../src/lib/app-types";

const installs = vi.hoisted(() => [] as Array<{ url: string; body: Record<string, unknown> }>);

vi.mock("@/lib/cloud-config", () => ({
  readCloudConfig: async () => ({
    region: "us-east-2",
    publicBaseUrl: "https://d1.cloudfront.net",
    cognitoConfig: {},
  }),
  readCognitoSession: async () => ({ refreshToken: "refresh" }),
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
    installs.push({ url, body });
    // Never settles: the dialog stays open on a running install.
    return new Promise(() => {});
  },
}));

const { CloudAppsSection } = await import("../src/components/CloudAppsSection");

/** What the registry answers for each app id. */
let registry: Array<{
  appId: string;
  webApp: boolean;
  mobileApp: boolean;
  name?: string | null;
  version?: string;
  manifest?: unknown;
}>;

beforeEach(() => {
  installs.length = 0;
  registry = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/apps/cloud/list") return Response.json({ apps: registry });
      return Response.json({ error: `unexpected ${url}` }, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function app(appId: string, name: string, offers: { web: boolean; mobile: boolean }) {
  return {
    appId,
    sourceDir: `/apps/${appId}`,
    status: "not_installed",
    manifest: {
      name,
      version: "0.1.0",
      targets: ["local", "cloud"],
      infraRequirements: { compute: { enabled: offers.web } },
      ...(offers.mobile
        ? {
            mobile: {
              android: {
                package: `app.starkeep.${appId}`,
                signingCertSha256: ["a".repeat(64)],
                callbackScheme: `starkeep-${appId}`,
              },
            },
          }
        : {}),
    },
  } as LocalAppEntry;
}

const PHOTOS = app("photos", "Photos", { web: true, mobile: true });
const MEMO = app("memo", "Memo", { web: true, mobile: false });

/** The tile named `name`. */
async function tile(name: string): Promise<HTMLElement> {
  const heading = await screen.findByText(name, { selector: "[data-slot=card-title] > span" });
  return heading.closest("[data-slot=card]") as HTMLElement;
}

/** Approves the open consent dialog. */
async function approve(): Promise<void> {
  await userEvent.setup().click(await screen.findByRole("button", { name: "Approve & Install" }));
}

/** The tile names on screen, in order. */
function tileNames(): string[] {
  return Array.from(document.querySelectorAll("[data-slot=card-title] > span:first-child")).map(
    (el) => el.textContent ?? "",
  );
}

async function renderWith(rows: typeof registry, apps: LocalAppEntry[] = [PHOTOS, MEMO]) {
  registry = rows;
  render(<CloudAppsSection apps={apps} />);
  // The registry read is what turns "Not installed" into its answer.
  await vi.waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/apps/cloud/list", expect.anything()),
  );
}

/** The labels in the tile's "More actions" menu, or none when it has no menu. */
async function menuLabels(name: string): Promise<string[]> {
  const trigger = within(await tile(name)).queryByRole("button", {
    name: `More actions for ${name}`,
  });
  if (!trigger) return [];
  await userEvent.setup().click(trigger);
  const items = await screen.findAllByRole("menuitem");
  const labels = items.map((item) => item.textContent ?? "");
  await userEvent.setup().keyboard("{Escape}");
  return labels;
}

/** Choose `label` from the tile's "More actions" menu. */
async function chooseFromMenu(name: string, label: string) {
  const user = userEvent.setup();
  await user.click(
    within(await tile(name)).getByRole("button", { name: `More actions for ${name}` }),
  );
  await user.click(await screen.findByRole("menuitem", { name: label }));
}

describe("tiles", () => {
  it("gives an app with compute and an Android build a web tile and a mobile tile", async () => {
    await renderWith([]);
    await tile("Photos Mobile");
    expect(tileNames()).toEqual(["Photos", "Photos Mobile", "Memo"]);
  });

  it("gives an app with an Android build and no compute only a mobile tile", async () => {
    await renderWith([], [app("photos", "Photos", { web: false, mobile: true })]);
    await tile("Photos Mobile");
    expect(tileNames()).toEqual(["Photos Mobile"]);
  });

  it("describes the mobile tile as the mobile app, and the web tile with the manifest's description", async () => {
    const described = {
      ...PHOTOS,
      manifest: { ...PHOTOS.manifest, description: "Your photos." },
    } as LocalAppEntry;
    await renderWith([], [described]);
    expect(within(await tile("Photos")).getByText("Your photos.")).toBeTruthy();
    expect(
      within(await tile("Photos Mobile")).getByText(
        "The Photos mobile app can sign in and sync with this cloud.",
      ),
    ).toBeTruthy();
  });
});

describe("badges", () => {
  it.each([
    [{ webApp: false, mobileApp: false }, "Not installed", "Not registered"],
    [{ webApp: true, mobileApp: false }, "Installed", "Not registered"],
    [{ webApp: false, mobileApp: true }, "Not installed", "Registered"],
    [{ webApp: true, mobileApp: true }, "Installed", "Registered"],
  ])("reads each tile's own registry column for %j", async (row, web, mobile) => {
    await renderWith([{ appId: "photos", ...row }]);
    await vi.waitFor(async () => {
      expect(within(await tile("Photos")).getByText(web)).toBeTruthy();
      expect(within(await tile("Photos Mobile")).getByText(mobile)).toBeTruthy();
    });
  });

  it("reads an app the registry does not list as neither installed nor registered", async () => {
    await renderWith([]);
    expect(within(await tile("Photos")).getByText("Not installed")).toBeTruthy();
    expect(within(await tile("Photos Mobile")).getByText("Not registered")).toBeTruthy();
  });
});

describe("the actions each tile offers", () => {
  it("offers only the primary action on tiles that are not installed", async () => {
    await renderWith([]);
    const web = await tile("Photos");
    expect(within(web).getByRole("button", { name: "Install Photos in cloud" })).toBeTruthy();
    const mobile = await tile("Photos Mobile");
    expect(within(mobile).getByRole("button", { name: "Register Photos Mobile" })).toBeTruthy();
    expect(await menuLabels("Photos")).toEqual([]);
    expect(await menuLabels("Photos Mobile")).toEqual([]);
  });

  it("opens an installed web app and offers a redeploy from the menu", async () => {
    await renderWith([{ appId: "photos", webApp: true, mobileApp: false }]);
    const link = await within(await tile("Photos")).findByRole("link", { name: "Open Photos ↗" });
    expect(link.getAttribute("href")).toBe("https://d1.cloudfront.net/apps/photos/");
    expect(await menuLabels("Photos")).toEqual(["Redeploy Photos"]);
  });

  it("gives a registered mobile app no primary action and offers a re-register from the menu", async () => {
    await renderWith([{ appId: "photos", webApp: false, mobileApp: true }]);
    await vi.waitFor(async () =>
      expect(within(await tile("Photos Mobile")).getByText("Registered")).toBeTruthy(),
    );
    expect(await menuLabels("Photos Mobile")).toEqual(["Re-register Photos Mobile"]);
    expect(
      within(await tile("Photos Mobile"))
        .queryAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual(["More actions for Photos Mobile"]);
  });
});

describe("an installed app whose folder no scanned folder holds", () => {
  const EXAMPLE = { appId: "example-app", name: "Example App", version: "0.2.0" };

  it("keeps a tile for each installed surface, from the registry row", async () => {
    await renderWith([{ ...EXAMPLE, webApp: true, mobileApp: true }], [MEMO]);
    await tile("Example App Mobile");
    expect(tileNames()).toEqual(["Memo", "Example App", "Example App Mobile"]);
    const web = await tile("Example App");
    expect(within(web).getByText("Installed")).toBeTruthy();
    expect(within(web).getByText("v0.2.0")).toBeTruthy();
    const link = within(web).getByRole("link", { name: "Open Example App ↗" });
    expect(link.getAttribute("href")).toBe("https://d1.cloudfront.net/apps/example-app/");
    const mobile = await tile("Example App Mobile");
    expect(within(mobile).getByText("Registered")).toBeTruthy();
    expect(within(mobile).queryByRole("link")).toBeNull();
  });

  it.each([
    ["Example App", "Redeploy Example App", "redeploy"],
    ["Example App Mobile", "Re-register Example App Mobile", "re-register"],
  ])("disables %s's %s, and says the folder is missing", async (name, label, verb) => {
    await renderWith([{ ...EXAMPLE, webApp: true, mobileApp: true }], []);
    const user = userEvent.setup();
    await user.click(
      within(await tile(name)).getByRole("button", { name: `More actions for ${name}` }),
    );
    const item = await screen.findByRole("menuitem", { name: label });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe(`Add the app's folder in Discover apps to ${verb}`);
    await user.click(item);
    expect(installs).toHaveLength(0);
  });

  it("shows no tile for a surface the registry row does not have", async () => {
    await renderWith([{ ...EXAMPLE, webApp: false, mobileApp: false }], [MEMO]);
    await tile("Memo");
    expect(tileNames()).toEqual(["Memo"]);
  });

  it("names the tile by the app id when the row has no name", async () => {
    await renderWith([{ ...EXAMPLE, name: null, webApp: true, mobileApp: false }], []);
    expect(await tile("example-app")).toBeTruthy();
    expect(screen.queryByText("No cloud apps found.")).toBeNull();
  });
});

describe("a locally installed app whose folder holds a manifest the user has not approved", () => {
  const DICE = app("dice", "Dice", { web: true, mobile: false });
  const CHANGED_TITLE =
    "Its folder holds a changed manifest. Choose Update from folder on its local card first";

  it("disables the cloud install, and says to update from the folder first", async () => {
    await renderWith([], [{ ...DICE, status: "active", sourceState: "changed" }]);
    const button = within(await tile("Dice")).getByRole("button", {
      name: "Install Dice in cloud",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.parentElement!.getAttribute("title")).toBe(CHANGED_TITLE);
  });

  it("disables the redeploy of an installed app", async () => {
    await renderWith(
      [{ appId: "dice", webApp: true, mobileApp: false }],
      [{ ...DICE, status: "active", sourceState: "changed" }],
    );
    const user = userEvent.setup();
    await user.click(
      within(await tile("Dice")).getByRole("button", { name: "More actions for Dice" }),
    );
    const item = await screen.findByRole("menuitem", { name: "Redeploy Dice" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe(CHANGED_TITLE);
    await user.click(item);
    expect(installs).toHaveLength(0);
  });
});

describe("the surface each action asks for, and the dialog it opens", () => {
  it.each([
    ["Photos", "Install Photos in cloud", ["web"], "Install Photos in cloud"],
    ["Photos Mobile", "Register Photos Mobile", ["mobile"], "Register Photos Mobile"],
  ])("%s's %s asks for %j", async (name, button, surfaces, title) => {
    const user = userEvent.setup();
    await renderWith([]);
    await user.click(await within(await tile(name)).findByRole("button", { name: button }));
    await approve();
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    expect(installs[0]).toMatchObject({
      url: "/api/apps/photos/cloud-install",
      body: { surfaces },
    });
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
  });

  it.each([
    ["Photos", "Redeploy Photos", ["web"], "Install Photos in cloud"],
    ["Photos Mobile", "Re-register Photos Mobile", ["mobile"], "Register Photos Mobile"],
  ])("%s's %s asks for %j alone", async (name, label, surfaces, title) => {
    await renderWith([{ appId: "photos", webApp: true, mobileApp: true }]);
    await vi.waitFor(async () =>
      expect(within(await tile("Photos Mobile")).getByText("Registered")).toBeTruthy(),
    );
    await chooseFromMenu(name, label);
    await approve();
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    expect(installs[0]!.body["surfaces"]).toEqual(surfaces);
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
  });
});

describe("one run at a time", () => {
  it("disables every tile's actions while a run is in progress", async () => {
    const user = userEvent.setup();
    await renderWith([{ appId: "memo", webApp: true, mobileApp: false }]);
    await vi.waitFor(async () =>
      expect(within(await tile("Memo")).getByText("Installed")).toBeTruthy(),
    );
    await user.click(
      await within(await tile("Photos")).findByRole("button", { name: "Install Photos in cloud" }),
    );
    await approve();
    // The mocked install never settles, so the run stays in progress.
    await screen.findByRole("heading", { name: "Install Photos in cloud" });

    // The open dialog hides the tiles from the accessibility tree.
    const register = within(await tile("Photos Mobile")).getByRole("button", {
      name: "Register Photos Mobile",
      hidden: true,
    });
    await vi.waitFor(() => expect((register as HTMLButtonElement).disabled).toBe(true));
    expect(register.parentElement!.getAttribute("title")).toBe("Another cloud install is running");
    const install = within(await tile("Photos")).getByRole("button", {
      name: "Install Photos in cloud",
      hidden: true,
    });
    expect((install as HTMLButtonElement).disabled).toBe(true);
    expect(installs).toHaveLength(1);
  });
});

describe("consent before a cloud install", () => {
  const SHARING = {
    ...PHOTOS,
    manifest: {
      ...PHOTOS.manifest,
      infraRequirements: {
        compute: { enabled: true },
        fileAccess: [{ types: ["image/jpeg"], access: "read" as const }],
        publicSharing: true,
      },
    },
  } as LocalAppEntry;

  it("shows what an app asks for before installing one that was never approved locally", async () => {
    const user = userEvent.setup();
    await renderWith([], [SHARING]);
    await user.click(
      await within(await tile("Photos")).findByRole("button", { name: "Install Photos in cloud" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Install Photos in the cloud?" }),
    ).toBeTruthy();
    expect(screen.getByText("asks for access to these files.", { exact: false })).toBeTruthy();
    expect(screen.getByText("Images")).toBeTruthy();
    expect(screen.getByText("Public links")).toBeTruthy();
    expect(installs).toHaveLength(0);

    await approve();
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    expect(installs[0]!.body["surfaces"]).toEqual(["web"]);
  });

  it("installs nothing when the person cancels", async () => {
    const user = userEvent.setup();
    await renderWith([], [SHARING]);
    await user.click(
      await within(await tile("Photos")).findByRole("button", { name: "Install Photos in cloud" }),
    );
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Install Photos in the cloud?" })).toBeNull();
    expect(installs).toHaveLength(0);
  });

  it("asks before registering a mobile app too, since its grants are the app's", async () => {
    const user = userEvent.setup();
    await renderWith([], [SHARING]);
    await user.click(
      await within(await tile("Photos Mobile")).findByRole("button", {
        name: "Register Photos Mobile",
      }),
    );
    expect(await screen.findByRole("heading", { name: "Register Photos Mobile?" })).toBeTruthy();
    expect(installs).toHaveLength(0);
  });

  it("redeploys without asking when the deployed manifest asks for the same access", async () => {
    await renderWith(
      [{ appId: "photos", webApp: true, mobileApp: false, manifest: SHARING.manifest }],
      [SHARING],
    );
    await vi.waitFor(async () =>
      expect(within(await tile("Photos")).getByText("Installed")).toBeTruthy(),
    );
    await chooseFromMenu("Photos", "Redeploy Photos");
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: "Install Photos in the cloud?" })).toBeNull();
  });

  it("registers a second surface without asking when the first one's manifest covers it", async () => {
    const user = userEvent.setup();
    await renderWith(
      [{ appId: "photos", webApp: true, mobileApp: false, manifest: SHARING.manifest }],
      [SHARING],
    );
    await user.click(
      await within(await tile("Photos Mobile")).findByRole("button", {
        name: "Register Photos Mobile",
      }),
    );
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    expect(installs[0]!.body["surfaces"]).toEqual(["mobile"]);
  });

  it("asks before a redeploy when the folder's manifest asks for more than the deployed one", async () => {
    const deployed = {
      ...SHARING.manifest,
      infraRequirements: { compute: { enabled: true }, fileAccess: [] },
    };
    await renderWith(
      [{ appId: "photos", webApp: true, mobileApp: false, manifest: deployed }],
      [SHARING],
    );
    await vi.waitFor(async () =>
      expect(within(await tile("Photos")).getByText("Installed")).toBeTruthy(),
    );
    await chooseFromMenu("Photos", "Redeploy Photos");
    expect(
      await screen.findByRole("heading", { name: "Install Photos in the cloud?" }),
    ).toBeTruthy();
    expect(installs).toHaveLength(0);
  });

  it("asks before a redeploy when the registry row predates the recorded manifest", async () => {
    await renderWith([{ appId: "photos", webApp: true, mobileApp: false }], [SHARING]);
    await vi.waitFor(async () =>
      expect(within(await tile("Photos")).getByText("Installed")).toBeTruthy(),
    );
    await chooseFromMenu("Photos", "Redeploy Photos");
    expect(
      await screen.findByRole("heading", { name: "Install Photos in the cloud?" }),
    ).toBeTruthy();
    expect(installs).toHaveLength(0);
  });

  it("skips the dialog for an app installed locally, whose approved manifest the cloud deploys", async () => {
    const user = userEvent.setup();
    await renderWith([], [{ ...SHARING, status: "active" }]);
    await user.click(
      await within(await tile("Photos")).findByRole("button", { name: "Install Photos in cloud" }),
    );
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: "Install Photos in the cloud?" })).toBeNull();
  });
});
