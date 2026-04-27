/**
 * Generate the CloudFormation template for the Starkeep deploy-permissions
 * stack. This stack is created and updated by admin-web post-bootstrap; it
 * contains a single managed policy attached to both the desktop role and the
 * CodeBuild service role.
 *
 * The bootstrap stack ({stackPrefix}-bootstrap) only grants the desktop role
 * permission to manage *this* stack — not the deploy permissions themselves.
 * That decoupling lets the user add or remove permissions over time without
 * touching the bootstrap stack.
 */

import {
  deployPermissionStatements,
  renderStatementsYaml,
} from "./self-hosted-deploy-policy.js";

export interface GenerateSelfHostedPermissionsTemplateInput {
  stackPrefix?: string;
}

export function generateSelfHostedPermissionsTemplate(
  input: GenerateSelfHostedPermissionsTemplateInput = {},
): string {
  const stackPrefix = input.stackPrefix ?? "starkeep";

  const statementsYaml = renderStatementsYaml(deployPermissionStatements(), 8);

  return `AWSTemplateFormatVersion: '2010-09-09'
Description: >
  Starkeep deploy permissions — managed policy attached to the desktop role
  and CodeBuild service role created by the bootstrap stack. Updated by
  admin-web whenever the policy spec changes; iterating on permissions does
  not require teardown of the bootstrap stack.

Parameters:
  StackPrefix:
    Type: String
    Default: ${stackPrefix}
    Description: >
      Prefix for Starkeep-managed resource names. Must match the StackPrefix
      used in the bootstrap stack — the managed policy attaches to roles
      named "{StackPrefix}-admin-desktop-role" and
      "{StackPrefix}-codebuild-deploy-role".
    MinLength: 1
    MaxLength: 20
    AllowedPattern: '^[a-z][a-z0-9-]*$'

Resources:

  DeployPermissionsPolicy:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: !Sub '\${StackPrefix}-deploy-permissions'
      Description: >-
        Permissions required to deploy and operate the Starkeep user-data SST
        stack. Source of truth: @starkeep/admin-core deployPermissionStatements().
      Roles:
        - !Sub '\${StackPrefix}-admin-desktop-role'
        - !Sub '\${StackPrefix}-codebuild-deploy-role'
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
${statementsYaml}

Outputs:
  ManagedPolicyArn:
    Description: ARN of the deploy permissions managed policy
    Value: !Ref DeployPermissionsPolicy

  StackPrefix:
    Description: Stack prefix this permissions stack belongs to
    Value: !Ref StackPrefix
`;
}
