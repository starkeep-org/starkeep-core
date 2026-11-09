/**
 * @vitest-environment jsdom
 *
 * Hide on the Dashboard, through the real route table: Hide removes the example
 * app's folder from Discover apps, and an installed app's card never goes with
 * it. With a cloud-only install, the local card goes and the cloud tile stays.
 * With no install, both go.
 *
 * The app list and the cloud registry are stubbed at fetch. The Cognito
 * exchange is mocked; the pages and sections are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { LocalAppEntry } from "../src/lib/app-types";

vi.mock("@/lib/cognito-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/cognito-auth")>()),
  refreshTokens: async () => ({ idToken: "id", refreshToken: "refresh" }),
  getIdentityPoolCredentials: async () => ({
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    sessionToken: "token",
  }),
}));

const { App } = await import("../src/App");

const EXAMPLE_DIR = "/core/example-app";

const example: LocalAppEntry = {
  appId: "example-app",
  sourceDir: EXAMPLE_DIR,
  configuredDir: EXAMPLE_DIR,
  bundledExample: true,
  status: "not_installed",
  manifest: {
    id: "example-app",
    name: "Example App",
    version: "0.1.0",
    targets: ["local", "cloud"],
    infraRequirements: { compute: { enabled: true } },
  },
} as LocalAppEntry;

/** Whether the example app's folder is still in Discover apps. */
let folderListed: boolean;
/** The cloud registry's rows. */
let cloudRows: Array<Record<string, unknown>>;

beforeEach(() => {
  folderListed = true;
  cloudRows = [];
  localStorage.clear();
  localStorage.setItem("starkeep:cognito-session", JSON.stringify({ refreshToken: "refresh" }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/config" && init?.method === "PATCH") {
        folderListed = false;
        return Response.json({ config: {} });
      }
      if (url.startsWith("/api/config")) {
        return Response.json({
          config: {
            apiGatewayUrl: "https://api.example",
            publicBaseUrl: "https://d1.cloudfront.net",
            userPoolId: "us-east-2_pool",
            appParentDirs: folderListed ? [EXAMPLE_DIR] : [],
          },
        });
      }
      if (url.startsWith("/api/apps/list")) {
        return Response.json({ apps: folderListed ? [example] : [], problems: [], dirs: [] });
      }
      if (url.startsWith("/api/apps/cloud/list")) return Response.json({ apps: cloudRows });
      // Everything else, the local data server among it, is not running.
      throw new TypeError("fetch failed");
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The cards titled `name`, local and cloud. */
function cards(name: string): HTMLElement[] {
  return screen
    .queryAllByText(name, { selector: "[data-slot=card-title] > span" })
    .map((el) => el.closest("[data-slot=card]") as HTMLElement);
}

async function hide() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
  await vi.waitFor(() => expect(cards("Example App")).toHaveLength(2));
  const user = userEvent.setup();
  const local = cards("Example App").find((c) =>
    within(c).queryByRole("button", { name: "More actions for Example App" }),
  )!;
  await user.click(within(local).getByRole("button", { name: "More actions for Example App" }));
  await user.click(await screen.findByRole("menuitem", { name: "Hide" }));
}

describe("Hide on the Dashboard", () => {
  it("keeps the cloud tile of a cloud-only install, and drops the local card", async () => {
    cloudRows = [
      {
        appId: "example-app",
        name: "Example App",
        version: "0.1.0",
        webApp: true,
        mobileApp: false,
      },
    ];
    await hide();
    await vi.waitFor(() =>
      expect(
        screen.queryByText("Installed in the cloud. Its folder is not in Discover apps."),
      ).not.toBeNull(),
    );
    const [tile] = cards("Example App");
    expect(cards("Example App")).toHaveLength(1);
    expect(within(tile!).getByText("Installed")).toBeTruthy();
    expect(within(tile!).getByRole("link", { name: "Open Example App ↗" })).toBeTruthy();
  });

  it("drops both cards when the app is installed nowhere", async () => {
    await hide();
    await vi.waitFor(() => expect(cards("Example App")).toHaveLength(0));
  });
});
