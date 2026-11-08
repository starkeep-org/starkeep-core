/**
 * @vitest-environment jsdom
 *
 * The dashboard's Custom Domain section. An external-DNS domain needs two
 * records at the operator's provider: the certificate's validation record and
 * the CNAME to the distribution. The domain becomes the cloud's address only
 * once both work, so "Finish" waits for both checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CustomDomainStatus } from "@starkeep/admin-installer/custom-domain";

let config: Record<string, unknown>;
vi.mock("@/lib/cloud-config", () => ({ readCloudConfig: async () => config }));
vi.mock("@/lib/operator-session", () => ({
  operatorSession: async () => ({
    credentials: { accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: "t", expiration: "x" },
  }),
}));
const runInstallStream = vi.fn(async () => ({ kind: "done" as const }));
vi.mock("@/lib/install-stream-client", () => ({ runInstallStream }));

const { CustomDomainSection } = await import("../src/components/CustomDomainSection");

const DOMAIN = "photos.example.com";
const CLOUDFRONT = "d1.cloudfront.net";
const VALIDATION = {
  name: "_abc.photos.example.com.",
  type: "CNAME",
  value: "_x.acm-validations.aws.",
};

function external(status: CustomDomainStatus["status"]): CustomDomainStatus {
  return {
    name: DOMAIN,
    mode: "external",
    status,
    validationRecord: VALIDATION,
    certificateArn: "arn:cert",
    aliasTarget: CLOUDFRONT,
  };
}

let checkResult: { certificateStatus?: string; pointsAtDistribution: boolean };
/** The account zone /zone reports for the domain, or null for external DNS. */
let zone: string | null;
let requests: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  requests = [];
  runInstallStream.mockClear();
  checkResult = { pointsAtDistribution: false };
  zone = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "/api/custom-domain/check") return Response.json(checkResult);
      if (url === "/api/custom-domain/zone") return Response.json({ domain: DOMAIN, zone });
      return Response.json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  render(<CustomDomainSection onChanged={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: /Custom Domain/ }));
}

const finish = () => screen.getByRole("button", { name: "Finish" }) as HTMLButtonElement;

describe("external mode, certificate pending", () => {
  beforeEach(() => {
    config = { customDomain: DOMAIN, customDomainStatus: external("pending-validation") };
  });

  it("shows the validation record and the CNAME together", async () => {
    await open();
    expect(screen.getByText(VALIDATION.name)).toBeDefined();
    expect(screen.getByText(VALIDATION.value)).toBeDefined();
    expect(screen.getByText(CLOUDFRONT)).toBeDefined();
    expect(screen.getAllByText("CNAME")).toHaveLength(2);
  });

  it.each([
    [
      "neither check passes",
      { certificateStatus: "PENDING_VALIDATION", pointsAtDistribution: false },
    ],
    [
      "only the certificate is issued",
      { certificateStatus: "ISSUED", pointsAtDistribution: false },
    ],
    [
      "only the CNAME resolves",
      { certificateStatus: "PENDING_VALIDATION", pointsAtDistribution: true },
    ],
  ])("keeps Finish off while %s", async (_label, result) => {
    checkResult = result;
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    await screen.findByRole("status");
    expect(finish().disabled).toBe(true);
  });

  it("turns Finish on when both pass, and Finish runs the install", async () => {
    checkResult = { certificateStatus: "ISSUED", pointsAtDistribution: true };
    await open();
    expect(finish().disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Press "Finish"/);
    expect(finish().disabled).toBe(false);
    await userEvent.click(finish());
    expect(runInstallStream).toHaveBeenCalledOnce();
  });
});

