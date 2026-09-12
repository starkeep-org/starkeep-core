/**
 * @vitest-environment jsdom
 *
 * The three pages render, show their own sections, and link to each other.
 *
 * Nothing rendered any page or any component before this file, and the
 * framework migration rewrites routing and layout wiring in most of them. These
 * are smoke tests on purpose: what they hold is that each page mounts without
 * throwing, that the sections a reader looks for are present, and that the
 * navigation between them carries the hrefs it should. Behavior inside the
 * components is the components' own to test.
 *
 * `next/link` and `next/navigation` are stubbed because they are exactly what
 * the migration replaces. A stub that renders a plain anchor is also what
 * react-router's `<Link>` renders, so the href assertions survive the swap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

const push = vi.fn();

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

/**
 * Every network call the pages make, answered with the shape of a machine that
 * has nothing set up yet: no cloud, no data server, no apps. That is the state
 * a fresh install is in, and the one the pages have to render without a cloud
 * config, a session or a daemon.
 */
function stubFetch(routes: Record<string, unknown> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) return Response.json(body);
    }
    if (url.includes("/api/apps/list")) return Response.json({ apps: [] });
    if (url.includes("/api/config")) return Response.json({ config: null });
    if (url.includes("/api/runtime-config")) {
      return Response.json({
        localDataServerUrl: "http://127.0.0.1:9820",
        driveUrl: "http://localhost:9830",
      });
    }
    // The local data server, which is not running.
    throw new TypeError("fetch failed");
  });
}

beforeEach(() => {
  push.mockReset();
  vi.stubGlobal("fetch", stubFetch());
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the dashboard", () => {
  it("renders both columns", async () => {
    const { default: DashboardPage } = await import("../app/(shell)/page");
    render(<DashboardPage />);
    expect(await screen.findByRole("heading", { name: "Local" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cloud" })).toBeTruthy();
  });

  it("shows the built-in data server card with its offline state", async () => {
    const { default: DashboardPage } = await import("../app/(shell)/page");
    render(<DashboardPage />);
    expect(await screen.findByText("Data Server")).toBeTruthy();
    expect(
      await screen.findByText(/local data server must be running/i),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Start Data Server/ })).toBeTruthy();
  });

  it("offers exactly one thing to do with no cloud deployment: deploy one", async () => {
    const { default: DashboardPage } = await import("../app/(shell)/page");
    render(<DashboardPage />);
    const deploy = await screen.findByRole("link", { name: /Deploy Starkeep Cloud/ });
    expect(deploy.getAttribute("href")).toBe("/cloud-setup");
  });

  it("surfaces a failed app list rather than rendering an empty library", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/api/apps/list")) return new Response("nope", { status: 500 });
        if (url.includes("/api/config")) return Response.json({ config: null });
        if (url.includes("/api/runtime-config")) {
          return Response.json({
            localDataServerUrl: "http://127.0.0.1:9820",
            driveUrl: "http://localhost:9830",
          });
        }
        throw new TypeError("fetch failed");
      }),
    );
    const { default: DashboardPage } = await import("../app/(shell)/page");
    render(<DashboardPage />);
    expect(await screen.findByText(/list failed: 500/)).toBeTruthy();
  });
});

describe("the storage page", () => {
  it("renders its heading, its experimental badge and the retention section", async () => {
    const { default: StoragePage } = await import("../app/(shell)/storage/page");
    render(<StoragePage />);
    expect(screen.getByRole("heading", { name: "Storage" })).toBeTruthy();
    expect(screen.getByText("Experimental")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Retention & budgets/i })).toBeTruthy();
  });

  it("links back to the dashboard", async () => {
    const { default: StoragePage } = await import("../app/(shell)/storage/page");
    render(<StoragePage />);
    expect(screen.getByRole("link", { name: /Dashboard/ }).getAttribute("href")).toBe("/");
  });
});

describe("the cloud-setup page", () => {
  it("renders the wizard inside it", async () => {
    const { default: CloudSetupPage } = await import("../app/(shell)/cloud-setup/page");
    render(<CloudSetupPage />);
    expect(screen.getByRole("heading", { name: "Cloud Setup" })).toBeTruthy();
    // The wizard resumes from the config before it renders its steps.
    expect(await screen.findByText("Steps")).toBeTruthy();
  });

  it("links back to the dashboard", async () => {
    const { default: CloudSetupPage } = await import("../app/(shell)/cloud-setup/page");
    render(<CloudSetupPage />);
    expect(screen.getByRole("link", { name: /Dashboard/ }).getAttribute("href")).toBe("/");
  });

  it("starts at step 1 for a machine with no cloud configured", async () => {
    const { default: CloudSetupPage } = await import("../app/(shell)/cloud-setup/page");
    render(<CloudSetupPage />);
    expect(await screen.findByRole("heading", { name: "Bootstrap Stack" })).toBeTruthy();
  });
});

describe("the shell around all three", () => {
  it("renders its header and the page inside it", async () => {
    const { default: ShellLayout } = await import("../app/(shell)/layout");
    render(
      <ShellLayout>
        <p>page body</p>
      </ShellLayout>,
    );
    expect(await screen.findByText("Starkeep Admin")).toBeTruthy();
    expect(screen.getByText("page body")).toBeTruthy();
  });

  it("puts the home link on the product name, which is the only nav it has", async () => {
    const { default: ShellLayout } = await import("../app/(shell)/layout");
    render(
      <ShellLayout>
        <p>page body</p>
      </ShellLayout>,
    );
    const header = (await screen.findByText("Starkeep Admin")).closest("a");
    expect(header?.getAttribute("href")).toBe("/");
  });

  it("shows a loading state until it has read the cloud config", async () => {
    // The gate starts credential refresh before rendering anything, so a page
    // is never painted against a session it has not resolved yet.
    let resolveConfig: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: RequestInfo | URL) =>
          new Promise<Response>((resolve) => {
            const url = typeof input === "string" ? input : (input as Request).url;
            if (url.includes("/api/config")) resolveConfig = resolve;
          }),
      ),
    );
    const { default: ShellLayout } = await import("../app/(shell)/layout");
    render(
      <ShellLayout>
        <p>page body</p>
      </ShellLayout>,
    );
    expect(screen.queryByText("page body")).toBeNull();
    resolveConfig(Response.json({ config: null }));
    await waitFor(() => expect(screen.getByText("page body")).toBeTruthy());
  });
});

describe("navigation between the three pages", () => {
  it("reaches cloud-setup from the dashboard and the dashboard from both others", async () => {
    const { default: DashboardPage } = await import("../app/(shell)/page");
    const { default: StoragePage } = await import("../app/(shell)/storage/page");
    const { default: CloudSetupPage } = await import("../app/(shell)/cloud-setup/page");

    const dashboard = render(<DashboardPage />);
    expect(
      (await within(dashboard.container).findByRole("link", { name: /Deploy Starkeep Cloud/ }))
        .getAttribute("href"),
    ).toBe("/cloud-setup");
    cleanup();

    const storage = render(<StoragePage />);
    expect(
      within(storage.container).getByRole("link", { name: /Dashboard/ }).getAttribute("href"),
    ).toBe("/");
    cleanup();

    const setup = render(<CloudSetupPage />);
    expect(
      within(setup.container).getByRole("link", { name: /Dashboard/ }).getAttribute("href"),
    ).toBe("/");
  });
});
