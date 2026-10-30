/**
 * @vitest-environment jsdom
 *
 * Where the cloud-setup wizard sends the operator when the deploy finishes.
 *
 * The wizard's last act is a navigation to the dashboard, and it is the one
 * piece of programmatic navigation in the app — everything else is a `<Link>`.
 * Nothing else would notice if the call were dropped: the operator would finish
 * a ten-minute deploy and be left staring at the wizard.
 *
 * The navigation is asserted by *arriving* rather than by spying on a router.
 * The wizard is mounted inside the app's real route table, so a working
 * redirect renders the dashboard and a broken one does not — which is the thing
 * the operator experiences, and which survives the router being replaced again.
 *
 * Getting there means driving the whole last step, so this file also covers the
 * two-pass deploy: the cloud-data-server pass, the Drive pass, and the single
 * daemon restart afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { App } from "../src/App";
import { CloudSetupWizard } from "../src/components/CloudSetupWizard";
import { NOT_AN_ADMIN } from "../src/lib/cognito-auth";

// Cognito is a network call to AWS. What the wizard needs from it is a session
// that resumes and credentials that mint, so those are what the stub supplies.
const refreshTokens = vi.fn(async () => ({ idToken: "id-token", refreshToken: "refresh-token" }));
const getIdentityPoolCredentials = vi.fn(async () => ({
  accessKeyId: "ASIA",
  secretAccessKey: "secret",
  sessionToken: "token",
  expiration: new Date(Date.now() + 3_600_000).toISOString(),
}));
// Signing in with a password goes through these two, which each test that
// signs in primes with the answer Cognito would give.
const initiateAuth = vi.fn();
const respondNewPasswordChallenge = vi.fn();
vi.mock("../src/lib/cognito-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/cognito-auth")>()),
  initiateAuth: (...args: unknown[]) => initiateAuth(...args),
  respondNewPasswordChallenge: (...args: unknown[]) => respondNewPasswordChallenge(...args),
  refreshTokens: (...args: unknown[]) => refreshTokens(...(args as [])),
  getIdentityPoolCredentials: (...args: unknown[]) => getIdentityPoolCredentials(...(args as [])),
  extractEmailFromIdToken: () => "operator@example.com",
  startCredentialRefreshTimer: () => () => {},
}));

// The template generator is real; the spy records what step 1 asked it for.
const generatedFor: Array<{ stackPrefix?: string; adminEmail?: string }> = [];
vi.mock("@starkeep/aws-bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/aws-bootstrap")>();
  return {
    ...actual,
    generateBootstrapTemplate: (input: { stackPrefix?: string; adminEmail?: string }) => {
      generatedFor.push(input);
      return actual.generateBootstrapTemplate(input);
    },
  };
});

const DEPLOYED_CONFIG = {
  stackPrefix: "sktest",
  stage: "sktest",
  userPoolId: "us-east-2_abc123",
  userPoolClientId: "client",
  deviceUserPoolClientId: "deviceclient",
  cognitoDomain: "sktest-123456789012.auth.us-east-2.amazoncognito.com",
  identityPoolId: "us-east-2:12345678-1234-1234-1234-123456789012",
  s3Bucket: "sktest-files",
  auroraEndpoint: "abc.dsql.us-east-2.on.aws",
  apiGatewayUrl: "https://gw.execute-api.us-east-2.amazonaws.com",
};

/** One SSE pass, as the route serves it: some log lines, then a terminal event. */
function sseResponse(event: string, data: unknown, logLines: string[] = []): Response {
  const frames = [
    ...logLines.map((line) => `data: ${JSON.stringify(line)}\n\n`),
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  ].join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

const DEPLOY_OUTPUTS = {
  bucketName: "sktest-files",
  auroraHostname: "abc.dsql.us-east-2.on.aws",
  apiGatewayUrl: "https://gw.execute-api.us-east-2.amazonaws.com",
  publicBaseUrl: "https://d111.cloudfront.net",
};

let calls: string[];

function stubFetch(over: Partial<Record<string, () => Response>> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    for (const [match, make] of Object.entries(over)) {
      if (url.includes(match)) return make!();
    }
    if (url.includes("/api/config")) return Response.json({ config: DEPLOYED_CONFIG });
    if (url.includes("/api/runtime-config")) {
      return Response.json({
        localDataServerUrl: "http://127.0.0.1:9820",
        driveUrl: "http://localhost:9830",
      });
    }
    if (url.includes("/api/cloud-data-server/install")) {
      return sseResponse("done", DEPLOY_OUTPUTS, ["Creating DSQL cluster…"]);
    }
    if (url.includes("/api/drive/install")) return sseResponse("done", {}, ["Creating role…"]);
    if (url.includes("/api/exec/daemon")) return Response.json({ restarted: true });
    // The cloud and the local data server, neither reachable from a test.
    throw new TypeError("fetch failed");
  });
}