describe("Route53 mode", () => {
  it("shows no records to add", async () => {
    config = {
      customDomain: "aaron.starkeep.app",
      customDomainStatus: {
        name: "aaron.starkeep.app",
        mode: "route53",
        status: "active",
        aliasTarget: CLOUDFRONT,
      },
    };
    await open();
    expect(screen.getByText(/The cloud answers on/)).toBeDefined();
    expect(screen.queryByText("CNAME")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });
});

describe("external mode, awaiting DNS", () => {
  beforeEach(() => {
    config = { customDomain: DOMAIN, customDomainStatus: external("awaiting-dns") };
  });

  it("says the CNAME is missing and shows it", async () => {
    await open();
    expect(screen.getByText(/does not point at the cloud yet/)).toBeDefined();
    expect(screen.getByText(CLOUDFRONT)).toBeDefined();
    expect(screen.queryByText(VALIDATION.name)).toBeNull();
  });

  it("turns Finish on once the CNAME resolves", async () => {
    checkResult = { certificateStatus: "ISSUED", pointsAtDistribution: true };
    await open();
    expect(finish().disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    await screen.findByRole("status");
    expect(finish().disabled).toBe(false);
  });
});

describe("Set up", () => {
  const saves = () => requests.filter((r) => r.method === "PUT");

  async function pressSetUp() {
    config = {};
    await open();
    await userEvent.type(screen.getByRole("textbox", { name: "Custom domain" }), DOMAIN);
    await userEvent.click(screen.getByRole("button", { name: "Set up" }));
  }

  it("asks for the domain's zone with the operator's credentials", async () => {
    await pressSetUp();
    expect(requests).toContainEqual({
      url: "/api/custom-domain/zone",
      method: "POST",
      body: {
        domain: DOMAIN,
        credentials: {
          accessKeyId: "AKIA",
          secretAccessKey: "s",
          sessionToken: "t",
          expiration: "x",
        },
      },
    });
  });

  it("names a Route53 domain's records and saves nothing until the operator approves", async () => {
    zone = "example.com";
    await pressSetUp();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Route53 zone example.com");
    expect(within(dialog).getByText(`A ${DOMAIN}`)).toBeDefined();
    expect(within(dialog).getByText(`CNAME _<code>.${DOMAIN}`)).toBeDefined();
    expect(saves()).toEqual([]);

    await userEvent.click(within(dialog).getByRole("button", { name: "Set up" }));
    expect(saves()).toEqual([
      { url: "/api/custom-domain", method: "PUT", body: { domain: DOMAIN } },
    ]);
    expect(runInstallStream).toHaveBeenCalledOnce();
  });

  it("Cancel saves nothing and runs no install", async () => {
    zone = "example.com";
    await pressSetUp();
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog", { name: `Set up ${DOMAIN}` })).toBeNull();
    expect(saves()).toEqual([]);
    expect(runInstallStream).not.toHaveBeenCalled();
  });

  it("lists the steps for a domain hosted elsewhere, and saves nothing until approved", async () => {
    await pressSetUp();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("lives outside this AWS account");
    expect(dialog.textContent).toContain("changes no DNS records");
    expect(dialog.textContent).toContain('"Finish" runs a second cloud update');
    expect(saves()).toEqual([]);
    expect(runInstallStream).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Set up" }));
    expect(saves()).toEqual([
      { url: "/api/custom-domain", method: "PUT", body: { domain: DOMAIN } },
    ]);
    expect(runInstallStream).toHaveBeenCalledOnce();
  });
});

describe("Remove", () => {
  const removeRequests = () => requests.filter((r) => r.method === "PUT");

  it("names the Route53 record it deletes and the one it keeps, and removes only once approved", async () => {
    config = {
      customDomain: DOMAIN,
      customDomainStatus: {
        name: DOMAIN,
        mode: "route53",
        status: "active",
        aliasTarget: CLOUDFRONT,
      },
    };
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(`deletes the A record at ${DOMAIN}`);
    expect(dialog.textContent).toContain(`_<code>.${DOMAIN} stays`);
    expect(dialog.textContent).toContain("certificate stays on the cloud");
    expect(dialog.textContent).toContain("every link sent with");
    expect(removeRequests()).toEqual([]);

    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(removeRequests()).toEqual([
      { url: "/api/custom-domain", method: "PUT", body: { domain: null } },
    ]);
    expect(runInstallStream).toHaveBeenCalledOnce();
  });

  it("lists the provider's records for an external domain, and breaks no link before it is active", async () => {
    config = { customDomain: DOMAIN, customDomainStatus: external("pending-validation") };
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("deletes the certificate requested");
    expect(dialog.textContent).toContain("changes no DNS records");
    expect(within(dialog).getByText(`CNAME ${VALIDATION.name}`)).toBeDefined();
    expect(within(dialog).getByText(`CNAME ${DOMAIN}`)).toBeDefined();
    expect(dialog.textContent).toContain("no link stops working");
    expect(dialog.textContent).not.toContain("certificate stays on the cloud");

    await userEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(removeRequests()).toEqual([]);
    expect(runInstallStream).not.toHaveBeenCalled();
  });
});

describe("Remove, for an attached external domain", () => {
  it("asks to delete the domain's CNAME and keep the validation record", async () => {
    config = { customDomain: DOMAIN, customDomainStatus: external("active") };
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(`CNAME ${DOMAIN}`)).toBeDefined();
    expect(dialog.textContent).toContain(`Keep the record CNAME ${VALIDATION.name}`);
    expect(dialog.textContent).toContain("certificate stays on the cloud");
  });
});

describe("a saved domain no install has applied", () => {
  it("offers Remove, which clears the domain without running the install", async () => {
    config = { customDomain: DOMAIN };
    await open();
    expect(screen.getByText(/has not set up/)).toBeDefined();
    config = {};
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(requests).toContainEqual({
      url: "/api/custom-domain",
      method: "PUT",
      body: { domain: null },
    });
    expect(runInstallStream).not.toHaveBeenCalled();
    expect(screen.queryByText(/has not set up/)).toBeNull();
  });
});
