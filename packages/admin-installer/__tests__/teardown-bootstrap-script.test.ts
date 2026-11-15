/**
 * scripts/teardown-bootstrap.sh must delete only the Cognito pools of the
 * deployment it tears down. The ambient config.json usually describes the
 * operator's real deployment, so a teardown of a test prefix must never name
 * that config's pools in any AWS call.
 *
 * Each test copies the script into a temp directory beside a stub
 * teardown-cloud-data-server.sh, and puts a fake `aws` first on PATH. The fake
 * logs every call and answers from a fixture. Every call it does not model
 * fails, so the script's "not found" branches run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_SCRIPTS = join(__dirname, "..", "..", "..", "scripts");

const LIVE_USER_POOL = "us-east-2_LIVEpool";
const LIVE_IDENTITY_POOL = "us-east-2:11111111-live";
const TEST_USER_POOL = "us-east-2_TESTpool";
const TEST_IDENTITY_POOL = "us-east-2:22222222-test";

interface Fixture {
  /** The target stack's physical IDs by logical ID; null when the stack is gone. */
  stackResources: Record<string, string> | null;
  userPools: { Id: string; Name: string; StackPrefix: string; DeletionProtection: string }[];
  identityPools: { IdentityPoolId: string; IdentityPoolName: string }[];
  /** The stderr a pool's delete call fails with, by pool ID; other deletes succeed. */
  deleteErrors?: Record<string, string>;
}

