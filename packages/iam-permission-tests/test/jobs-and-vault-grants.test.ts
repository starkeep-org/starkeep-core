/**
 * The grants scheduled jobs and the credential vault add, and the reach they
 * must not add.
 *
 * - The data server's role may invoke an app's function, and no function
 *   outside the deployment's prefix.
 * - The foundational boundary admits writes under `app-creds/_vault/` and no
 *   other `app-creds/` write, listing names by path, and encrypting through
 *   SSM.
 * - Manager may list parameter names, and still may not read an `app-creds/`
 *   value, so no Starkeep admin reads a user's vault through Manager.
 */
import { describe, expect, test } from "vitest";
import { foundationalPermissionsBoundaryStatements } from "../../aws-bootstrap/src/bootstrap/foundational-permissions-boundary";
import { buildContext, type IamContext } from "../src/contexts";
import { simulateOne } from "../src/simulate";

const PREFIX = "starkeep";
const ACCOUNT = "000000000000";
const REGION = "us-east-2";
const INPUT = { stackPrefix: PREFIX, accountId: ACCOUNT, region: REGION, appId: "photos" };
const fn = (name: string) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`;
const param = (path: string) => `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/${PREFIX}/${path}`;

const runtime = buildContext("runtime-cloud-data-server", INPUT);
const manager = buildContext("install-manager", INPUT);

/** The boundary alone: an identity policy that allows everything. */
const boundaryOnly: IamContext = {
  principalArn: `arn:aws:sts::${ACCOUNT}:assumed-role/${PREFIX}-app-cloud-data-server-role/test`,
  principalRoleName: `${PREFIX}-app-cloud-data-server-role`,
  identityPolicies: [
    {
      name: "everything",
      policy: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
      },
    },
  ],
  permissionBoundaryPolicies: [
    {
      name: "foundational-boundary",
      policy: {
        Version: "2012-10-17",
        Statement: foundationalPermissionsBoundaryStatements(PREFIX),
      },
    },
  ],
  contextVariables: {},
};

async function verdict(ctx: IamContext, action: string, resource: string) {
  return (await simulateOne(ctx, ACCOUNT, action, resource)).verdict;
}

describe("invoking functions", () => {
  test("the data server's role may invoke an app's function and the dispatcher", async () => {
    expect(await verdict(runtime, "lambda:InvokeFunction", fn(`${PREFIX}-app-photos-api`))).toBe(
      "Allowed",
    );
    expect(
      await verdict(
        runtime,
        "lambda:InvokeFunction",
        fn(`${PREFIX}-app-cloud-data-server-dispatcher`),
      ),
    ).toBe("Allowed");
  });

  test.each([`other-app-photos-api`, `${PREFIX}-photos-api`, "unrelated-function"])(
    "the data server's role may not invoke %s",
    async (name) => {
      expect(await verdict(runtime, "lambda:InvokeFunction", fn(name))).toBe("ImplicitlyDenied");
      expect(await verdict(boundaryOnly, "lambda:InvokeFunction", fn(name))).toBe(
        "ImplicitlyDenied",
      );
    },
  );

  test("the boundary caps every other Lambda verb to the data server's own functions", async () => {
    expect(
      await verdict(boundaryOnly, "lambda:UpdateFunctionCode", fn(`${PREFIX}-app-photos-api`)),
    ).toBe("ImplicitlyDenied");
    expect(
      await verdict(boundaryOnly, "lambda:CreateFunction", fn(`${PREFIX}-app-cloud-data-server-x`)),
    ).toBe("Allowed");
  });
});

describe("the jobs tick", () => {
  test("the boundary admits a rule under the prefix only", async () => {
    const rule = (name: string) => `arn:aws:events:${REGION}:${ACCOUNT}:rule/${name}`;
    expect(await verdict(boundaryOnly, "events:PutRule", rule(`${PREFIX}-jobs-tick`))).toBe(
      "Allowed",
    );
    expect(await verdict(boundaryOnly, "events:PutRule", rule("other-jobs-tick"))).toBe(
      "ImplicitlyDenied",
    );
  });
});

describe("the vault's ceiling", () => {
  test.each(["ssm:PutParameter", "ssm:DeleteParameter"])(
    "the boundary admits %s under app-creds/_vault/ only",
    async (action) => {
      expect(await verdict(boundaryOnly, action, param("app-creds/_vault/photos/u1/peloton"))).toBe(
        "Allowed",
      );
      expect(await verdict(boundaryOnly, action, param("app-creds/photos"))).toBe(
        "ImplicitlyDenied",
      );
      expect(await verdict(boundaryOnly, action, param("app-creds/_delegation-signing"))).toBe(
        "ImplicitlyDenied",
      );
    },
  );

  test("the boundary admits listing one user's vault names by path", async () => {
    expect(
      await verdict(boundaryOnly, "ssm:GetParametersByPath", param("app-creds/_vault/photos/u1")),
    ).toBe("Allowed");
  });

  test("the boundary admits encrypting a SecureString through SSM only", async () => {
    const ssm = { "kms:ViaService": `ssm.${REGION}.amazonaws.com` };
    expect((await simulateOne(boundaryOnly, ACCOUNT, "kms:Encrypt", "*", ssm)).verdict).toBe(
      "Allowed",
    );
    expect(await verdict(boundaryOnly, "kms:Encrypt", "*")).toBe("ImplicitlyDenied");
  });
});

describe("Manager", () => {
  test("may list parameter names", async () => {
    expect(await verdict(manager, "ssm:DescribeParameters", "*")).toBe("Allowed");
  });

  test("may delete a vault value but never read one", async () => {
    const secret = param("app-creds/_vault/photos/u1/peloton");
    expect(await verdict(manager, "ssm:DeleteParameter", secret)).toBe("Allowed");
    expect(await verdict(manager, "ssm:GetParameter", secret)).toBe("ImplicitlyDenied");
    expect(await verdict(manager, "ssm:GetParameters", secret)).toBe("ImplicitlyDenied");
    expect(await verdict(manager, "ssm:GetParametersByPath", param("app-creds/_vault/"))).toBe(
      "ImplicitlyDenied",
    );
  });
});
