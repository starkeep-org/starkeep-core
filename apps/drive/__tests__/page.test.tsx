/**
 * @vitest-environment jsdom
 *
 * The page: the table, the sidebar and the live-update wiring.
 *
 * Two hundred lines of rendering and one `EventSource` subscription had no test
 * at all, and the subscription is the part a framework change can break without
 * changing a status code anywhere. `fetch` answers from fixtures and
 * `EventSource` is a stub the test can kick, so what is under test is the
 * component's own behaviour rather than the server's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { App as DrivePage } from "../src/App";

interface Row {
  id: string;
  type?: string;
  category?: string;
  origin_app_id?: string;
  updated_at?: string;
  size_bytes?: number | null;
  original_filename?: string | null;
  object_storage_key?: string | null;
  sync_status: string;
  cloud_availability?: string | null;
}

/** The last stub EventSource the page opened, so a test can kick it. */
let opened: StubEventSource[] = [];

class StubEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    opened.push(this);
  }
  close(): void {
    this.closed = true;
  }
  /** What an LDS kick looks like from the browser's side. */
  kick(): void {
    this.onmessage?.(new MessageEvent("message", { data: "" }));
  }
}

/** What each route answers. Reassigned per test. */
let typesBody: unknown;
let recordsBody: unknown;
let recordsStatus = 200;
/** Every /api/records URL the page asked for, in order. */
let recordsCalls: string[] = [];
let linksBody: unknown;
/** Every write to /api/public-links, with its body. */
let linkWrites: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
let createStatus = 201;
let createBody: unknown;

function row(over: Partial<Row> = {}): Row {
  return {
    id: "rec-1",
    type: "image/png",
    category: "image",
    origin_app_id: "starkeep-photos",
    updated_at: "2026-01-01T00:00:00Z",
    size_bytes: 2048,
    original_filename: "holiday.png",
    object_storage_key: "obj/abc",
    sync_status: "synced",
    ...over,
  };
}

beforeEach(() => {
  opened = [];
  recordsCalls = [];
  recordsStatus = 200;
  typesBody = { types: [{ record_type: "image/png", count: 1 }], cloud: { available: true } };
  recordsBody = { records: [row()], cloud: { available: true } };
  linksBody = { available: true, mayPublish: true, links: [] };
  linkWrites = [];
  createStatus = 201;
  createBody = {
    link: {
      id: "s-1",
      recordId: "rec-1",
      serves: "stand-in",
      title: "holiday.png",
      url: "https://d1.cloudfront.net/public-shares/TTTTTTTTTTTTTTTTTTTTTT/file",
      createdAtMs: 1,
      expiresAtMs: null,
    },
  };

  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith("/api/types")) return Response.json(typesBody);
      if (input.startsWith("/api/public-links")) {
        if (!init?.method || init.method === "GET") return Response.json(linksBody);
        linkWrites.push({
          method: init.method,
          url: input,
          body: JSON.parse((init.body as string | undefined) ?? "{}") as Record<string, unknown>,
        });
        return Response.json(createBody, { status: createStatus });
      }
      recordsCalls.push(input);
      return Response.json(recordsBody, { status: recordsStatus });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the records table", () => {
  it("lists a record with its origin app, sync badge and size", async () => {
    render(<DrivePage />);

    const tr = await screen.findByRole("row", { name: /holiday\.png/ });
    expect(within(tr).getByText("Synced")).toBeDefined();
    expect(within(tr).getByText("starkeep-photos")).toBeDefined();
    expect(within(tr).getByText("2.0 KB")).toBeDefined();
  });

  it("links the name to the bytes when the file is on this device", async () => {
    render(<DrivePage />);

    const link = await screen.findByRole("link", { name: "holiday.png" });
    expect(link.getAttribute("href")).toBe("/api/records/rec-1/file?type=image%2Fpng");
  });

  it("leaves a cloud-only row unlinked, because its bytes are not here", async () => {
    recordsBody = {
      records: [row({ sync_status: "cloud-only", original_filename: "remote.png" })],
      cloud: { available: true },
    };
    render(<DrivePage />);

    await screen.findByRole("row", { name: /remote\.png/ });
    expect(screen.queryByRole("link", { name: "remote.png" })).toBeNull();
  });

  it("says so when there is nothing shared yet", async () => {
    recordsBody = { records: [], cloud: { available: true } };
    render(<DrivePage />);

    expect(await screen.findByText("No shared records yet.")).toBeDefined();
  });

  it("surfaces a failed load instead of rendering an empty table", async () => {
    recordsStatus = 503;
    recordsBody = { error: "Starkeep Drive is not installed locally" };
    render(<DrivePage />);

    expect(await screen.findByText(/not installed locally/)).toBeDefined();
  });

  it("warns when the cloud view is unavailable, and still shows the local rows", async () => {
    recordsBody = { records: [row()], cloud: { available: false, error: "not signed in" } };
    render(<DrivePage />);

    expect(await screen.findByText(/Showing local data only.*not signed in/)).toBeDefined();
    expect(screen.getByRole("row", { name: /holiday\.png/ })).toBeDefined();
  });
});

