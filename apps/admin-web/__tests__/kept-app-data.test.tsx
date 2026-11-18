/**
 * @vitest-environment jsdom
 *
 * Data an uninstall kept on this machine: the card shows it, "Delete data…"
 * deletes it after a typed confirmation, and a reinstall says it brings the
 * data back. The routes behind it are in the local-data-server's
 * admin-apps.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAppsSection } from "../src/components/LocalAppsSection";
import { AppUpdateProvider } from "../src/components/AppUpdate";
import type { AppDataPreview, KeptAppData, LocalAppEntry } from "../src/lib/app-types";

vi.mock("@/lib/operator-session", () => ({ operatorSessionIfSignedIn: async () => null }));

const notInstalled: LocalAppEntry = {
  appId: "dice",
  sourceDir: "/apps/dice",
  status: "not_installed",
  manifest: { id: "dice", name: "Dice", version: "1.0.0" },
};

const keptDice: KeptAppData = { appId: "dice", name: "Dice", retainedAt: "2026-11-17 10:00:00" };

let preview: AppDataPreview;
let deletes: unknown[] = [];

function serve() {
  deletes = [];
  preview = {
    appId: "dice",
    installed: false,
    retained: true,
    tables: [{ name: "rolls", rowCount: 12 }],
    totalRows: 12,
    files: { count: 2, totalBytes: 2048 },
    cloudCopy: "none",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/apps/dice/data") return Response.json(preview);
      if (url === "/api/apps/dice/delete-data") {
        deletes.push(JSON.parse(init!.body as string));
        return Response.json({ ok: true, appId: "dice" });
      }
      if (url === "/api/apps/dice/dependencies")
        return Response.json({ kind: "skip", reason: "No package.json." });
      return Response.json({});
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(apps: LocalAppEntry[], kept: KeptAppData[], refresh = vi.fn(async () => {})) {
  render(
    <AppUpdateProvider cloudAdministered={false} signedIn={false} refreshApps={() => {}}>
      <LocalAppsSection apps={apps} kept={kept} refresh={refresh} localOnline={true} />
    </AppUpdateProvider>,
  );
  return refresh;
}

async function openDeleteDialog(cardName: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: `More actions for ${cardName}` }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete data…" }));
  return { user, dialog: await screen.findByRole("dialog") };
}

describe("an app whose data an uninstall kept", () => {
  it("shows the kept data and offers Delete data", async () => {
    serve();
    show([notInstalled], [keptDice]);
    expect(screen.getByText("Data kept")).toBeTruthy();
    const { dialog } = await openDeleteDialog("Dice");
    expect(await within(dialog).findByText(/12 rows and 2 files \(2 KiB\)/)).toBeTruthy();
    expect(within(dialog).getByText("The deletion is permanent")).toBeTruthy();
  });

  it("deletes only after the app id is typed", async () => {
    serve();
    const refresh = show([notInstalled], [keptDice]);
    const { user, dialog } = await openDeleteDialog("Dice");
    await within(dialog).findByText(/12 rows/);
    const button = within(dialog).getByRole("button", { name: "Delete data" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await user.type(within(dialog).getByRole("textbox"), "Dice");
    expect(button.disabled).toBe(true);
    await user.clear(within(dialog).getByRole("textbox"));
    await user.type(within(dialog).getByRole("textbox"), "dice");
    expect(button.disabled).toBe(false);

    await user.click(button);
    expect(deletes).toEqual([{ confirm: "dice" }]);
    expect(refresh).toHaveBeenCalled();
  });

  // The cloud serves an app's data to a machine only while the app is
  // installed in the cloud, so the promise of a download carries that
  // condition. A cloud uninstall keeps the cloud copy but serves nothing.
  it("says a reinstall downloads the data while the app is installed in the cloud", async () => {
    serve();
    preview.cloudCopy = "current";
    show([notInstalled], [keptDice]);
    const { dialog } = await openDeleteDialog("Dice");
    expect(
      await within(dialog).findByText(/downloads it again while Dice is installed in the cloud/),
    ).toBeTruthy();
    expect(within(dialog).queryByText("The deletion is permanent")).toBeNull();
  });

  it("puts the same condition on downloading an older cloud copy", async () => {
    serve();
    preview.cloudCopy = "behind";
    show([notInstalled], [keptDice]);
    const { dialog } = await openDeleteDialog("Dice");
    expect(
      await within(dialog).findByText(/older cloud copy while Dice is installed in the cloud/),
    ).toBeTruthy();
  });

  it("keeps a card for kept data whose app folder is gone", async () => {
    serve();
    show([], [{ ...keptDice, name: "Old Dice" }]);
    expect(screen.getByText("Old Dice")).toBeTruthy();
    expect(screen.getByText("Data kept")).toBeTruthy();
    const { dialog } = await openDeleteDialog("Old Dice");
    expect(await within(dialog).findByText(/12 rows/)).toBeTruthy();
  });

  it("says the install brings the kept data back", async () => {
    serve();
    show([notInstalled], [keptDice]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Install Dice" }));
    expect(await screen.findByText("This install brings back Dice’s kept data")).toBeTruthy();
    expect(await screen.findByText(/12 rows and 2 files/)).toBeTruthy();
  });

  it("offers no Delete data on an app without kept data", async () => {
    serve();
    show([notInstalled], []);
    expect(screen.queryByText("Data kept")).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions for Dice" })).toBeNull();
  });
});
