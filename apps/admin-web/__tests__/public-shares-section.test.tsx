/**
 * @vitest-environment jsdom
 *
 * The dashboard's Public Links section: the operator's audit of every link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/operator-session", () => ({
  operatorSession: async () => ({
    credentials: { accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: "t", expiration: "x" },
    stackPrefix: "sktest",
    region: "us-east-2",
    userSub: "sub-admin",
  }),
}));

const { PublicSharesSection } = await import("../src/components/PublicSharesSection");

function share(over: Record<string, unknown>) {
  return {
    id: "s-1",
    linkToken: "T".repeat(22),
    appId: "photos",
    ownerUserId: "user-1",
    source: { kind: "label", key: "album", value: "a-1" },
    serves: "stand-in",
    title: "Summer",
    createdAtMs: 1,
    expiresAtMs: null,
    ...over,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        publicShares: [
          share({}),
          share({
            id: "s-2",
            appId: "starkeep-drive",
            source: { kind: "record", recordId: "rec-1" },
            serves: "original",
            title: "beach.jpg",
          }),
          share({
            id: "s-3",
            appId: "starkeep-drive",
            source: { kind: "record", recordId: "rec-2" },
            title: "sunset.jpg",
          }),
        ],
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PublicSharesSection", () => {
  it("says what each link shows, and marks a link that serves an original", async () => {
    render(<PublicSharesSection />);
    await userEvent.click(screen.getByRole("button", { name: /Public Links/ }));
    const list = await screen.findByRole("list", { name: "Public links" });
    const item = (title: string) => within(list).getByText(title).closest("li") as HTMLElement;
    expect(within(item("Summer")).getByText(/photos · Label album, stand-ins/)).toBeDefined();
    expect(
      within(item("beach.jpg")).getByText(/starkeep-drive · One file, original/),
    ).toBeDefined();
    expect(
      within(item("sunset.jpg")).getByText(/starkeep-drive · One file, stand-in/),
    ).toBeDefined();
  });
});
