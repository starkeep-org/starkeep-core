/**
 * @vitest-environment jsdom
 *
 * The dashboard's Custom Domain section. An external-DNS domain needs two
 * records at the operator's provider: the certificate's validation record and
 * the CNAME to the distribution. The domain becomes the cloud's address only
 * once both work, so "Finish" waits for both checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
let requests: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  requests = [];
  runInstallStream.mockClear();
  checkResult = { pointsAtDistribution: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "/api/custom-domain/check") return Response.json(checkResult);
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