const FAKE_AWS = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_LOG, args.join(" ") + "\\n");
const fx = JSON.parse(fs.readFileSync(process.env.FAKE_AWS_FIXTURE, "utf8"));
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const quoted = () => (/=='([^']*)'/.exec(opt("--query") || "") || [])[1];
const fail = () => { process.stderr.write("not found\\n"); process.exit(254); };
const out = (s) => { process.stdout.write(s + "\\n"); process.exit(0); };
const cmd = args[0] + " " + args[1];
switch (cmd) {
  case "sts get-caller-identity": out("123456789012");
  case "cloudformation describe-stack-resource": {
    const id = fx.stackResources && fx.stackResources[opt("--logical-resource-id")];
    id ? out(id) : fail();
  }
  case "cognito-idp list-user-pools":
    out(fx.userPools.filter((p) => p.Name === quoted()).map((p) => p.Id).join("\\t"));
  case "cognito-identity list-identity-pools":
    out(fx.identityPools.filter((p) => p.IdentityPoolName === quoted()).map((p) => p.IdentityPoolId).join("\\t"));
  case "cognito-idp describe-user-pool": {
    const pool = fx.userPools.find((p) => p.Id === opt("--user-pool-id"));
    if (!pool) fail();
    const q = opt("--query");
    if (q === "UserPool.UserPoolTags.StackPrefix") out(pool.StackPrefix);
    if (q === "UserPool.DeletionProtection") out(pool.DeletionProtection);
    fail();
  }
  case "cognito-idp delete-user-pool":
  case "cognito-identity delete-identity-pool": {
    const err = (fx.deleteErrors || {})[opt("--user-pool-id") || opt("--identity-pool-id")];
    if (err) { process.stderr.write(err + "\\n"); process.exit(254); }
    process.exit(0);
  }
  case "cognito-idp update-user-pool":
    process.exit(0);
  default:
    fail();
}
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teardown-bootstrap-"));
  for (const sub of ["scripts", "bin", "starkeep", "env"]) mkdirSync(join(dir, sub));
  copyFileSync(
    join(REPO_SCRIPTS, "teardown-bootstrap.sh"),
    join(dir, "scripts", "teardown-bootstrap.sh"),
  );
  copyFileSync(join(REPO_SCRIPTS, "load-env.sh"), join(dir, "scripts", "load-env.sh"));
  writeFileSync(
    join(dir, "scripts", "teardown-cloud-data-server.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  writeFileSync(join(dir, "bin", "aws"), FAKE_AWS);
  for (const f of [
    "scripts/teardown-bootstrap.sh",
    "scripts/teardown-cloud-data-server.sh",
    "bin/aws",
  ]) {
    chmodSync(join(dir, f), 0o755);
  }
  // The ambient config describes the live deployment, as ~/.starkeep does.
  writeFileSync(
    join(dir, "starkeep", "config.json"),
    JSON.stringify({
      stackPrefix: "live",
      userPoolId: LIVE_USER_POOL,
      identityPoolId: LIVE_IDENTITY_POOL,
    }),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runTeardown(prefix: string, fixture: Fixture) {
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
  const log = join(dir, "aws.log");
  writeFileSync(log, "");
  const result = spawnSync(
    "bash",
    [
      join(dir, "scripts", "teardown-bootstrap.sh"),
      "--yes",
      "--prefix",
      prefix,
      "--region",
      "us-east-2",
    ],
    {
      encoding: "utf8",
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: dir,
        STARKEEP_DIR: join(dir, "starkeep"),
        STARKEEP_ENV_DIR: join(dir, "env"),
        FAKE_AWS_LOG: log,
        FAKE_AWS_FIXTURE: join(dir, "fixture.json"),
      },
    },
  );
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { status: result.status, output: result.stdout + result.stderr, calls };
}

const livePools: Fixture["userPools"] = [
  { Id: LIVE_USER_POOL, Name: "live-auth", StackPrefix: "live", DeletionProtection: "INACTIVE" },
];
const liveIdentityPools: Fixture["identityPools"] = [
  { IdentityPoolId: LIVE_IDENTITY_POOL, IdentityPoolName: "live_admin" },
];

describe("teardown-bootstrap.sh Cognito sweep", () => {
  it("deletes the target stack's pools and never names the config's pools", () => {
    const { status, output, calls } = runTeardown("sktest", {
      stackResources: { UserPool: TEST_USER_POOL, IdentityPool: TEST_IDENTITY_POOL },
      userPools: [
        ...livePools,
        {
          Id: TEST_USER_POOL,
          Name: "sktest-auth",
          StackPrefix: "sktest",
          DeletionProtection: "INACTIVE",
        },
      ],
      identityPools: [
        ...liveIdentityPools,
        { IdentityPoolId: TEST_IDENTITY_POOL, IdentityPoolName: "sktest_admin" },
      ],
    });
    expect(status, output).toBe(0);
    expect(calls).toContain(
      `cognito-idp delete-user-pool --user-pool-id ${TEST_USER_POOL} --region us-east-2`,
    );
    expect(calls).toContain(
      `cognito-identity delete-identity-pool --identity-pool-id ${TEST_IDENTITY_POOL} --region us-east-2`,
    );
    for (const call of calls) {
      expect(call).not.toContain(LIVE_USER_POOL);
      expect(call).not.toContain(LIVE_IDENTITY_POOL);
    }
  });

  it("finds pools by prefix name and tag once the stack is gone", () => {
    const { status, output, calls } = runTeardown("sktest", {
      stackResources: null,
      userPools: [
        ...livePools,
        {
          Id: TEST_USER_POOL,
          Name: "sktest-auth",
          StackPrefix: "sktest",
          DeletionProtection: "INACTIVE",
        },
        // Same name, another deployment's tag: not this teardown's pool.
        {
          Id: "us-east-2_OTHERpool",
          Name: "sktest-auth",
          StackPrefix: "other",
          DeletionProtection: "INACTIVE",
        },
      ],
      identityPools: [
        ...liveIdentityPools,
        { IdentityPoolId: TEST_IDENTITY_POOL, IdentityPoolName: "sktest_admin" },
      ],
    });
    expect(status, output).toBe(0);
    const deletes = calls.filter((c) => /delete-(user|identity)-pool /.test(c));
    expect(deletes).toEqual([
      `cognito-identity delete-identity-pool --identity-pool-id ${TEST_IDENTITY_POOL} --region us-east-2`,
      `cognito-idp delete-user-pool --user-pool-id ${TEST_USER_POOL} --region us-east-2`,
    ]);
  });

  it("updates a user pool only to turn deletion protection off", () => {
    const { status, output, calls } = runTeardown("sktest", {
      stackResources: { UserPool: TEST_USER_POOL },
      userPools: [
        {
          Id: TEST_USER_POOL,
          Name: "sktest-auth",
          StackPrefix: "sktest",
          DeletionProtection: "INACTIVE",
        },
        {
          Id: "us-east-2_PROTpool",
          Name: "sktest-auth",
          StackPrefix: "sktest",
          DeletionProtection: "ACTIVE",
        },
      ],
      identityPools: [],
    });
    expect(status, output).toBe(0);
    expect(calls.filter((c) => c.startsWith("cognito-idp update-user-pool"))).toEqual([
      "cognito-idp update-user-pool --user-pool-id us-east-2_PROTpool --deletion-protection INACTIVE --region us-east-2",
    ]);
  });

  it("stops before deleting anything when a found pool is one the other deployment's config names", () => {
    const { status, output, calls } = runTeardown("sktest", {
      // A stack that points at the live pool, for example after a bad import.
      stackResources: { UserPool: TEST_USER_POOL, IdentityPool: LIVE_IDENTITY_POOL },
      userPools: [
        {
          Id: TEST_USER_POOL,
          Name: "sktest-auth",
          StackPrefix: "sktest",
          DeletionProtection: "INACTIVE",
        },
      ],
      identityPools: [],
    });
    expect(status).toBe(1);
    expect(output).toContain(`Cognito pool ${LIVE_IDENTITY_POOL} belongs to the deployment`);
    expect(calls.filter((c) => /delete|update/.test(c))).toEqual([]);
  });

  it("reports a pool it cannot delete and exits 1, but treats a missing pool as deleted", () => {
    const domainError =
      "An error occurred (InvalidParameterException) when calling the DeleteUserPool " +
      "operation: User pool cannot be deleted. It has a domain configured that should be deleted first.";
    const { status, output } = runTeardown("sktest", {
      stackResources: { UserPool: TEST_USER_POOL, IdentityPool: TEST_IDENTITY_POOL },
      userPools: [
        {
          Id: TEST_USER_POOL,
          Name: "sktest-auth",
          StackPrefix: "sktest",
          DeletionProtection: "INACTIVE",
        },
      ],
      identityPools: [],
      deleteErrors: {
        [TEST_USER_POOL]: domainError,
        [TEST_IDENTITY_POOL]:
          "An error occurred (ResourceNotFoundException) when calling the DeleteIdentityPool " +
          `operation: IdentityPool '${TEST_IDENTITY_POOL}' not found.`,
      },
    });
    expect(status, output).toBe(1);
    expect(output).toContain(`ERROR could not delete ${TEST_USER_POOL}: ${domainError}`);
    // The script still runs its remaining steps before it fails.
    expect(output).toContain("Leaving");
    const failureList = output.slice(output.indexOf("could not be deleted:"));
    expect(failureList).toContain(TEST_USER_POOL);
    expect(failureList).not.toContain(TEST_IDENTITY_POOL);
    expect(output).not.toContain("Bootstrap teardown complete.");
  });

  it("deletes the config's pools when the config describes the target", () => {
    const { status, output, calls } = runTeardown("live", {
      stackResources: { UserPool: LIVE_USER_POOL, IdentityPool: LIVE_IDENTITY_POOL },
      userPools: livePools,
      identityPools: liveIdentityPools,
    });
    expect(status, output).toBe(0);
    expect(calls).toContain(
      `cognito-idp delete-user-pool --user-pool-id ${LIVE_USER_POOL} --region us-east-2`,
    );
    expect(calls).toContain(
      `cognito-identity delete-identity-pool --identity-pool-id ${LIVE_IDENTITY_POOL} --region us-east-2`,
    );
  });
});
