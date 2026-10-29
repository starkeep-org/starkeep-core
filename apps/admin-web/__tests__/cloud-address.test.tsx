/**
 * @vitest-environment jsdom
 *
 * The Cloud section names the address phones and other computers sign in with,
 * and copies it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { CloudAddress } = await import("../src/components/CloudAddress");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the cloud address", () => {
  it("names the cloud's address", () => {
    render(<CloudAddress address="https://d1.cloudfront.net" />);
    expect(screen.getByText("Cloud address:")).toBeTruthy();
    expect(screen.getByText("https://d1.cloudfront.net")).toBeTruthy();
  });

  it("copies the address", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<CloudAddress address="https://d1.cloudfront.net" />);
    await user.click(screen.getByRole("button", { name: "Copy address" }));
    expect(writeText).toHaveBeenCalledWith("https://d1.cloudfront.net");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });
});
