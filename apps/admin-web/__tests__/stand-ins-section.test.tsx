/**
 * @vitest-environment jsdom
 *
 * The Storage page's stand-in section.
 *
 * The section edits this node's sync-down ceilings, shows the backlog, and runs
 * "Free up space" — an estimate first, then the removal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StandInsSection } from "../src/components/StandInsSection";

const STAND_INS = {
  ceilings: { image: 2560, video: null },
  configured: {},
  defaults: { image: 2560, video: null },
  standardSizes: { image: [320, 640, 1280, 2560], video: [2000] },
  canonicalThresholds: { image: 4272, video: 4800 },
  heldBytes: {
    image: { originals: 3 * 1024 ** 3, standIns: 200 * 1024 ** 2 },
    video: { originals: 0, standIns: 0 },
  },
  keepOriginals: false,
  libraryOriginals: {
    image: { count: 1000, bytes: 8 * 1024 ** 3 },
    video: { count: 0, bytes: 0 },
  },
  backlog: {
    "missing-canonical": { count: 42, complete: true },
    "missing-fidelity": { count: 7, complete: false },
  },
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];

function stubFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  calls = [];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the stand-in section", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET /api/residency/stand-ins": () => ({ body: STAND_INS }),
        "PUT /api/residency/stand-ins": () => ({ body: { ok: true } }),
        "POST /api/residency/free-up-space": (call) => {
          const dryRun = (call.body as { dryRun: boolean }).dryRun;
          return {
            body: {
              requestedBytes: 10 * 1024 ** 3,
              freedBytes: 2 * 1024 ** 3,
              removed: [{ recordId: "a", sizeBytes: 2 * 1024 ** 3, kind: "original" }],
              refused: [{ recordId: "b", sizeBytes: 1024, kind: "original", reason: "not-durable", detail: "" }],
              eligibleBytes: 3 * 1024 ** 3,
              dryRun,
              cloudReachable: true,
            },
          };
        },
      }),
    );
  });

  it("shows the ceilings in force, what is held against them, and the backlog", async () => {
    render(<StandInsSection />);
    const image = (await screen.findByLabelText("Ceiling for Photos")) as HTMLSelectElement;
    expect(image.value).toBe("2560");
    expect((screen.getByLabelText("Ceiling for Videos") as HTMLSelectElement).value).toBe("none");
    expect(screen.getByText("3 GiB")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    // A walk that stopped at its limit is stated as a lower bound.
    expect(screen.getByText("at least 7")).toBeTruthy();
  });

  it("reports a replacement's progress and originals keeping an earlier value", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET /api/residency/stand-ins": () => ({
          body: {
            ...STAND_INS,
            backlog: { ...STAND_INS.backlog, "canonical-outdated": { count: 12, complete: true } },
            restamp: { running: true, categories: ["image"], total: 900, restamped: 300, promoted: 0 },
            earlierThreshold: { image: 0, video: 4 },
          },
        }),
      }),
    );
    render(<StandInsSection />);
    expect(await screen.findByText(/waiting for a replacement canonical stand-in/)).toBeTruthy();
    expect(screen.getByText("Replacing canonical stand-ins: 300 of 900 originals updated.")).toBeTruthy();
    expect(screen.getByText(/4 videos keep the archived quality they were saved with\./)).toBeTruthy();
  });

  it("offers the standard sizes and the canonical size", async () => {
    render(<StandInsSection />);
    const image = await screen.findByLabelText("Ceiling for Photos");
    const options = within(image).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      "none — on demand only",
      "320 px",
      "640 px",
      "1280 px",
      "2560 px",
      "4272 px (canonical)",
    ]);
    const video = screen.getByLabelText("Ceiling for Videos");
    expect(within(video).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "none — on demand only",
      "2000 kbps",
      "4800 kbps (canonical)",
    ]);
  });

  it("offers a ceiling for photos and videos only, and saves what is shown", async () => {
    const user = userEvent.setup();
    render(<StandInsSection />);
    const save = await screen.findByRole("button", { name: "Save ceilings" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Kind of node")).toBeNull();
    expect(screen.queryByLabelText("Ceiling for Audio")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Ceiling for Photos"), "1280");
    await user.selectOptions(screen.getByLabelText("Ceiling for Videos"), "2000");
    await user.click(save);

    await screen.findByText(/restarts to apply/);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ ceilings: { image: 1280, video: 2000 } });
  });

  it("estimates what keeping originals downloads, and saves only that setting", async () => {
    const user = userEvent.setup();
    render(<StandInsSection />);
    const save = (await screen.findByRole("button", { name: "Save" })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await user.click(screen.getByLabelText("Keep every original on this machine"));
    // 8 GiB of originals in the library, 3 GiB of them already here.
    expect((await screen.findByRole("status")).textContent).toBe(
      "About 5 GiB of originals to download.",
    );
    await user.click(save);

    await screen.findByText(/restarts to apply it/);
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ keepOriginals: true });
    expect(save.disabled).toBe(true);
  });

  it("shows the daemon's reasons when it refuses the ceilings", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET /api/residency/stand-ins": () => ({ body: STAND_INS }),
        "PUT /api/residency/stand-ins": () => ({
          status: 422,
          body: { problems: ["video: a ceiling is a positive whole fidelity, or null for none"] },
        }),
      }),
    );
    const user = userEvent.setup();
    render(<StandInsSection />);
    await user.selectOptions(await screen.findByLabelText("Ceiling for Videos"), "2000");
    await user.click(screen.getByRole("button", { name: "Save ceilings" }));
    expect(await screen.findByText(/positive whole fidelity/)).toBeTruthy();
  });

  it("frees space only from an estimate, and reports what each did", async () => {
    const user = userEvent.setup();
    render(<StandInsSection />);
    const free = (await screen.findByRole("button", { name: "Free up space" })) as HTMLButtonElement;
    expect(free.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Estimate" }));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /^Would free 2 GiB from 1 file\(s\) of 3 GiB eligible\. Kept 1 that the cloud/,
    );
    expect(calls.at(-1)!.body).toEqual({ bytes: 10 * 1024 ** 3, scope: "originals", dryRun: true });

    await user.click(free);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Freed 2 GiB/));
    expect(calls.at(-1)!.body).toMatchObject({ dryRun: false });
    // Spent: another removal needs another estimate.
    expect(free.disabled).toBe(true);
  });

  it("asks for a fresh estimate when the scope changes", async () => {
    const user = userEvent.setup();
    render(<StandInsSection />);
    await user.click(await screen.findByRole("button", { name: "Estimate" }));
    await screen.findByRole("status");
    await user.selectOptions(screen.getByLabelText("What to remove"), "originals-and-above-ceiling");
    expect((screen.getByRole("button", { name: "Free up space" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("says so when there is no cloud to prove anything against", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET /api/residency/stand-ins": () => ({ body: STAND_INS }),
        "POST /api/residency/free-up-space": () => ({
          body: {
            requestedBytes: 1,
            freedBytes: 0,
            removed: [],
            refused: [],
            eligibleBytes: 0,
            dryRun: true,
            cloudReachable: false,
          },
        }),
      }),
    );
    const user = userEvent.setup();
    render(<StandInsSection />);
    await user.click(await screen.findByRole("button", { name: "Estimate" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/not connected to a cloud/);
  });

  it("explains an offline data server rather than failing", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET /api/residency/stand-ins": () => ({ status: 503, body: { offline: true, error: "down" } }),
      }),
    );
    render(<StandInsSection />);
    expect(await screen.findByText(/isn't running/)).toBeTruthy();
  });
});
