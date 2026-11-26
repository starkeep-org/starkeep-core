/**
 * `starkeep cloud bootstrap-update`: what it says for each outcome, word for
 * word as `scripts/update-bootstrap.sh` said it, with CloudFormation and STS
 * stood in for.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  type Change,
} from "@aws-sdk/client-cloudformation";
import type { UpdateClients } from "@starkeep/operator/bootstrap";

const dir = mkdtempSync(join(tmpdir(), "cli-bootstrap-update-"));
process.env.STARKEEP_DIR = dir;
const { runBootstrapUpdate, updateTarget } = await import("../src/commands/cloud");
const { createIo } = await import("../src/io");
const { CliError } = await import("../src/errors");

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

const CONFIG = {
  stackPrefix: "sk",
  accountId: "111111111111",
  userPoolId: "us-east-2_abc",
  deploymentName: "Home",
};

const modify = (id: string, replacement = "False"): Change => ({
  Type: "Resource",
  ResourceChange: {
    Action: "Modify",
    LogicalResourceId: id,
    ResourceType: "AWS::Cognito::UserPool",
    Replacement: replacement as never,
    Scope: ["Properties"],
  },
});

function aws(options: { account?: string; changes?: Change[]; noChanges?: boolean }) {
  const sent: string[] = [];
  const clients: UpdateClients = {
    sts: {
      send: async () => ({
        Account: options.account ?? "111111111111",
        Arn: "arn:aws:iam::111111111111:user/me",
      }),
    } as never,
    cloudFormation: {
      send: async (command: { constructor: { name: string } }) => {
        sent.push(command.constructor.name);
        if (command instanceof DescribeStacksCommand)
          return {
            Stacks: [{ StackName: "sk-bootstrap", StackStatus: "UPDATE_COMPLETE", Parameters: [] }],
          };
        if (command instanceof DescribeChangeSetCommand)
          return options.noChanges
            ? { StatusReason: "No updates are to be performed." }
            : { Changes: options.changes ?? [modify("UserPool")] };
        return {};
      },
    } as never,
    changeSetName: "update-bootstrap-test",
    waitForChangeSet: async () => {
      if (options.noChanges) throw new Error("FAILED");
    },
    waitForUpdate: async () => {},
  };
  return { sent, clients };
}

function io(answers?: string[]) {
  let out = "";
  let err = "";
  const handle = createIo({
    json: false,
    cwd: dir,
    interactive: answers !== undefined,
    ...(answers ? { answers } : {}),
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
  });
  return { handle, out: () => out, err: () => err };
}

const options = (over: Partial<Parameters<typeof runBootstrapUpdate>[1]> = {}) => ({
  target: updateTarget({}),
  apply: false,
  yes: false,
  allowReplacement: false,
  verbose: false,
  ...over,
});

beforeEach(() => writeConfig(CONFIG));

describe("cloud bootstrap-update", () => {
  it("takes the stack prefix, the deployment name and the user pool's region from config.json", () => {
    expect(updateTarget({})).toEqual({
      stackPrefix: "sk",
      region: "us-east-2",
      deploymentName: "Home",
    });
    expect(updateTarget({ region: "eu-west-1", deploymentName: "Family" })).toMatchObject({
      region: "eu-west-1",
      deploymentName: "Family",
    });
  });

  it("names the flags to pass when config.json lacks a value", () => {
    writeConfig({ stackPrefix: "sk" });
    expect(() => updateTarget({})).toThrow(
      /Error: need a stack prefix, a region and a deployment name\.\n.*pass --prefix, --region and --deployment-name\./,
    );
  });

  it("previews the stack, the account, the region and the change table, and applies nothing without --apply", async () => {
    const { sent, clients } = aws({});
    const t = io();
    expect(await runBootstrapUpdate(t.handle, options(), clients)).toBe("previewed");
    expect(t.out()).toContain("Stack:           sk-bootstrap");
    expect(t.out()).toContain("Account:         111111111111");
    expect(t.out()).toContain("Region:          us-east-2");
    expect(t.out()).toContain("Deployment name: Home");
    expect(t.out()).toMatch(/Action\s+Resource\s+Type\s+Replacement\s+Scope/);
    expect(t.out()).toMatch(/Modify\s+UserPool\s+AWS::Cognito::UserPool\s+False\s+Properties/);
    expect(t.out()).toContain("Preview only: deleted the change set. Nothing was applied.");
    expect(t.out()).toContain("Rerun with --apply to apply this update.");
    expect(sent).toContain(DeleteChangeSetCommand.name);
    expect(sent).not.toContain(ExecuteChangeSetCommand.name);
  });

  it("says there is nothing to do when the stack matches", async () => {
    const { clients } = aws({ noChanges: true });
    const t = io();
    expect(await runBootstrapUpdate(t.handle, options({ apply: true }), clients)).toBe(
      "no-changes",
    );
    expect(t.out()).toContain("The stack already matches this template. Nothing to do.");
  });

  it("refuses credentials for another account than config.json names, before any change set", async () => {
    const { sent, clients } = aws({ account: "222222222222" });
    const failure = runBootstrapUpdate(io().handle, options(), clients);
    await expect(failure).rejects.toBeInstanceOf(CliError);
    await expect(failure).rejects.toThrow(
      /these credentials belong to account 222222222222, but .*config\.json names 111111111111\.\nSet AWS_PROFILE to a profile for 111111111111\./,
    );
    expect(sent).toEqual([]);
  });

  it("refuses a change set that replaces a resource, even with --apply, unless --allow-replacement", async () => {
    const { sent, clients } = aws({ changes: [modify("UserPool", "True"), modify("Client")] });
    await expect(
      runBootstrapUpdate(io().handle, options({ apply: true, yes: true }), clients),
    ).rejects.toThrow(
      "Error: the change set removes or replaces 1 resource(s). Nothing was applied.\n" +
        "Review the table above, then rerun with --allow-replacement if the change is intended.",
    );
    expect(sent).not.toContain(ExecuteChangeSetCommand.name);
    const allowed = aws({ changes: [modify("UserPool", "True")] });
    expect(
      await runBootstrapUpdate(
        io().handle,
        options({ apply: true, yes: true, allowReplacement: true }),
        allowed.clients,
      ),
    ).toBe("applied");
  });

  it("asks before it applies, and any answer but y deletes the change set", async () => {
    const { sent, clients } = aws({});
    const t = io(["n"]);
    expect(await runBootstrapUpdate(t.handle, options({ apply: true }), clients)).toBe("declined");
    expect(t.err()).toContain("Apply this change set to sk-bootstrap? [y/N]");
    expect(t.out()).toContain("Deleted the change set. Nothing was applied.");
    expect(sent).not.toContain(ExecuteChangeSetCommand.name);
  });

  it("applies after y, or with --yes, and says the stack reached UPDATE_COMPLETE", async () => {
    for (const run of [
      { t: io(["y"]), yes: false },
      { t: io(), yes: true },
    ]) {
      const { sent, clients } = aws({});
      expect(
        await runBootstrapUpdate(run.t.handle, options({ apply: true, yes: run.yes }), clients),
      ).toBe("applied");
      expect(sent).toContain(ExecuteChangeSetCommand.name);
      expect(run.t.out()).toContain("The stack reached UPDATE_COMPLETE.");
    }
  });
});
