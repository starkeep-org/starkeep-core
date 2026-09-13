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
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

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

  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.startsWith("/api/types")) return Response.json(typesBody);
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
