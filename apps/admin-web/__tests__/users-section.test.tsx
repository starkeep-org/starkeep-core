/**
 * @vitest-environment jsdom
 *
 * The dashboard's Users section.
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

const { UsersSection } = await import("../src/components/UsersSection");

interface Call {
  url: string;
  body: Record<string, unknown>;
}

let calls: Call[];
let users: Array<Record<string, unknown>>;

beforeEach(() => {
  calls = [];
  users = [
    { username: "sub-admin", email: "admin@example.com", enabled: true, status: "CONFIRMED", admin: true, data: true },
    { username: "sub-sam", email: "sam@example.com", enabled: true, status: "FORCE_CHANGE_PASSWORD", admin: false, data: true },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      if (url === "/api/users") {
        users = [...users, { username: "sub-kim", email: body.email, enabled: true, status: "FORCE_CHANGE_PASSWORD", admin: body.admin, data: body.data }];
      }
      if (url === "/api/users/group") {
        users = users.map((u) =>
          u.username === body.username ? { ...u, [body.group === "starkeep-admins" ? "admin" : "data"]: body.member } : u,
        );
      }
      if (url === "/api/users/password") {
        return Response.json({ users, temporaryPassword: "Temp2345abcdWXYZ" });
      }
      if (url === "/api/users/enabled") {
        users = users.map((u) => (u.username === body.username ? { ...u, enabled: body.enabled } : u));
        return Response.json({ users });
      }
      return Response.json({ users });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  const user = userEvent.setup();
  render(<UsersSection />);
  await user.click(screen.getByRole("button", { name: /Users/ }));
  return user;
}

describe("the users section", () => {
  it("lists each account with its groups and marks an invited one", async () => {
    await open();
    const list = await screen.findByRole("list", { name: "Users" });
    expect(within(list).getByText("sam@example.com")).toBeTruthy();
    expect(within(list).getByText("Invited")).toBeTruthy();
    expect((screen.getByLabelText("sam@example.com is an admin") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("sam@example.com has data") as HTMLInputElement).checked).toBe(true);
  });

  it("adds a user with the chosen groups", async () => {
    const user = await open();
    await user.type(screen.getByLabelText("New user's email"), "kim@example.com");
    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(await screen.findByText(/Created kim@example.com/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/users")!.body).toMatchObject({ email: "kim@example.com", admin: false, data: true });
  });

  it("makes a user an admin, and disables one, signing them out everywhere", async () => {
    const user = await open();
    await user.click(await screen.findByLabelText("sam@example.com is an admin"));
    expect(calls.find((c) => c.url === "/api/users/group")!.body).toMatchObject({
      username: "sub-sam",
      group: "starkeep-admins",
      member: true,
    });
    const list = screen.getByRole("list", { name: "Users" });
    const samRow = within(list).getByText("sam@example.com").closest("li")!;
    await user.click(within(samRow).getByRole("button", { name: "Disable" }));
    expect(await screen.findByText(/Disabled sam@example.com and signed them out of every device/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/users/enabled")!.body).toMatchObject({ username: "sub-sam", enabled: false, userSub: "sub-admin" });
  });

  it("signs a user out of every device without disabling them", async () => {
    const user = await open();
    const list = await screen.findByRole("list", { name: "Users" });
    const samRow = within(list).getByText("sam@example.com").closest("li")!;
    await user.click(within(samRow).getByRole("button", { name: "Sign out all devices" }));
    expect(await screen.findByText(/Signed sam@example.com out of every device/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/users/sign-out")!.body).toMatchObject({ username: "sub-sam" });
    expect(calls.some((c) => c.url === "/api/users/enabled")).toBe(false);
  });

  it("resets a user's password and shows the temporary one once", async () => {
    const user = await open();
    const list = await screen.findByRole("list", { name: "Users" });
    const samRow = within(list).getByText("sam@example.com").closest("li")!;
    await user.click(within(samRow).getByRole("button", { name: "Reset password" }));
    expect(await screen.findByText(/New temporary password for sam@example.com: Temp2345abcdWXYZ/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/users/password")!.body).toMatchObject({ username: "sub-sam" });
  });
});
