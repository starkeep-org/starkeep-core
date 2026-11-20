import { describe, expect, it } from "vitest";
import { displayName, serviceId, startOrder } from "../src/names";

describe("service names", () => {
  it("resolves data-server and drive before app ids", () => {
    expect(serviceId("data-server")).toBe("local-data-server");
    expect(serviceId("local-data-server")).toBe("local-data-server");
    expect(serviceId("drive")).toBe("drive");
    expect(serviceId("photos")).toBe("photos");
    expect(displayName("local-data-server")).toBe("data-server");
  });

  it("starts the data server, then Drive, then apps by id, each once", () => {
    expect(startOrder(["photos", "drive", "example-app", "local-data-server", "photos"])).toEqual([
      "local-data-server",
      "drive",
      "example-app",
      "photos",
    ]);
  });
});
