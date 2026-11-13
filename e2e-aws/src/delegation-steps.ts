/**
 * An outside client, end to end on real AWS: a user creates a delegation
 * token on the consent page, and an MCP client calls the app's delegated
 * route with it.
 *
 * What the steps hold (plan-headless-delegated-access-2026-11-13.md, phase 1):
 *
 * - The consent and connections pages answer on the gateway's execute-api
 *   hostname and never through CloudFront, where app script runs.
 * - A `read` token reads and writes labels, and is refused a row write.
 * - A `readwrite` token writes and tombstones rows, and is refused a file
 *   erase.
 * - A revoked token is refused at the data plane.
 * - "Sign out all devices" ends a token.
 *
 * The tool calls go through the app's own MCP route on the CloudFront URL,
 * as an MCP client would send them, so each assertion covers the gateway's
 * delegated authorizer, the app's `verifyDelegation`, and the data server's
 * delegated branch together. The app's route answers each tool with the data
 * server's own status, so a refusal is asserted as precisely as a success.
 *
 * The sign-out step uses a dedicated user, created and deleted here: signing
 * the admin out everywhere would end the journey's own sessions.
 */

import { randomBytes } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { chromium, type Browser, type Page } from "./browser.js";
import { REGION } from "./env.js";
import type { TestStackConfig } from "./run-state.js";

const OUTSIDE_USER_EMAIL = "tier3-outside-client@starkeep.test";

export interface DelegationStepsContext {
  readonly config: () => TestStackConfig;
  readonly appId: string;
  /** The app's MCP route, relative to its mount, declared `auth: "delegated"`. */
  readonly mcpPath: string;
  readonly admin: () => { email: string; password: string };
  /** A shared record the app may read, for the label write. */
  readonly recordId: () => string;
}

interface ToolAnswer {
  /** The HTTP status of the MCP request itself. */
  http: number;
  /** The data server's status for the tool's one data call. */
  status: number;
  body: unknown;
}