/**
 * A config that starts as `initial` and keeps whatever the wizard saves into
 * it, so a step that saves sees its own values on the next read. Returns the
 * saved patches, in order.
 */
function statefulConfig(initial: Record<string, unknown> | null): Array<Record<string, unknown>> {
  let saved = initial;
  const patches: Array<Record<string, unknown>> = [];
  const base = stubFetch({ "/api/config": () => Response.json({ config: saved }) });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH" && String(input).includes("/api/config")) {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(patch);
      saved = { ...saved, ...patch };
      return Promise.resolve(Response.json({ config: saved }));
    }
    return base(input);
  });
  return patches;
}

/** Radix's Select reaches for pointer capture and scrolling, which jsdom lacks. */
function supportRadixSelect(): void {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

const SESSION_KEY = "starkeep:cognito-session";

beforeEach(() => {
  calls = [];
  localStorage.clear();
  localStorage.setItem(
    "starkeep:cognito-session",
    JSON.stringify({ refreshToken: "refresh-token", userEmail: "operator@example.com" }),
  );
  vi.stubGlobal("fetch", stubFetch());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Mount the app at /cloud-setup and wait for the wizard to resume onto the
 * deploy step. The whole route table is mounted, so the redirect at the end has
 * somewhere real to go.
 */
async function renderAtDeployStep() {
  render(
    <MemoryRouter initialEntries={["/cloud-setup"]}>
      <App />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("heading", { name: "Deploy Starkeep cloud" }, { timeout: 5_000 }),
  ).toBeTruthy();
}

/**
 * The wizard alone, with an `onComplete` handler — the embedded shape, where the
 * host decides what "done" means instead of the wizard navigating.
 */
async function renderEmbedded(onComplete: () => void) {
  render(
    <MemoryRouter initialEntries={["/cloud-setup"]}>
      <CloudSetupWizard onComplete={onComplete} />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("heading", { name: "Deploy Starkeep cloud" }, { timeout: 5_000 }),
  ).toBeTruthy();
}

describe("resuming onto the last step", () => {
  it("lands on the deploy step when the config and the session are both complete", async () => {
    await renderAtDeployStep();
    // Steps 1–4 all leave evidence behind; the wizard reads it rather than
    // making the operator walk them again.
    expect(screen.queryByRole("heading", { name: "Bootstrap Stack" })).toBeNull();
  });

  it("reopens the stack-outputs step for a config from before the device client existed", async () => {
    const { deviceUserPoolClientId: _dropped, ...older } = DEPLOYED_CONFIG;
    vi.stubGlobal("fetch", stubFetch({ "/api/config": () => Response.json({ config: older }) }));
    render(
      <MemoryRouter initialEntries={["/cloud-setup"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByLabelText("DeviceUserPoolClientId", {}, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Deploy Starkeep cloud" })).toBeNull();
  });
});

describe("a config from before the Cognito domain existed", () => {
  it("reopens the stack-outputs step to ask for it", async () => {
    const { cognitoDomain: _dropped, ...older } = DEPLOYED_CONFIG;
    vi.stubGlobal("fetch", stubFetch({ "/api/config": () => Response.json({ config: older }) }));
    render(
      <MemoryRouter initialEntries={["/cloud-setup"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("CognitoDomain", {}, { timeout: 5_000 })).toBeTruthy();
  });
});

describe("the deploy, end to end", () => {
  it("runs both passes, restarts the daemon once, then offers Continue", async () => {
    const user = userEvent.setup();
    await renderAtDeployStep();

    await user.click(screen.getByRole("button", { name: /Redeploy/ }));

    const cont = await screen.findByRole("button", { name: /Continue/ }, { timeout: 5_000 });
    expect(cont).toBeTruthy();

    const installs = calls.filter((u) => u.includes("/install"));
    expect(installs.filter((u) => u.includes("cloud-data-server"))).toHaveLength(1);
    expect(installs.filter((u) => u.includes("drive"))).toHaveLength(1);
    expect(installs.indexOf(installs.find((u) => u.includes("cloud-data-server"))!)).toBe(0);
    // One restart, after the whole deploy — not one per pass, which raced the
    // next pass's credential refresh and booted the daemon against a
    // half-provisioned cloud.
    expect(calls.filter((u) => u.includes("/api/exec/daemon"))).toHaveLength(1);
  });

  it("shows the installer's own log lines while it runs", async () => {
    const user = userEvent.setup();
    await renderAtDeployStep();
    await user.click(screen.getByRole("button", { name: /Redeploy/ }));
    // One `<pre>` holding the joined log, which is why these are substring
    // matches rather than whole-element ones.
    expect(await screen.findByText(/── Deploying cloud-data-server ──/)).toBeTruthy();
    expect(await screen.findByText(/Creating DSQL cluster…/)).toBeTruthy();
    expect(await screen.findByText(/── Deploying Starkeep Drive ──/)).toBeTruthy();
    expect(await screen.findByText(/Creating role…/)).toBeTruthy();
    expect(
      await screen.findByText(/\[Restarted local-data-server to apply new cloud config\]/),
    ).toBeTruthy();
  });
});

describe("what Continue does", () => {
  it("sends the operator to the dashboard", async () => {
    const user = userEvent.setup();
    await renderAtDeployStep();
    await user.click(screen.getByRole("button", { name: /Redeploy/ }));
    await user.click(await screen.findByRole("button", { name: /Continue/ }, { timeout: 5_000 }));
    expect(await screen.findByRole("heading", { name: "Local" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Cloud Setup" })).toBeNull();
  });

  it("defers to an onComplete prop when the wizard is embedded", async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();
    await renderEmbedded(onComplete);
    await user.click(screen.getByRole("button", { name: /Redeploy/ }));
    await user.click(await screen.findByRole("button", { name: /Continue/ }, { timeout: 5_000 }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });
});

describe("a deploy that fails", () => {
  it("offers a retry and navigates nowhere", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/api/cloud-data-server/install": () =>
          sseResponse("error", { message: "resource already exists" }),
      }),
    );
    const user = userEvent.setup();
    await renderAtDeployStep();
    await user.click(screen.getByRole("button", { name: /Redeploy/ }));

    expect(await screen.findByRole("button", { name: /Retry install/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Continue/ })).toBeNull();
    // Still on the wizard: a failed deploy navigates nowhere.
    expect(screen.getByRole("heading", { name: "Cloud Setup" })).toBeTruthy();
    // The Drive pass must not have run against a cloud that is not there.
    expect(calls.filter((u) => u.includes("/api/drive/install"))).toHaveLength(0);
  });

  it("sends the operator back to sign-in when the session was the problem", async () => {
    // The installer reports EXPIRED_TOKEN, and the remedy is to sign in again —
    // not to retry with the same rejected credentials.
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/api/cloud-data-server/install": () =>
          sseResponse("error", { message: "session expired", code: "EXPIRED_TOKEN" }),
      }),
    );
    const user = userEvent.setup();
    await renderAtDeployStep();
    await user.click(screen.getByRole("button", { name: /Redeploy/ }));

    await user.click(await screen.findByRole("button", { name: /Sign in again/ }));
    expect(await screen.findByRole("heading", { name: "Sign In" })).toBeTruthy();
    // The form, not the signed-in view, which carries the same heading.
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cloud Setup" })).toBeTruthy();
  });
});

/**
 * A live session proves an admin exists, so the wizard never sends that admin
 * through sign-in again just for revisiting an earlier step. The session ends
 * only when the Cognito IDs it belongs to change, or when the admin chooses to
 * switch accounts.
 */
describe("the session across steps", () => {
  it("skips sign-in after the operator revisits the stack outputs", async () => {
    const user = userEvent.setup();
    await renderAtDeployStep();

    await user.click(screen.getByRole("button", { name: "Stack outputs" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Deploy Starkeep cloud" })).toBeTruthy();
  });

  it("resumes the session when a newer output is missing, then skips sign-in", async () => {
    const { deviceUserPoolClientId: _dropped, ...older } = DEPLOYED_CONFIG;
    vi.stubGlobal("fetch", stubFetch({ "/api/config": () => Response.json({ config: older }) }));
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/cloud-setup"]}>
        <App />
      </MemoryRouter>,
    );

    await user.type(
      await screen.findByLabelText("DeviceUserPoolClientId", {}, { timeout: 5_000 }),
      "deviceclient",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Deploy Starkeep cloud" })).toBeTruthy();
    expect(refreshTokens).toHaveBeenCalled();
  });

  it("asks for sign-in again when the app client changes", async () => {
    const user = userEvent.setup();
    await renderAtDeployStep();

    await user.click(screen.getByRole("button", { name: "Stack outputs" }));
    const clientId = await screen.findByLabelText("UserPoolClientId");
    await user.clear(clientId);
    await user.type(clientId, "otherclient");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Sign In" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("shows the signed-in admin on the sign-in step and lets the admin switch accounts", async () => {
    const user = userEvent.setup();
    await renderAtDeployStep();

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("operator@example.com")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sign in with a different account" }));
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(localStorage.getItem("starkeep:cognito-session")).toBeNull();
  });
});

/**
 * Step 1 asks for the first admin's email only for a new deployment, and the
 * downloaded template carries it as the `AdminEmail` default. A re-download for
 * an existing stack carries no email, because a different email reaching a
 * stack update would replace the first admin.
 */
describe("the admin email on step 1", () => {
  beforeEach(() => {
    generatedFor.length = 0;
    // The download goes through an object URL, which jsdom does not implement.
    URL.createObjectURL = vi.fn(() => "blob:template");
    URL.revokeObjectURL = vi.fn();
    supportRadixSelect();
  });

  it("requires a valid email before a new deployment's download, then carries it to sign-in", async () => {
    statefulConfig(null);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/cloud-setup"]}>
        <App />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("combobox", {}, { timeout: 5_000 }));
    await user.click(await screen.findByRole("option", { name: /us-east-1/ }));
    const download = screen.getByRole("button", { name: "Download bootstrap template" });
    expect((download as HTMLButtonElement).disabled).toBe(true);

    const email = screen.getByLabelText("Email address for your new Starkeep account");
    await user.type(email, "operator");
    expect((download as HTMLButtonElement).disabled).toBe(true);
    await user.type(email, "@example.com");
    expect((download as HTMLButtonElement).disabled).toBe(false);

    await user.click(download);
    expect(generatedFor.at(-1)).toEqual({
      stackPrefix: "starkeep",
      adminEmail: "operator@example.com",
    });

    await user.click(screen.getByRole("button", { name: "Stack is deployed — Continue" }));
    await user.type(await screen.findByLabelText("CognitoDomain"), DEPLOYED_CONFIG.cognitoDomain);
    await user.type(
      screen.getByLabelText("DeviceUserPoolClientId"),
      DEPLOYED_CONFIG.deviceUserPoolClientId,
    );
    await user.type(screen.getByLabelText("IdentityPoolId"), DEPLOYED_CONFIG.identityPoolId);
    await user.type(screen.getByLabelText("UserPoolClientId"), DEPLOYED_CONFIG.userPoolClientId);
    await user.type(screen.getByLabelText("UserPoolId"), DEPLOYED_CONFIG.userPoolId);
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Sign In" })).toBeTruthy();
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("operator@example.com");
  });

  it("asks for no email when the config already holds a deployment, and bakes none in", async () => {
    const user = userEvent.setup();
    await renderAtDeployStep();

    await user.click(screen.getByRole("button", { name: "Bootstrap stack" }));
    expect(screen.queryByLabelText("Email address for your new Starkeep account")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Download bootstrap template" }));
    expect(generatedFor.at(-1)).toEqual({ stackPrefix: "sktest", adminEmail: undefined });
  });
});

describe("an operator with an existing deployment and no local config", () => {
  it("signs in to the existing admin account instead of deploying again", async () => {
    supportRadixSelect();
    generatedFor.length = 0;
    const patches = statefulConfig(null);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/cloud-setup"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Bootstrap Stack" }, { timeout: 5_000 }),
    ).toBeTruthy();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /us-east-1/ }));
    // No email needed: the account already exists.
    await user.click(screen.getByRole("button", { name: "Sign in to existing admin account" }));

    expect(await screen.findByRole("heading", { name: "Stack Outputs" })).toBeTruthy();
    expect(patches).toEqual([{ stackPrefix: "starkeep", stage: "starkeep" }]);
    expect(generatedFor).toEqual([]);
  });
});

/**
 * The first-setup path: the stack emailed a temporary password, Cognito asks
 * for a permanent one, and the wizard moves on with the session stored. An
 * account outside `starkeep-admins` signs in to Cognito but gets no AWS
 * credentials, so the wizard stops there.
 */
describe("signing in on the wizard", () => {
  beforeEach(() => {
    localStorage.removeItem(SESSION_KEY);
  });

  it("takes the temporary password, sets a permanent one, and stores the session", async () => {
    initiateAuth.mockResolvedValueOnce({
      challengeName: "NEW_PASSWORD_REQUIRED",
      session: "challenge-session",
    });
    respondNewPasswordChallenge.mockResolvedValueOnce({
      idToken: "new-id-token",
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 3600,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/cloud-setup"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Sign In" }, { timeout: 5_000 }),
    ).toBeTruthy();
    await user.type(screen.getByLabelText("Email"), "operator@example.com");
    await user.type(screen.getByLabelText("Password"), "Temp-pass1{Enter}");

    await user.type(await screen.findByLabelText("New password"), "Perm-pass1");
    await user.type(screen.getByLabelText("Confirm new password"), "Perm-pass1");
    await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

    expect(await screen.findByRole("heading", { name: "Deploy Starkeep cloud" })).toBeTruthy();
    expect(initiateAuth).toHaveBeenLastCalledWith(
      expect.anything(),
      "operator@example.com",
      "Temp-pass1",
    );
    expect(respondNewPasswordChallenge).toHaveBeenLastCalledWith(
      expect.anything(),
      "challenge-session",
      "operator@example.com",
      "Perm-pass1",
    );
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)!)).toMatchObject({
      refreshToken: "new-refresh-token",
    });
  });

  it("stops an account outside starkeep-admins on the sign-in step", async () => {
    initiateAuth.mockResolvedValueOnce({
      tokens: {
        idToken: "member-id-token",
        accessToken: "member-access-token",
        refreshToken: "member-refresh-token",
        expiresIn: 3600,
      },
    });
    getIdentityPoolCredentials.mockRejectedValueOnce(new Error(NOT_AN_ADMIN));
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/cloud-setup"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Sign In" }, { timeout: 5_000 });
    await user.type(screen.getByLabelText("Email"), "member@example.com");
    await user.type(screen.getByLabelText("Password"), "Member-pass1{Enter}");

    expect(await screen.findByText(NOT_AN_ADMIN)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Deploy Starkeep cloud" })).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

/**
 * An admin whose stored session no longer refreshes looks, to the wizard, like
 * no admin at all. The wizard must offer the sign-in form, not the signed-in
 * view and not a step that needs credentials.
 */
describe("a stored session that no longer refreshes", () => {
  it("lands on the sign-in form", async () => {
    refreshTokens.mockRejectedValueOnce(new Error("Refresh Token has expired"));
    render(
      <MemoryRouter initialEntries={["/cloud-setup"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Sign In" }, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.queryByText(/signed in as an admin/)).toBeNull();
  });

  it("sends the operator from the deploy step to the sign-in form", async () => {
    refreshTokens.mockRejectedValueOnce(new Error("Refresh Token has expired"));
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/cloud-setup"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Sign In" }, { timeout: 5_000 });
    // The deployment exists, so the step list still opens the deploy step.
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    await user.click(await screen.findByRole("button", { name: "Go to Sign In" }));

    expect(await screen.findByRole("heading", { name: "Sign In" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });
});

/**
 * A different user pool means a different deployment. The wizard asks before
 * it clears the deploy outputs, and it ends the session, which belongs to the
 * old pool.
 */
describe("changing the user pool after a deploy", () => {
  async function changeUserPool(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await renderAtDeployStep();
    await user.click(screen.getByRole("button", { name: "Stack outputs" }));
    const userPoolId = await screen.findByLabelText("UserPoolId");
    await user.clear(userPoolId);
    await user.type(userPoolId, "us-east-2_other1");
    await user.click(screen.getByRole("button", { name: "Continue" }));
  }

  it("asks first, then clears the deploy outputs and the session", async () => {
    const patches = statefulConfig(DEPLOYED_CONFIG);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const user = userEvent.setup();

    await changeUserPool(user);

    expect(await screen.findByRole("heading", { name: "Sign In" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(confirm).toHaveBeenCalledOnce();
    expect(patches.at(-1)).toMatchObject({
      userPoolId: "us-east-2_other1",
      s3Bucket: null,
      auroraEndpoint: null,
      apiGatewayUrl: null,
    });
    // The deploy step is no longer complete, so the step list locks it and shows
    // its number in place of the check mark.
    expect((screen.getByRole("button", { name: /Deploy$/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("changes nothing when the operator cancels", async () => {
    const patches = statefulConfig(DEPLOYED_CONFIG);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const user = userEvent.setup();

    await changeUserPool(user);

    expect(patches).toEqual([]);
    expect(screen.getByRole("heading", { name: "Stack Outputs" })).toBeTruthy();
  });
});
