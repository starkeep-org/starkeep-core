/**
 * @vitest-environment jsdom
 *
 * "Quality kept when originals archive": the library's canonical thresholds,
 * on the Storage page and once in the install flow.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LibraryStandardsSection } from "../src/components/LibraryStandardsSection";
import { LocalAppsSection } from "../src/components/LocalAppsSection";
import type { LocalAppEntry } from "../src/lib/app-types";

const VIEW = {
  image: { canonicalThreshold: 4272, standardSizes: [320, 640, 1280, 2560], advisoryLongEdges: null },
  video: {
    canonicalThreshold: 4800,
    standardSizes: [2000],
    advisoryLongEdges: { canonical: 1920, bySize: { "2000": 1280 } },
  },
};

function standards(over: { set?: boolean; images?: number; videos?: number } = {}) {
  return {
    current: VIEW,
    defaults: VIEW,
    set: over.set ?? false,
    problems: [],
    knowsLibraryValue: true,
    ranges: {
      canonicalThreshold: { image: { min: 1280, max: 16384 }, video: { min: 1000, max: 50000 } },
      advisoryLongEdge: { min: 320, max: 7680 },
    },
    libraryOriginals: {
      image: { count: over.images ?? 0, bytes: (over.images ?? 0) * 4 * 1024 ** 2 },
      video: { count: over.videos ?? 0, bytes: (over.videos ?? 0) * 40 * 1024 ** 2 },
    },
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

function stubFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const route = Object.entries(routes).find(([key]) => `${call.method} ${url}` === key);
      if (!route) throw new TypeError(`fetch failed: ${call.method} ${url}`);
      const out = route[1](call);
      return Response.json(out.body, { status: out.status ?? 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const puts = () => calls.filter((c) => c.method === "PUT" && c.url === "/api/library/stand-in-standards");

describe("the library's quality section", () => {
  it("offers the standard choices with the default marked, and a custom value", async () => {
    stubFetch({ "GET /api/library/stand-in-standards": () => ({ body: standards() }) });
    render(<LibraryStandardsSection />);
    const photos = await screen.findByLabelText("Threshold for Photos");
    expect(within(photos).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "2560 px",
      "3200 px",
      "4272 px (default)",
      "5120 px",
      "6000 px",
      "8192 px",
      "Custom…",
    ]);
    const videos = screen.getByLabelText("Threshold for Videos");
    expect(within(videos).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "3000 kbps",
      "4800 kbps (default)",
      "8000 kbps",
      "12000 kbps",
      "Custom…",
    ]);
    expect(
      within(screen.getByLabelText("Resolution for the canonical video"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["720p", "1080p (default)", "1440p", "2160p"]);
  });

  it("refuses a custom value out of range before asking the daemon", async () => {
    stubFetch({ "GET /api/library/stand-in-standards": () => ({ body: standards() }) });
    const user = userEvent.setup();
    render(<LibraryStandardsSection />);
    await user.selectOptions(await screen.findByLabelText("Threshold for Photos"), "custom");
    const input = screen.getByLabelText("Custom threshold for Photos");
    await user.clear(input);
    await user.type(input, "900");
    expect(screen.getByText(/from 1280 to 16384 px/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(input);
    await user.type(input, "7000");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("states what an original count means in bytes", async () => {
    stubFetch({ "GET /api/library/stand-in-standards": () => ({ body: standards({ images: 1000 }) }) });
    render(<LibraryStandardsSection />);
    expect(await screen.findByText("The library holds 1,000 photos, 3.9 GiB of originals.")).toBeTruthy();
    expect(screen.getByText("The library holds no videos yet.")).toBeTruthy();
  });

  it("saves straight away while the library holds no originals of that kind", async () => {
    stubFetch({
      "GET /api/library/stand-in-standards": () => ({ body: standards() }),
      "PUT /api/library/stand-in-standards": () => ({ body: { ok: true } }),
    });
    const user = userEvent.setup();
    render(<LibraryStandardsSection />);
    await user.selectOptions(await screen.findByLabelText("Threshold for Photos"), "6000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/picks it up at its next sync/);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toMatchObject({ standIns: { image: { canonicalThreshold: 6000 } } });
  });

  it("explains that existing originals keep theirs before saving a change over them", async () => {
    stubFetch({
      "GET /api/library/stand-in-standards": () => ({ body: standards({ images: 1000 }) }),
      "PUT /api/library/stand-in-standards": () => ({ body: { ok: true } }),
    });
    const user = userEvent.setup();
    render(<LibraryStandardsSection />);
    await user.selectOptions(await screen.findByLabelText("Threshold for Photos"), "6000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Photos already in the library keep their current archived-quality copies/);
    expect(dialog.textContent).toMatch(/applies to originals added from now on/);
    expect(puts()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await screen.findByText(/picks it up at its next sync/);
    expect(puts()).toHaveLength(1);
  });

  it("saves a resolution change with no dialog, since it changes no original", async () => {
    stubFetch({
      "GET /api/library/stand-in-standards": () => ({ body: standards({ videos: 50 }) }),
      "PUT /api/library/stand-in-standards": () => ({ body: { ok: true } }),
    });
    const user = userEvent.setup();
    render(<LibraryStandardsSection />);
    await user.selectOptions(await screen.findByLabelText("Resolution for the 2000 kbps video"), "1920");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/picks it up at its next sync/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(puts()[0]!.body).toMatchObject({
      standIns: { video: { advisoryLongEdges: { canonical: 1920, bySize: { "2000": 1920 } } } },
    });
  });
});

describe("the install flow's quality step", () => {
  const photos: LocalAppEntry = {
    appId: "photos",
    sourceDir: "/apps/photos",
    status: "not_installed",
    manifest: {
      id: "photos",
      name: "Photos",
      infraRequirements: {
        fileAccess: [{ types: ["image/jpeg", "video/mp4"], access: "readwrite", rationale: "your photos" }],
      },
    },
  };
  const notes: LocalAppEntry = {
    ...photos,
    appId: "notes",
    manifest: {
      id: "notes",
      name: "Notes",
      infraRequirements: {
        fileAccess: [{ types: ["document/markdown"], access: "readwrite", rationale: "your notes" }],
      },
    },
  };

  function routes(body: ReturnType<typeof standards>) {
    stubFetch({
      "GET /api/library/stand-in-standards": () => ({ body }),
      "PUT /api/library/stand-in-standards": () => ({ body: { ok: true } }),
      "POST /api/apps/install": () => ({ body: { ok: true } }),
      "POST /api/apps/status": () => ({ body: {} }),
    });
  }

  async function openConsent(entry: LocalAppEntry) {
    const user = userEvent.setup();
    render(<LocalAppsSection apps={[entry]} refresh={async () => undefined} localOnline={true} />);
    await user.click(screen.getByRole("button", { name: `Install ${entry.manifest.name}` }));
    return user;
  }

  it("appears for a media app while the library holds none of its originals", async () => {
    routes(standards({ videos: 3 }));
    await openConsent(photos);
    expect(await screen.findByText("Quality kept when originals archive")).toBeTruthy();
    // Videos already exist, so only the photo row is asked about.
    expect(screen.getByLabelText("Threshold for Photos")).toBeTruthy();
    expect(screen.queryByLabelText("Threshold for Videos")).toBeNull();
  });

  it("stays away once the person has set a value, and for an app that reads no media", async () => {
    routes(standards({ set: true }));
    await openConsent(photos);
    await screen.findByRole("button", { name: "Approve & Install" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Quality kept when originals archive")).toBeNull();
    cleanup();

    routes(standards());
    await openConsent(notes);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Quality kept when originals archive")).toBeNull();
  });

  it("accepts the defaults with one click, writing no settings", async () => {
    routes(standards());
    const user = await openConsent(photos);
    await screen.findByText("Quality kept when originals archive");
    await user.click(screen.getByRole("button", { name: "Approve & Install" }));
    await vi.waitFor(() => expect(calls.some((c) => c.url === "/api/apps/install")).toBe(true));
    expect(puts()).toHaveLength(0);
  });

  it("saves a changed value before installing", async () => {
    routes(standards());
    const user = await openConsent(photos);
    await user.selectOptions(await screen.findByLabelText("Threshold for Photos"), "6000");
    await user.click(screen.getByRole("button", { name: "Approve & Install" }));
    await vi.waitFor(() => expect(calls.some((c) => c.url === "/api/apps/install")).toBe(true));
    const order = calls.map((c) => `${c.method} ${c.url}`);
    expect(order.indexOf("PUT /api/library/stand-in-standards")).toBeLessThan(order.indexOf("POST /api/apps/install"));
  });
});
