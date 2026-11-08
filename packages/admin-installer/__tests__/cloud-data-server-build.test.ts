/**
 * The record of which cloud data server build the cloud runs: its SSM
 * parameter, and the comparison admin-web's cloud card reports.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import {
  compareCloudDataServerBuild,
  getCloudDataServerBuildParameter,
  parseCloudDataServerBuild,
  putCloudDataServerBuildParameter,
} from "../src/cloud-data-server-build.js";

const ssm = mockClient(SSMClient);
const awsCreds = {
  accessKeyId: "A",
  secretAccessKey: "S",
  sessionToken: "T",
  expiration: new Date(),
};
const base = { stackPrefix: "sk", region: "us-east-2", awsCreds };

const build = { bundleSha256: "a".repeat(64), commit: "c".repeat(40), dirty: false };

beforeEach(() => ssm.reset());

describe("the SSM record", () => {
  it("writes the build under the platform prefix, over any earlier record", async () => {
    ssm.on(PutParameterCommand).resolves({});
    await putCloudDataServerBuildParameter({ ...base, build });
    const [input] = ssm.commandCalls(PutParameterCommand).map((c) => c.args[0].input);
    expect(input).toMatchObject({
      Name: "/sk/platform/cloud-data-server-build",
      Type: "String",
      Overwrite: true,
    });
    expect(JSON.parse(input!.Value!)).toEqual(build);
  });

  it("reads back the record it wrote", async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify(build) } });
    expect(await getCloudDataServerBuildParameter(base)).toEqual(build);
  });

  it("answers null when no install has recorded a build", async () => {
    ssm.on(GetParameterCommand).rejects(new ParameterNotFound({ message: "none", $metadata: {} }));
    expect(await getCloudDataServerBuildParameter(base)).toBeNull();
  });
});

describe("parseCloudDataServerBuild", () => {
  it("accepts a record with no commit, as a build outside a git checkout writes", () => {
    expect(parseCloudDataServerBuild({ ...build, commit: null })).toEqual({
      ...build,
      commit: null,
    });
  });

  it.each([
    ["a short hash", { ...build, bundleSha256: "abc" }],
    ["a missing dirty flag", { bundleSha256: build.bundleSha256, commit: build.commit }],
    ["a numeric commit", { ...build, commit: 7 }],
    ["a string", "build"],
  ])("rejects %s", (_name, value) => {
    expect(parseCloudDataServerBuild(value)).toBeNull();
  });
});

describe("compareCloudDataServerBuild", () => {
  const head = build.commit;

  it("matches when the checkout's current build has the cloud's hash", () => {
    expect(compareCloudDataServerBuild({ cloud: build, local: build, head })).toBe("match");
  });

  it("matches a build from another commit whose bundle came out the same", () => {
    const cloud = { ...build, commit: "d".repeat(40) };
    expect(compareCloudDataServerBuild({ cloud, local: build, head })).toBe("match");
  });

  it("differs when the hashes differ", () => {
    const cloud = { ...build, bundleSha256: "b".repeat(64) };
    expect(compareCloudDataServerBuild({ cloud, local: build, head })).toBe("differs");
  });

  it("asks for a rebuild when the checkout moved past its last build", () => {
    expect(compareCloudDataServerBuild({ cloud: build, local: build, head: "e".repeat(40) })).toBe(
      "local-build-stale",
    );
  });

  it("asks for a build when the checkout has none", () => {
    expect(compareCloudDataServerBuild({ cloud: build, local: null, head })).toBe("no-local-build");
  });

  it("reports no record before it looks at the checkout", () => {
    expect(compareCloudDataServerBuild({ cloud: null, local: null, head })).toBe("not-recorded");
  });

  it("compares hashes when the checkout's commit is unknown", () => {
    expect(compareCloudDataServerBuild({ cloud: build, local: build, head: null })).toBe("match");
  });
});
