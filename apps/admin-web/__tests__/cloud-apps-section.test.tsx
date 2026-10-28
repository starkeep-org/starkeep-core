/**
 * @vitest-environment jsdom
 *
 * The cloud apps on the dashboard: what each card says is installed, and which
 * surfaces each of its actions asks the installer for.
 *
 * The registry reports two surfaces per app, the cloud web app and the mobile
 * app. The badge, the "mobile app only" action and the surfaces a redeploy
 * keeps all follow from those two columns, and the install route turns the
 * surfaces into the installer's `--web` and `--mobile` flags
 * (`install-stream.test.ts`). The Cognito exchange and the install stream are
 * mocked; the section's own logic is real.
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
let registry: Array<{ appId: string; webApp: boolean; mobileApp: boolean }>;

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

function app(appId: string, name: string, shipsMobile: boolean): LocalAppEntry {
  return {
    appId,
    sourceDir: `/apps/${appId}`,
    status: "not_installed",
    manifest: {
      name,
      version: "0.1.0",
      targets: ["local", "cloud"],
      ...(shipsMobile
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

const PHOTOS = app("photos", "Photos", true);
const MEMO = app("memo", "Memo", false);

/** The card for `name`, once the registry has been read. */
async function card(name: string): Promise<HTMLElement> {
  const heading = await screen.findByText(name, { selector: "[data-slot=card-title] > span" });
  return heading.closest("[data-slot=card]") as HTMLElement;
}

async function renderWith(rows: typeof registry, apps: LocalAppEntry[] = [PHOTOS, MEMO]) {
  registry = rows;
  render(<CloudAppsSection apps={apps} />);
  // The registry read is what turns "Not installed" into its answer.
  await vi.waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/apps/cloud/list", expect.anything()),
  );
}

/** The labels in the card's "More actions" menu, or none when it has no menu. */
async function menuLabels(name: string): Promise<string[]> {
  const trigger = within(await card(name)).queryByRole("button", {
    name: `More actions for ${name}`,
  });
  if (!trigger) return [];
  await userEvent.setup().click(trigger);
  const items = await screen.findAllByRole("menuitem");
  const labels = items.map((item) => item.textContent ?? "");
  await userEvent.setup().keyboard("{Escape}");
  return labels;
}

describe("badges", () => {
  it("says Installed for the web app, Mobile app only for the mobile app alone, and Not installed for neither", async () => {
    await renderWith([
      { appId: "photos", webApp: false, mobileApp: true },
      { appId: "memo", webApp: true, mobileApp: false },
    ]);
    await vi.waitFor(async () => {
      expect(within(await card("Photos")).getByText("Mobile app only")).toBeTruthy();
      expect(within(await card("Memo")).getByText("Installed")).toBeTruthy();
    });
  });

  it("says Installed for an app with both surfaces", async () => {
    await renderWith([{ appId: "photos", webApp: true, mobileApp: true }]);
    await vi.waitFor(async () => {
      expect(within(await card("Photos")).getByText("Installed")).toBeTruthy();
    });
    expect(within(await card("Memo")).getByText("Not installed")).toBeTruthy();
  });

  it("calls a registered app with neither surface Not installed", async () => {
    await renderWith([{ appId: "photos", webApp: false, mobileApp: false }]);
    await vi.waitFor(async () => {
      expect(within(await card("Photos")).getByText("Not installed")).toBeTruthy();
    });
  });
});

describe("the mobile-app-only action", () => {
  it("is offered for an app that ships a mobile build and has neither surface", async () => {
    await renderWith([]);
    await vi.waitFor(async () =>
      expect(await menuLabels("Photos")).toEqual(["Register the Photos mobile app only"]),
    );
    // Memo ships no mobile build.
    expect(await menuLabels("Memo")).toEqual([]);
  });

  it("is not offered once the mobile app is installed", async () => {
    await renderWith([{ appId: "photos", webApp: false, mobileApp: true }]);
    await vi.waitFor(async () =>
      expect(within(await card("Photos")).getByText("Mobile app only")).toBeTruthy(),
    );
    expect(await menuLabels("Photos")).toEqual([]);
  });

  it("is not offered once the web app is installed, which a full install pairs with the mobile app", async () => {
    await renderWith([{ appId: "photos", webApp: true, mobileApp: false }]);
    await vi.waitFor(async () =>
      expect(within(await card("Photos")).getByText("Installed")).toBeTruthy(),
    );
    expect(await menuLabels("Photos")).toEqual(["Redeploy Photos"]);
  });

  it("asks the installer for the mobile app alone", async () => {
    const user = userEvent.setup();
    await renderWith([]);
    await vi.waitFor(async () =>
      expect(await menuLabels("Photos")).toEqual(["Register the Photos mobile app only"]),
    );
    await user.click(
      within(await card("Photos")).getByRole("button", { name: "More actions for Photos" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Register the Photos mobile app only" }),
    );
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    expect(installs[0]).toMatchObject({
      url: "/api/apps/photos/cloud-install",
      body: { surfaces: ["mobile"] },
    });
    expect(
      await screen.findByRole("heading", { name: "Register the Photos mobile app" }),
    ).toBeTruthy();
  });
});

describe("the surfaces each install asks for", () => {
  it("names no surfaces on a first install, so the installer installs every one", async () => {
    const user = userEvent.setup();
    await renderWith([]);
    await user.click(
      await within(await card("Photos")).findByRole("button", { name: "Install Photos in cloud" }),
    );
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    expect(installs[0]!.body).not.toHaveProperty("surfaces");
    expect(await screen.findByRole("heading", { name: "Install Photos in cloud" })).toBeTruthy();
  });

  it.each([
    [{ webApp: true, mobileApp: true }, ["web", "mobile"]],
    [{ webApp: true, mobileApp: false }, ["web"]],
  ])("keeps the installed surfaces on a redeploy of %j", async (surfaces, expected) => {
    const user = userEvent.setup();
    await renderWith([{ appId: "photos", ...surfaces }]);
    await vi.waitFor(async () =>
      expect(within(await card("Photos")).getByText("Installed")).toBeTruthy(),
    );
    await user.click(
      within(await card("Photos")).getByRole("button", { name: "More actions for Photos" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Redeploy Photos" }));
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    expect(installs[0]!.body["surfaces"]).toEqual(expected);
  });
});
