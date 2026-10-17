/**
 * The platform's own SSM parameters: device records and the deployment's
 * settings, under `/<prefix>/platform/`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SSMClient,
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterAlreadyExists,
  ParameterNotFound,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  changeDeploymentSettingsParameter,
  deviceKeyParameterName,
  deploymentSettingsParameterName,
  listDeviceRecords,
  putDeploymentSettingsParameter,
} from "../src/app-creds.js";

const ssm = mockClient(SSMClient);
const awsCreds = { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T", expiration: new Date() };
const base = { stackPrefix: "sk", region: "us-east-2", awsCreds };

beforeEach(() => ssm.reset());

describe("names", () => {
  it("keeps devices and settings under the platform prefix, apart from app secrets", () => {
    expect(deviceKeyParameterName("sk", "dev-1")).toBe("/sk/platform/devices/dev-1");
    expect(deploymentSettingsParameterName("sk")).toBe("/sk/platform/deployment-settings");
  });
});

describe("listDeviceRecords", () => {
  it("lists every page, reads each record defensively, and orders by pairing time", async () => {
    ssm
      .on(GetParametersByPathCommand, { Path: "/sk/platform/devices", NextToken: undefined })
      .resolves({
        Parameters: [
          {
            Name: "/sk/platform/devices/late",
            Value: JSON.stringify({ publicKeySpki: "k", userId: "u", kind: "desktop", appIds: ["a"], label: "L", pairedAt: "2026-10-02" }),
          },
        ],
        NextToken: "p2",
      })
      .on(GetParametersByPathCommand, { Path: "/sk/platform/devices", NextToken: "p2" })
      .resolves({ Parameters: [{ Name: "/sk/platform/devices/early", Value: "{not json" }] });
    const records = await listDeviceRecords(base);
    expect(records.map((r) => r.deviceId)).toEqual(["early", "late"]);
    expect(records[0]).toMatchObject({ kind: "phone", appIds: [], userId: null, pairedAt: "" });
    expect(records[1]).toMatchObject({ kind: "desktop", userId: "u", label: "L" });
  });
});

describe("the deployment's settings", () => {
  it("seeds only when absent, and says whether it wrote", async () => {
    ssm.on(PutParameterCommand).rejects(new ParameterAlreadyExists({ message: "exists", $metadata: {} }));
    expect(await putDeploymentSettingsParameter({ ...base, document: "{}", onlyIfAbsent: true })).toBe(false);
    expect(ssm.commandCalls(PutParameterCommand)[0]!.args[0].input).toMatchObject({
      Name: "/sk/platform/deployment-settings",
      Overwrite: false,
      Type: "String",
    });
  });

  it("merges a change into the stored document, keeping what it leaves out", async () => {
    ssm.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ trash: { retentionDays: 90 }, standIns: { image: { canonicalThreshold: 6000 } } }) },
    });
    ssm.on(PutParameterCommand).resolves({});
    const result = await changeDeploymentSettingsParameter({ ...base, change: { trash: { retentionDays: 14 } } });
    expect(result.ok).toBe(true);
    const written = JSON.parse(ssm.commandCalls(PutParameterCommand)[0]!.args[0].input.Value!);
    expect(written.trash).toEqual({ retentionDays: 14 });
    expect(written.standIns.image.canonicalThreshold).toBe(6000);
  });

  it("writes the change alone when nothing is stored", async () => {
    ssm.on(GetParameterCommand).rejects(new ParameterNotFound({ message: "none", $metadata: {} }));
    ssm.on(PutParameterCommand).resolves({});
    const result = await changeDeploymentSettingsParameter({ ...base, change: { trash: { retentionDays: 14 } } });
    expect(result).toEqual({ ok: true, settings: { trash: { retentionDays: 14 } } });
  });

  it("refuses a change that does not check out, and writes nothing", async () => {
    const result = await changeDeploymentSettingsParameter({ ...base, change: { trash: { retentionDays: 0 } } });
    expect(result.ok).toBe(false);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
});