export function defineDelegationSteps(d: DelegationStepsContext): void {
  let browser: Browser | undefined;
  let readToken: string;
  let readwriteToken: string;
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const gateway = () => d.config().apiGatewayUrl!.replace(/\/+$/, "");
  const edge = () => d.config().publicBaseUrl!.replace(/\/+$/, "");

  afterAll(async () => {
    await browser?.close();
    await cognito
      .send(
        new AdminDeleteUserCommand({
          UserPoolId: d.config().userPoolId,
          Username: OUTSIDE_USER_EMAIL,
        }),
      )
      .catch(() => {});
  });

  /** Call one of the app's tools as an MCP client would, through CloudFront. */
  async function tool(
    token: string | null,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolAnswer> {
    const res = await fetch(`${edge()}/apps/${d.appId}${d.mcpPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    if (res.status !== 200) return { http: res.status, status: res.status, body: await res.text() };
    const rpc = (await res.json()) as { result?: { content?: { text?: string }[] } };
    const answer = JSON.parse(rpc.result?.content?.[0]?.text ?? "{}") as {
      status: number;
      body: unknown;
    };
    return { http: 200, ...answer };
  }

  /** Sign in on the managed login page, when it asks. A live Cognito session skips it. */
  async function signInIfAsked(page: Page, email: string, password: string): Promise<void> {
    const onCognito = await page
      .waitForURL(/\.amazoncognito\.com\//, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!onCognito) return;
    const emailField = page.locator('input[name="username"], input[type="email"]').first();
    const passwordField = page.locator('input[type="password"]').first();
    const submit = page.locator('button[type="submit"], input[type="submit"]').first();
    // A remembered session returns to the deployment without showing a form.
    const asked = await emailField
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!asked) return;
    await emailField.fill(email);
    if (!(await passwordField.isVisible())) {
      await submit.click();
      await passwordField.waitFor({ state: "visible", timeout: 30_000 });
    }
    await passwordField.fill(password);
    await submit.click();
  }

  /** Create a token on the consent page and read it off the page that shows it once. */
  async function createToken(
    page: Page,
    who: { email: string; password: string },
    mode: "read" | "readwrite",
  ): Promise<string> {
    await page.goto(`${gateway()}/connect?app=${d.appId}&client=tier3-${mode}`);
    await page.locator(`input[name="mode"][value="${mode}"]`).check();
    await page.getByRole("button", { name: "Sign in and create the token" }).click();
    await signInIfAsked(page, who.email, who.password);
    const shown = page.locator("textarea[readonly]");
    await shown.waitFor({ state: "visible", timeout: 60_000 });
    const token = (await shown.inputValue()).trim();
    expect(token.startsWith("skd_"), `the token page showed ${token.slice(0, 20)}`).toBe(true);
    return token;
  }

  it("serves the consent pages on the gateway's own hostname and never through CloudFront", async () => {
    const jwks = await fetch(`${gateway()}/connect/jwks.json`);
    expect(jwks.status).toBe(200);
    expect(((await jwks.json()) as { keys: unknown[] }).keys).toHaveLength(1);

    // Through CloudFront the broker sees the origin header and answers 404, so
    // no app script can share an origin with a page that issues tokens.
    for (const path of ["/connect", "/connections", "/connect/jwks.json"]) {
      const viaEdge = await fetch(`${edge()}${path}`, { redirect: "manual" });
      expect(viaEdge.status, path).toBe(404);
    }
  });

  it("creates a read token and a readwrite token on the consent page", async () => {
    browser = await chromium.launch();
    const page = await browser.newPage();
    readToken = await createToken(page, d.admin(), "read");
    // The second consent rides the managed login session the first one made.
    readwriteToken = await createToken(page, d.admin(), "readwrite");
    await page.close();
  });

  it("refuses the app's MCP route without a token, at the gateway", async () => {
    const answer = await tool(null, "list_records");
    expect(answer.http).toBe(401);
  });

  it("a read token reads records and adds a label", async () => {
    const list = await tool(readToken, "list_records");
    expect(list.status, JSON.stringify(list.body)).toBe(200);

    const label = await tool(readToken, "add_label", {
      recordId: d.recordId(),
      value: "from-an-outside-client",
    });
    expect(label.status, JSON.stringify(label.body)).toBe(200);
  });

  it("a read token is refused a row write", async () => {
    const write = await tool(readToken, "add_note", { recordId: "tier3-outside", note: "no" });
    expect(write.status).toBe(403);
  });

  it("a readwrite token writes and tombstones a row, and is refused a file erase", async () => {
    const write = await tool(readwriteToken, "add_note", {
      recordId: "tier3-outside",
      note: "from an outside client",
    });
    expect(write.status, JSON.stringify(write.body)).toBe(200);

    const read = await tool(readwriteToken, "list_notes");
    expect(JSON.stringify(read.body)).toContain("from an outside client");

    const tombstone = await tool(readwriteToken, "delete_note", { recordId: "tier3-outside" });
    expect(tombstone.status, JSON.stringify(tombstone.body)).toBe(200);

    const erase = await tool(readwriteToken, "erase_file", { key: "notes/any.txt" });
    expect(erase.status).toBe(403);
  });

  it("a revoked token is refused at the data plane", async () => {
    const page = await browser!.newPage();
    await page.goto(`${gateway()}/connections`);
    await signInIfAsked(page, d.admin().email, d.admin().password);
    const row = page.getByRole("row").filter({ hasText: "tier3-read" }).first();
    await row.getByRole("button", { name: "Revoke" }).click();
    await page.waitForURL(/\/connections$/);
    await expect
      .poll(
        async () =>
          (await page.getByRole("row").filter({ hasText: "tier3-read" }).first().textContent()) ??
          "",
      )
      .toContain("Revoked");
    await page.close();

    // The revoke reaches the data server's row cache on its own container at
    // once and on every other within a minute.
    await expect
      .poll(async () => (await tool(readToken, "list_records")).status, {
        timeout: 90_000,
        interval: 5_000,
      })
      .toBe(401);
    // The other token is untouched.
    expect((await tool(readwriteToken, "list_notes")).status).toBe(200);
  });

  it('"Sign out all devices" ends a token', async () => {
    const poolId = d.config().userPoolId;
    const password = `Tier3-${randomBytes(12).toString("base64url")}!a1`;
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: OUTSIDE_USER_EMAIL,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: OUTSIDE_USER_EMAIL },
          { Name: "email_verified", Value: "true" },
        ],
      }),
    );
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: poolId,
        Username: OUTSIDE_USER_EMAIL,
        Password: password,
        Permanent: true,
      }),
    );
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: poolId,
        Username: OUTSIDE_USER_EMAIL,
        GroupName: "starkeep-users",
      }),
    );

    // A fresh browser, so the consent signs in as this user and not as the
    // admin whose managed login session the earlier steps left behind.
    const context = await browser!.newContext();
    const token = await createToken(
      await context.newPage(),
      { email: OUTSIDE_USER_EMAIL, password },
      "read",
    );
    await context.close();

    // Signed out everywhere before the token's first use, so no cached answer
    // stands between the sign-out and the data server's check.
    await cognito.send(
      new AdminUserGlobalSignOutCommand({ UserPoolId: poolId, Username: OUTSIDE_USER_EMAIL }),
    );
    const after = await tool(token, "list_records");
    expect(after.status, JSON.stringify(after.body)).toBe(401);
  });
}