describe("the type sidebar", () => {
  it("lists a chip per type, with its count", async () => {
    typesBody = {
      types: [
        { record_type: "image/png", count: 3 },
        { record_type: "document/pdf", count: 1 },
      ],
      cloud: { available: true },
    };
    render(<DrivePage />);

    expect(await screen.findByRole("button", { name: "image/png (3)" })).toBeDefined();
    expect(screen.getByRole("button", { name: "document/pdf (1)" })).toBeDefined();
  });

  it("re-asks for the records filtered when a chip is clicked", async () => {
    render(<DrivePage />);
    const chip = await screen.findByRole("button", { name: "image/png (1)" });

    chip.click();

    await waitFor(() => {
      expect(recordsCalls).toContain("/api/records?type=image%2Fpng");
    });
  });

  it("goes back to everything when All is clicked", async () => {
    render(<DrivePage />);
    (await screen.findByRole("button", { name: "image/png (1)" })).click();
    await waitFor(() => expect(recordsCalls.length).toBe(2));

    screen.getByRole("button", { name: "All" }).click();

    await waitFor(() => expect(recordsCalls[2]).toBe("/api/records"));
  });
});

describe("live updates", () => {
  it("subscribes to the same-origin SSE proxy", async () => {
    render(<DrivePage />);

    await waitFor(() => expect(opened.length).toBe(1));
    expect(opened[0].url).toBe("/api/events");
  });

  it("re-fetches the records when a kick arrives, with no reload", async () => {
    render(<DrivePage />);
    await screen.findByRole("row", { name: /holiday\.png/ });
    const before = recordsCalls.length;

    recordsBody = {
      records: [row(), row({ id: "rec-2", original_filename: "just-added.png" })],
      cloud: { available: true },
    };
    opened[0].kick();

    expect(await screen.findByRole("row", { name: /just-added\.png/ })).toBeDefined();
    expect(recordsCalls.length).toBeGreaterThan(before);
  });

  it("does not replace the table with a loading state on a live refresh", async () => {
    // A silent refresh is the point: flashing "Loading…" on every remote write
    // would make an idle page unreadable.
    render(<DrivePage />);
    await screen.findByRole("row", { name: /holiday\.png/ });

    opened[0].kick();

    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByRole("row", { name: /holiday\.png/ })).toBeDefined();
  });

  it("closes the stream when the page goes away", async () => {
    const { unmount } = render(<DrivePage />);
    await waitFor(() => expect(opened.length).toBe(1));

    unmount();

    expect(opened[0].closed).toBe(true);
  });

  it("keeps one stream open across a type change", async () => {
    // The loaders' identity changes with the filter; reconnecting the
    // EventSource each time would drop kicks in the gap.
    render(<DrivePage />);
    await waitFor(() => expect(opened.length).toBe(1));

    (await screen.findByRole("button", { name: "image/png (1)" })).click();
    await waitFor(() => expect(recordsCalls.length).toBe(2));

    expect(opened.length).toBe(1);
    expect(opened[0].closed).toBe(false);
  });
});

