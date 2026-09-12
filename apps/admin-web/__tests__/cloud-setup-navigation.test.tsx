/**
 * @vitest-environment jsdom
 *
 * Where the cloud-setup wizard sends the operator when the deploy finishes.
 *
 * The wizard's last act is a `router.push("/")`, and it is the one piece of
 * client-side navigation in the app — everything else is a `<Link>`. It is also
 * the piece a framework change reaches: `useRouter` from `next/navigation`
 * becomes `useNavigate` from react-router, and nothing else would notice if the
 * call were dropped. The operator would finish a ten-minute deploy and be left
 * staring at the wizard.
 *
 * Getting there means driving the whole last step, so this file also covers the
 * two-pass deploy: the cloud-data-server pass, the Drive pass, and the single
 * daemon restart afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/cloud-setup",
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Cognito is a network call to AWS. What the wizard needs from it is a session
// that resumes and credentials that mint, so those are what the stub supplies.
const refreshTokens = vi.fn(async () => ({ idToken: "id-token", refreshToken: "refresh-token" }));
const getIdentityPoolCredentials = vi.fn(async () => ({
  accessKeyId: "ASIA",
  secretAccessKey: "secret",
  sessionToken: "token",
  expiration: new Date(Date.now() + 3_600_000).toISOString(),
}));
vi.mock("../src/lib/cognito-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/cognito-auth")>()),
  refreshTokens: (...args: unknown[]) => refreshTokens(...(args as [])),
  getIdentityPoolCredentials: (...args: unknown[]) => getIdentityPoolCredentials(...(args as [])),
  extractEmailFromIdToken: () => "operator@example.com",
  startCredentialRefreshTimer: () => () => {},
}));

const DEPLOYED_CONFIG = {
  stackPrefix: "sktest",
  stage: "sktest",
  userPoolId: "us-east-2_abc123",
  userPoolClientId: "client",
  identityPoolId: "us-east-2:pool",
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

beforeEach(() => {
  calls = [];
  push.mockReset();
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

/** Render the wizard and wait for it to resume onto the deploy step. */
async function renderAtDeployStep(props: { onComplete?: () => void } = {}) {
  const { CloudSetupWizard } = await import("../src/components/CloudSetupWizard");
  render(<CloudSetupWizard {...props} />);
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
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });

  it("defers to an onComplete prop when the wizard is embedded", async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();
    await renderAtDeployStep({ onComplete });
    await user.click(screen.getByRole("button", { name: /Redeploy/ }));
    await user.click(await screen.findByRole("button", { name: /Continue/ }, { timeout: 5_000 }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
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
    expect(push).not.toHaveBeenCalled();
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
    expect(push).not.toHaveBeenCalled();
  });
});
