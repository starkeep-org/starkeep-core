/**
 * @vitest-environment jsdom
 *
 * The watched-folder list, and the three states that qualify a folder's promise.
 *
 * A watched folder promises that everything inside it is in the library. Two things
 * break that promise and both were completely invisible: a file that left the disk
 * while no cloud copy was confirmed — the only way a person can lose data here — and
 * a file still on disk that the library ignores on purpose because its record was
 * deleted. A bare "7/8" said neither.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalFoldersModal, type Watch } from "../src/components/LocalFoldersModal";

afterEach(cleanup);

function watch(over: Partial<Watch> = {}): Watch {
  return {
    id: "w1",
    directoryPath: "/Users/someone/Photos",
    state: "watching",
    totalFiles: 8,
    syncedFiles: 7,
    ...over,
  };
}

function show(watches: Watch[], over: Record<string, unknown> = {}) {
  const onAddBack = vi.fn();
  render(
    <LocalFoldersModal
      open
      onOpenChange={() => {}}
      watches={watches}
      path=""
      onPathChange={() => {}}
      onAdd={() => {}}
      onRemove={() => {}}
      onAddBack={onAddBack}
      addingBack={null}
      submitting={false}
      error={null}
      success={null}
      {...over}
    />,
  );
  return { onAddBack };
}

describe("a folder with nothing to report", () => {
  it("shows the counts and no explanation, which is the ordinary state", () => {
    show([watch({ totalFiles: 8, syncedFiles: 8 })]);
    expect(screen.getByText("8/8")).toBeTruthy();
    expect(screen.queryByText(/may be lost/)).toBeNull();
    expect(screen.queryByText(/left out on purpose/)).toBeNull();
  });

  it("treats a daemon that answers without the paths as having nothing to report", () => {
    // An older build's `/watches` carries no such fields, and a modal that read them
    // as present-and-empty would be right for the wrong reason.
    show([watch()]);
    expect(screen.queryByText(/may be lost/)).toBeNull();
  });
});

describe("a file that may be lost", () => {
  it("is named, with what the person can do about it", () => {
    show([watch({ possiblyLost: ["/Users/someone/Photos/gone.jpg"] })]);
    expect(screen.getByText("1 file", { exact: false }).textContent).toContain("may be lost");
    expect(screen.getByText("/Users/someone/Photos/gone.jpg")).toBeTruthy();
    expect(screen.getByText(/before the cloud was confirmed to hold them/)).toBeTruthy();
  });
});

describe("a file left out on purpose", () => {
  it("can be added back, and says it returns the original rather than a copy", async () => {
    const user = userEvent.setup();
    const { onAddBack } = show([watch({ excluded: ["/Users/someone/Photos/deleted.jpg"] })]);
    expect(screen.getByText(/returns the original item, not a copy/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add back" }));
    expect(onAddBack).toHaveBeenCalledWith("/Users/someone/Photos/deleted.jpg");
  });

  it("says which path an add-back is running for, and blocks a second", () => {
    show([watch({ excluded: ["/a.jpg", "/b.jpg"] })], { addingBack: "/a.jpg" });
    expect(screen.getByRole("button", { name: "Adding…" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add back" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("a file that left the folder with its bytes in the cloud", () => {
  it("is explained rather than alarmed about, since nothing is lost", () => {
    // `evicted` is the benign state. It is shown so a synced count below the total has
    // an explanation, which is the whole reason it earns a line at all.
    show([watch({ evicted: ["/Users/someone/Photos/moved.jpg"] })]);
    expect(screen.getByText(/kept in the cloud/)).toBeTruthy();
    expect(screen.queryByText(/may be lost/)).toBeNull();
  });
});