describe("sharing a link", () => {
  async function openDialog(over: Partial<Row> = {}) {
    recordsBody = { records: [row(over)], cloud: { available: true } };
    render(<DrivePage />);
    const tr = await screen.findByRole("row", { name: /holiday|notes/ });
    const button = within(tr).getByRole("button", { name: "Share link…" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    button.click();
    return screen.findByRole("dialog", { name: "Share link" });
  }

  it("is offered for a synced or cloud-only row, and not for a local-only one", async () => {
    recordsBody = {
      records: [
        row({ id: "a", original_filename: "here.png", sync_status: "synced" }),
        row({ id: "b", original_filename: "away.png", sync_status: "cloud-only" }),
        row({ id: "c", original_filename: "local.png", sync_status: "local-only" }),
      ],
      cloud: { available: true },
    };
    render(<DrivePage />);
    const button = async (name: RegExp) =>
      within(await screen.findByRole("row", { name })).getByRole("button", {
        name: "Share link…",
      }) as HTMLButtonElement;
    await waitFor(async () => expect((await button(/here\.png/)).disabled).toBe(false));
    expect((await button(/away\.png/)).disabled).toBe(false);
    const local = await button(/local\.png/);
    expect(local.disabled).toBe(true);
    expect(local.title).toBe("This file is not in the cloud yet.");
  });

  it("shares a photo's stand-in by default, and says what a visitor sees", async () => {
    const dialog = await openDialog();
    const standIn = within(dialog).getByRole("radio", { name: /Largest stand-in/ });
    expect((standIn as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByText(/no location or camera details/)).toBeDefined();

    within(dialog).getByRole("button", { name: "Create link" }).click();

    await waitFor(() => expect(linkWrites).toHaveLength(1));
    expect(linkWrites[0]!.body).toEqual({
      recordId: "rec-1",
      serves: "stand-in",
      title: "holiday.png",
      lifetime: "30d",
    });
    expect(
      await within(dialog).findByDisplayValue(
        "https://d1.cloudfront.net/public-shares/TTTTTTTTTTTTTTTTTTTTTT/file",
      ),
    ).toBeDefined();
  });

  it("shares the original when chosen, and warns about its metadata", async () => {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Original/ }));
    expect(within(dialog).getByText(/including its location and camera details/)).toBeDefined();
    within(dialog).getByRole("button", { name: "Create link" }).click();
    await waitFor(() => expect(linkWrites[0]?.body["serves"]).toBe("original"));
  });

  it("cannot offer an archived original", async () => {
    const dialog = await openDialog({ cloud_availability: "archived" });
    const original = within(dialog).getByRole("radio", { name: /Original/ }) as HTMLInputElement;
    expect(original.disabled).toBe(true);
    expect(within(dialog).getByText(/archived, so it cannot be shared as itself/)).toBeDefined();
  });

  it("shows the archive state in the Sync column", async () => {
    recordsBody = {
      records: [row({ cloud_availability: "restoring" })],
      cloud: { available: true },
    };
    render(<DrivePage />);
    const tr = await screen.findByRole("row", { name: /holiday\.png/ });
    expect(within(tr).getByText("Restoring")).toBeDefined();
  });

  it("shows the platform's refusal", async () => {
    createStatus = 409;
    createBody = { error: "This original is archived. Share the largest stand-in instead." };
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Original/ }));
    within(dialog).getByRole("button", { name: "Create link" }).click();
    expect(await within(dialog).findByText(/Share the largest stand-in instead/)).toBeDefined();
  });

  it("asks before sharing a file over 100 MB, and does nothing when declined", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const dialog = await openDialog({
      category: "document",
      type: "document/pdf",
      original_filename: "notes.pdf",
      size_bytes: 150 * 1024 * 1024,
    });
    expect(within(dialog).getByText(/including any metadata inside it/)).toBeDefined();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    within(dialog).getByRole("button", { name: "Create link" }).click();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("150 MB"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("transfer allowance"));
    expect(linkWrites).toEqual([]);
  });

  it("does not ask for a large photo's stand-in", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const dialog = await openDialog({ size_bytes: 150 * 1024 * 1024 });
    within(dialog).getByRole("button", { name: "Create link" }).click();
    await waitFor(() => expect(linkWrites).toHaveLength(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("points to admin-web when Drive's switch is off", async () => {
    linksBody = { available: true, mayPublish: false, links: [] };
    const dialog = await openDialog();
    expect(within(dialog).getByText(/Turn on “Enable sharing” on the Drive card/)).toBeDefined();
    expect(
      (within(dialog).getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("the Links view", () => {
  it("lists Drive's links with their file, and stops one", async () => {
    vi.stubGlobal("confirm", () => true);
    linksBody = {
      available: true,
      mayPublish: false,
      links: [
        {
          id: "s-1",
          recordId: "rec-1",
          serves: "original",
          title: "Beach",
          url: "https://d1.cloudfront.net/public-shares/T/file",
          createdAtMs: 1,
          expiresAtMs: null,
        },
      ],
    };
    render(<DrivePage />);
    await screen.findByRole("row", { name: /holiday\.png/ });
    screen.getByRole("button", { name: "Links" }).click();

    const tr = await screen.findByRole("row", { name: /Beach/ });
    expect(within(tr).getByText("holiday.png")).toBeDefined();
    expect(within(tr).getByText("Original")).toBeDefined();
    // The switch is off: no replacing, but stopping still works.
    expect(within(tr).queryByRole("button", { name: "Replace link" })).toBeNull();
    within(tr).getByRole("button", { name: "Stop sharing" }).click();
    await waitFor(() =>
      expect(linkWrites).toEqual([
        expect.objectContaining({ method: "DELETE", url: "/api/public-links/s-1" }),
      ]),
    );
  });
});
