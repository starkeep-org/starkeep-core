import { describe, expect, it } from "vitest";
import { awaitingCloudInstall } from "../sync-supervisor.js";

/**
 * The quiet branch in driveDrain's catch. Its only job is to recognize one
 * specific, expected condition — an app installed locally whose cloud half
 * does not exist yet — and it must never claim any other failure, because
 * everything it claims is logged once instead of in full.
 */
describe("awaitingCloudInstall", () => {
  const REAL = `/sync/exchange failed: 401 Unauthorized {"error":"Unknown app: memo"}`;

  it("recognizes the message the cloud data server actually sends", () => {
    expect(awaitingCloudInstall(REAL, "memo")).toBe(true);
  });

  it("does not claim another app's absence", () => {
    expect(awaitingCloudInstall(REAL, "photos")).toBe(false);
  });

  it("does not claim other 401s", () => {
    const others = [
      `/sync/exchange failed: 401 Unauthorized {"error":"Invalid or expired end-user token"}`,
      `/sync/exchange failed: 401 Unauthorized {"error":"Stale or invalid signature timestamp"}`,
      `/sync/exchange failed: 401 Unauthorized {"error":"Unknown or revoked device"}`,
    ];
    for (const message of others) {
      expect(awaitingCloudInstall(message, "memo")).toBe(false);
    }
  });

  it("does not claim failures that are not 401s", () => {
    expect(awaitingCloudInstall("/sync/exchange failed: 500 Internal Server Error", "memo")).toBe(
      false,
    );
    expect(awaitingCloudInstall("fetch failed", "memo")).toBe(false);
    expect(awaitingCloudInstall("", "memo")).toBe(false);
  });
});
