/**
 * @vitest-environment jsdom
 *
 * Start of an app whose recorded port another program holds: the alert links
 * the address, warns that moving the app empties its browser storage, and
 * offers to choose another port (#135).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAppsSection } from "../src/components/LocalAppsSection";
import type { LocalAppEntry } from "../src/lib/app-types";

vi.mock("@/lib/operator-session", () => ({ operatorSessionIfSignedIn: async () => null }));

const dice: LocalAppEntry = {
  appId: "dice",
  sourceDir: "/apps/dice",
  status: "active",
  manifest: { id: "dice", name: "Dice", version: "1.0.0" },
};

/** The bodies of each Start request, in order. */
let starts: unknown[] = [];

/** Answer each Start with the next response in `answers`. */
function serve(answers: Response[]) {
  starts = [];
  let running = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/exec/daemon") {
        starts.push(JSON.parse(init!.body as string));
        const answer = answers.shift()!;
        if (answer.ok) running = true;
        return answer;
      }
      if (url.startsWith("/api/exec/daemon/status")) {
        return Response.json(running ? { running: true, port: 20124 } : { running: false });
      }
      return Response.json({});
    }),
  );
}

const portInUse = () =>
  Response.json(
    {
      error: "'dice' cannot start: its port 20123 is in use.",
      reason: "port-in-use",
      port: 20123,
    },
    { status: 409 },
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show() {
  render(<LocalAppsSection apps={[dice]} refresh={async () => undefined} localOnline={true} />);
}

describe("Start when the app's port is in use", () => {
  it("links the address, warns about browser storage, and offers another port", async () => {
    serve([portInUse()]);
    show();
    await userEvent.setup().click(screen.getByRole("button", { name: "Start Dice" }));

    expect(await screen.findByText("Dice cannot start")).toBeTruthy();
    const link = screen.getByRole("link", { name: "http://localhost:20123" });
    expect(link.getAttribute("href")).toBe("http://localhost:20123");
    expect(link.getAttribute("target")).toBe("_blank");
    // The warning follows the button it explains.
    const button = screen.getByRole("button", { name: "Choose another port" });
    const warning = screen.getByText("On another port, Dice starts with empty browser storage.");
    expect(button.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(starts).toEqual([{ action: "start", id: "dice" }]);
  });

  it("Choose another port starts the app with reassignPort and clears the alert", async () => {
    serve([portInUse(), Response.json({ ok: true, pid: 1, port: 20124 })]);
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start Dice" }));
    await user.click(await screen.findByRole("button", { name: "Choose another port" }));

    expect(starts).toEqual([
      { action: "start", id: "dice" },
      { action: "start", id: "dice", reassignPort: true },
    ]);
    expect(screen.queryByText("Dice cannot start")).toBeNull();
    expect(await screen.findByText("Running :20124", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("shows any other failed Start as a plain error, with no port choice", async () => {
    serve([
      Response.json({ error: 'STARKEEP_APP_PORT_RANGE is "x"; it must be…' }, { status: 409 }),
    ]);
    show();
    await userEvent.setup().click(screen.getByRole("button", { name: "Start Dice" }));

    expect(await screen.findByText('STARKEEP_APP_PORT_RANGE is "x"; it must be…')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Choose another port" })).toBeNull();
  });
});
