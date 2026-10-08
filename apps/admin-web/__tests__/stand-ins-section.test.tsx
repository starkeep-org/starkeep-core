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

/**
 * "Free up space"'s own panel.
 *
 * Three operator passes on this page each offer an "Estimate" — the right word for
 * all three — so each one's section carries its name as a landmark and a case
 * addresses the one it means.
 */
async function freeUpSpacePanel() {
  return within(await screen.findByRole("region", { name: "Free up space" }));
}

async function panel(name: string) {
  return within(await screen.findByRole("region", { name }));
}

/** A reap report, with only what a case cares about overridden. */
function reapReport(over: Record<string, unknown> = {}) {
  return {
    keysConsidered: 3,
    reaped: [{ objectStorageKey: "k1", sizeBytes: 2 * 1024 ** 3 }],
    reclaimedBytes: 2 * 1024 ** 3,
    refused: [{ objectStorageKey: "k2", reason: "live-record", detail: "" }],
    retentionDays: 30,
    archivedSkipped: 0,
    dryRun: true,
    ...over,
  };
}

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
        "POST /api/residency/reap": (call) => ({
          body: reapReport({ dryRun: (call.body as { dryRun: boolean }).dryRun }),
        }),
        "POST /api/sync/verify": () => ({
          body: {
            channels: [
              {
                appId: "starkeep-drive",
                result: {
                  supported: true,
                  localRows: 120,
                  peerRows: 118,
                  divergentBuckets: 1,
                  missingLocally: 0,
                  pendingUpload: 0,
                  pendingDownload: 0,
                },
                error: null,
              },
            ],
          },
        }),
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
    // Scoped to its own section: three operator passes on this page each offer an
    // "Estimate", which is the right word for all three.
    const panel = await freeUpSpacePanel();
    const free = panel.getByRole("button", { name: "Free up space" }) as HTMLButtonElement;
    expect(free.disabled).toBe(true);

    await user.click(panel.getByRole("button", { name: "Estimate" }));
    expect((await panel.findByRole("status")).textContent).toMatch(
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
    const panel = await freeUpSpacePanel();
    await user.click(panel.getByRole("button", { name: "Estimate" }));
    await panel.findByRole("status");
    await user.selectOptions(screen.getByLabelText("What to remove"), "originals-and-above-ceiling");
    expect((panel.getByRole("button", { name: "Free up space" }) as HTMLButtonElement).disabled).toBe(
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
    const panel = await freeUpSpacePanel();
    await user.click(panel.getByRole("button", { name: "Estimate" }));
    expect((await panel.findByRole("status")).textContent).toMatch(/not connected to a cloud/);
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

  describe("reclaiming deleted files", () => {
    it("reclaims only from an estimate, like every other destructive pass", async () => {
      const user = userEvent.setup();
      render(<StandInsSection />);
      const reap = await panel("Reclaim deleted files");
      const run = reap.getByRole("button", { name: "Reclaim" }) as HTMLButtonElement;
      expect(run.disabled).toBe(true);

      await user.click(reap.getByRole("button", { name: "Estimate" }));
      expect((await reap.findByRole("status")).textContent).toMatch(
        /^Would reclaim 2 GiB from 1 file\(s\), of 3 deleted more than 30 days ago\. Kept 1\./,
      );
      expect(calls.at(-1)!.body).toEqual({ dryRun: true });

      await user.click(run);
      expect((await reap.findByRole("status")).textContent).toMatch(/^Reclaimed 2 GiB/);
      expect(calls.at(-1)!.body).toEqual({ dryRun: false });
      // Spent: another pass needs another estimate.
      expect(run.disabled).toBe(true);
    });

    it("says it does not know the window rather than reporting a clean run", async () => {
      // A host that cannot read the winning settings file reaps nothing, because
      // reaping to the default under a library whose owner chose a year would destroy
      // bytes the person was promised.
      vi.stubGlobal(
        "fetch",
        stubFetch({
          "GET /api/residency/stand-ins": () => ({ body: STAND_INS }),
          "POST /api/residency/reap": () => ({
            body: reapReport({
              retentionDays: null,
              reaped: [],
              reclaimedBytes: 0,
              refused: [],
              // The read says which of its ways of failing happened, so the
              // operator sees whether to wait for bytes or to fix a file.
              retentionProblems: ["the settings file's bytes have not reached this machine yet"],
            }),
          }),
        }),
      );
      const user = userEvent.setup();
      render(<StandInsSection />);
      const reap = await panel("Reclaim deleted files");
      await user.click(reap.getByRole("button", { name: "Estimate" }));
      const status = (await reap.findByRole("status")).textContent;
      expect(status).toMatch(/cannot read the library's settings file/);
      expect(status).toMatch(/bytes have not reached this machine/);
    });

    it("names the deep-archive exception, so its standing cost stays visible", async () => {
      vi.stubGlobal(
        "fetch",
        stubFetch({
          "GET /api/residency/stand-ins": () => ({ body: STAND_INS }),
          "POST /api/residency/reap": () => ({ body: reapReport({ archivedSkipped: 4 }) }),
        }),
      );
      const user = userEvent.setup();
      render(<StandInsSection />);
      const reap = await panel("Reclaim deleted files");
      await user.click(reap.getByRole("button", { name: "Estimate" }));
      expect((await reap.findByRole("status")).textContent).toMatch(
        /4 sit in deep archive, which charges a minimum storage period/,
      );
    });
  });

  describe("checking sync integrity", () => {
    it("reports each channel's counts and what diverged", async () => {
      const user = userEvent.setup();
      render(<StandInsSection />);
      const verify = await panel("Check sync integrity");
      await user.click(verify.getByRole("button", { name: "Check now" }));
      expect((await verify.findByRole("status")).textContent).toMatch(
        /starkeep-drive — 120 rows here, 118 in the cloud — 1 the cloud is missing/,
      );
    });

    it("says a peer that could not answer did not agree", async () => {
      // Reporting zero divergence for a peer that cannot answer the digest would read
      // as "verified", which is the one thing it is not.
      vi.stubGlobal(
        "fetch",
        stubFetch({
          "GET /api/residency/stand-ins": () => ({ body: STAND_INS }),
          "POST /api/sync/verify": () => ({
            body: {
              channels: [
                {
                  appId: "photos",
                  result: {
                    supported: false,
                    localRows: 0,
                    peerRows: 0,
                    divergentBuckets: 0,
                    missingLocally: 0,
                    pendingUpload: 0,
                    pendingDownload: 0,
                  },
                  error: null,
                },
              ],
            },
          }),
        }),
      );
      const user = userEvent.setup();
      render(<StandInsSection />);
      const verify = await panel("Check sync integrity");
      await user.click(verify.getByRole("button", { name: "Check now" }));
      expect((await verify.findByRole("status")).textContent).toMatch(
        /did not answer the check/,
      );
    });

    it("says so when no channel is running", async () => {
      vi.stubGlobal(
        "fetch",
        stubFetch({
          "GET /api/residency/stand-ins": () => ({ body: STAND_INS }),
          "POST /api/sync/verify": () => ({ body: { channels: [] } }),
        }),
      );
      const user = userEvent.setup();
      render(<StandInsSection />);
      const verify = await panel("Check sync integrity");
      await user.click(verify.getByRole("button", { name: "Check now" }));
      expect((await verify.findByRole("status")).textContent).toMatch(/No sync channels/);
    });
  });
});
