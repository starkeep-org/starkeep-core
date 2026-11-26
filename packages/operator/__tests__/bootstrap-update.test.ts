/**
 * The bootstrap stack's update: the change set it previews, what it counts as
 * risky, what it says when nothing changes or the change set fails, and the
 * failed update's message.
 */
import { describe, expect, it } from "vitest";
import {
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  type Change,
} from "@aws-sdk/client-cloudformation";
import {
  applyChangeSet,
  previewBootstrapUpdate,
  renderUpdateTemplate,
  verboseDetails,
  type UpdateClients,
} from "../src/bootstrap";

const TARGET = { stackPrefix: "sk", region: "us-east-2", deploymentName: "Home" };

const change = (id: string, action: string, replacement = "False"): Change => ({
  Type: "Resource",
  ResourceChange: {
    Action: action as never,
    LogicalResourceId: id,
    ResourceType: "AWS::Cognito::UserPool",
    Replacement: replacement as never,
    Scope: ["Properties"],
    Details: [
      {
        Target: {
          Attribute: "Properties",
          Name: "EmailMessage",
          Path: "/Properties/EmailMessage",
          RequiresRecreation: "Never",
          BeforeValue: "Welcome to Home",
          AfterValue: "Welcome to Family",
          AttributeChangeType: "Modify",
        },
        Evaluation: "Static",
        ChangeSource: "DirectModification",
      },
    ],
  },
});

/** A CloudFormation stand-in that records every command it receives. */
function cloudFormation(options: {
  changes?: Change[];
  failReason?: string;
  stackStatus?: string;
}) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command instanceof DescribeStacksCommand) {
        return {
          Stacks: [
            {
              StackName: "sk-bootstrap",
              StackStatus: options.stackStatus ?? "UPDATE_COMPLETE",
              CreationTime: new Date(),
              Parameters: [
                { ParameterKey: "StackPrefix", ParameterValue: "sk" },
                { ParameterKey: "AdminEmail", ParameterValue: "admin@example.com" },
              ],
            },
          ],
        };
      }
      if (command instanceof DescribeChangeSetCommand) {
        if (options.failReason) return { Status: "FAILED", StatusReason: options.failReason };
        return { Changes: options.changes ?? [] };
      }
      if (command instanceof GetTemplateCommand) return { TemplateBody: "Resources:\n  A: 1\n" };
      return {};
    },
  };
  const clients: UpdateClients = {
    cloudFormation: client as never,
    changeSetName: "update-bootstrap-test",
    waitForChangeSet: async () => {
      if (options.failReason) throw new Error("waiter failed");
    },
    waitForUpdate: async () => {
      if (options.stackStatus?.includes("ROLLBACK")) throw new Error("waiter failed");
    },
  };
  return { sent, clients };
}

describe("previewBootstrapUpdate", () => {
  it("keeps every existing parameter's previous value and sends the template without comments", async () => {
    const { sent, clients } = cloudFormation({ changes: [change("UserPool", "Modify")] });
    const preview = await previewBootstrapUpdate(TARGET, {}, clients);
    expect(preview).toMatchObject({
      kind: "changes",
      changeSetName: "update-bootstrap-test",
      risky: 0,
      changes: [
        {
          action: "Modify",
          resource: "UserPool",
          type: "AWS::Cognito::UserPool",
          replacement: "False",
          scope: "Properties",
        },
      ],
    });
    const create = sent.find((s) => s.name === CreateChangeSetCommand.name)!;
    expect(create.input.Parameters).toEqual([
      { ParameterKey: "StackPrefix", UsePreviousValue: true },
      { ParameterKey: "AdminEmail", UsePreviousValue: true },
    ]);
    expect(create.input.Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
    expect(create.input.TemplateBody).toBe(renderUpdateTemplate(TARGET));
    expect(String(create.input.TemplateBody)).not.toMatch(/^\s*#/m);
  });

  it("counts a removal, a replacement and a conditional replacement as risky", async () => {
    const { clients } = cloudFormation({
      changes: [
        change("A", "Remove"),
        change("B", "Modify", "True"),
        change("C", "Modify", "Conditional"),
        change("D", "Add"),
      ],
    });
    const preview = await previewBootstrapUpdate(TARGET, {}, clients);
    expect(preview.kind === "changes" && preview.risky).toBe(3);
  });

  it("answers no-changes and deletes the change set when the stack matches", async () => {
    const { sent, clients } = cloudFormation({
      failReason: "The submitted information didn't contain changes.",
    });
    expect(await previewBootstrapUpdate(TARGET, {}, clients)).toEqual({ kind: "no-changes" });
    expect(sent.map((s) => s.name)).toContain(DeleteChangeSetCommand.name);
  });

  it("names the reason when the change set fails, and deletes it", async () => {
    const { sent, clients } = cloudFormation({ failReason: "Template format error" });
    await expect(previewBootstrapUpdate(TARGET, {}, clients)).rejects.toThrow(
      "Error: the change set failed: Template format error",
    );
    expect(sent.map((s) => s.name)).toContain(DeleteChangeSetCommand.name);
  });

  it("with verbose, shows each changed property's diff and the template diff", async () => {
    const { clients } = cloudFormation({ changes: [change("UserPool", "Modify")] });
    const preview = await previewBootstrapUpdate(TARGET, { verbose: true }, clients);
    const text = preview.kind === "changes" ? (preview.details ?? []).join("\n") : "";
    expect(text).toContain("== UserPool (AWS::Cognito::UserPool): Modify, replacement False");
    expect(text).toContain("/Properties/EmailMessage: Modify, Static");
    expect(text).toContain("-Welcome to Home");
    expect(text).toContain("+Welcome to Family");
    expect(text).toContain("== Template diff (deployed → new), for reference");
  });
});

describe("verboseDetails", () => {
  it("says a value CloudFormation resolves during the update has no before or after", () => {
    const plain = [change("Role", "Modify")];
    const lines = verboseDetails(plain, [], "a", "b").join("\n");
    expect(lines).toContain(
      "(CloudFormation resolves this value during the update and lists no before or after)",
    );
  });
});

describe("applyChangeSet", () => {
  it("executes the previewed change set", async () => {
    const { sent, clients } = cloudFormation({});
    await applyChangeSet(TARGET, "update-bootstrap-test", clients);
    expect(sent.find((s) => s.name === ExecuteChangeSetCommand.name)?.input).toEqual({
      StackName: "sk-bootstrap",
      ChangeSetName: "update-bootstrap-test",
    });
  });

  it("names the final status, the rollback and the events command when the update fails", async () => {
    const { clients } = cloudFormation({ stackStatus: "UPDATE_ROLLBACK_COMPLETE" });
    await expect(applyChangeSet(TARGET, "update-bootstrap-test", clients)).rejects.toThrow(
      "Error: the update ended in UPDATE_ROLLBACK_COMPLETE. CloudFormation rolls a failed update back to the previous template.\n" +
        "The stack's events name the failing resource:\n" +
        "  aws cloudformation describe-stack-events --stack-name sk-bootstrap --region us-east-2 --max-items 20",
    );
  });
});
