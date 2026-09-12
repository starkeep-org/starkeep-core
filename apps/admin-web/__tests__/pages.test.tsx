/**
 * @vitest-environment jsdom
 *
 * The three pages render inside the shell, show their own sections, and
 * navigate between each other.
 *
 * Everything here goes through the real route table in `src/App.tsx` rather
 * than rendering a page component directly. That is what the route group used
 * to express — the header and the credential-refresh gate wrap every page — and
 * it is the part a routing change breaks. `MemoryRouter` supplies the history
 * so a test can start at any path and then click its way to another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { App } from "../src/App";

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

/** Mount the app at a path, the way a reload or a pasted URL arrives. */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", stubFetch());
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the dashboard", () => {
  it("renders both columns", async () => {
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Local" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cloud" })).toBeTruthy();
  });

  it("shows the built-in data server card with its offline state", async () => {
    renderAt("/");
    expect(await screen.findByText("Data Server")).toBeTruthy();
    expect(await screen.findByText(/local data server must be running/i)).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Start Data Server/ })).toBeTruthy();
  });

  it("offers exactly one thing to do with no cloud deployment: deploy one", async () => {
    renderAt("/");
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
    renderAt("/");
    expect(await screen.findByText(/list failed: 500/)).toBeTruthy();
  });
});

describe("the storage page", () => {
  it("renders its heading, its experimental badge and the retention section", async () => {
    renderAt("/storage");
    expect(await screen.findByRole("heading", { name: "Storage" })).toBeTruthy();
    expect(screen.getByText("Experimental")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Retention & budgets/i })).toBeTruthy();
  });

  it("links back to the dashboard", async () => {
    renderAt("/storage");
    const back = await screen.findByRole("link", { name: /← Dashboard/ });
    expect(back.getAttribute("href")).toBe("/");
  });
});

describe("the cloud-setup page", () => {
  it("renders the wizard inside it", async () => {
    renderAt("/cloud-setup");
    expect(await screen.findByRole("heading", { name: "Cloud Setup" })).toBeTruthy();
    // The wizard resumes from the config before it renders its steps.
    expect(await screen.findByText("Steps")).toBeTruthy();
  });

  it("links back to the dashboard", async () => {
    renderAt("/cloud-setup");
    const back = await screen.findByRole("link", { name: /← Dashboard/ });
    expect(back.getAttribute("href")).toBe("/");
  });

  it("starts at step 1 for a machine with no cloud configured", async () => {
    renderAt("/cloud-setup");
    expect(await screen.findByRole("heading", { name: "Bootstrap Stack" })).toBeTruthy();
  });
});

describe("the shell around all three", () => {
  it("renders its header above whichever page is mounted", async () => {
    renderAt("/storage");
    expect(await screen.findByText("Starkeep Admin")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Storage" })).toBeTruthy();
  });

  it("puts the home link on the product name, which is the only nav it has", async () => {
    renderAt("/storage");
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
    renderAt("/storage");
    expect(screen.queryByRole("heading", { name: "Storage" })).toBeNull();
    resolveConfig(Response.json({ config: null }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Storage" })).toBeTruthy());
  });
});

describe("navigating between the three pages", () => {
  it("reaches cloud-setup from the dashboard", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await user.click(await screen.findByRole("link", { name: /Deploy Starkeep Cloud/ }));
    expect(await screen.findByRole("heading", { name: "Cloud Setup" })).toBeTruthy();
  });

  it("comes back to the dashboard from cloud-setup", async () => {
    const user = userEvent.setup();
    renderAt("/cloud-setup");
    await user.click(await screen.findByRole("link", { name: /← Dashboard/ }));
    expect(await screen.findByRole("heading", { name: "Local" })).toBeTruthy();
  });

  it("comes back to the dashboard from storage", async () => {
    const user = userEvent.setup();
    renderAt("/storage");
    await user.click(await screen.findByRole("link", { name: /← Dashboard/ }));
    expect(await screen.findByRole("heading", { name: "Local" })).toBeTruthy();
  });

  it("keeps the shell mounted across a navigation", async () => {
    // The gate is a layout route, so moving between pages must not unmount it
    // and re-run the credential refresh it starts.
    const user = userEvent.setup();
    const fetchSpy = stubFetch();
    vi.stubGlobal("fetch", fetchSpy);
    renderAt("/");
    await screen.findByRole("heading", { name: "Local" });
    const configReadsBefore = fetchSpy.mock.calls.filter(([u]) =>
      String(u).includes("/api/config"),
    ).length;

    await user.click(await screen.findByRole("link", { name: /Deploy Starkeep Cloud/ }));
    await screen.findByRole("heading", { name: "Cloud Setup" });
    expect(screen.getByText("Starkeep Admin")).toBeTruthy();

    // The wizard reads the config for itself; the gate must not have read it
    // again on top of that.
    const gateReadsAfter = fetchSpy.mock.calls.filter(([u]) =>
      String(u).includes("/api/config"),
    ).length;
    expect(gateReadsAfter).toBeLessThanOrEqual(configReadsBefore + 1);
  });
});
