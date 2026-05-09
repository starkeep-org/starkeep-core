import { renderStatementsYaml } from "../iam-utils.js";
import { managerPolicyStatements } from "./manager-policy.js";
import { adminAppPolicyStatements } from "./admin-app-policy.js";
import { appPermissionsBoundaryStatements } from "./permissions-boundary.js";

export interface GenerateBootstrapTemplateInput {
  stackPrefix?: string;
}

/**
 * Single bootstrap CloudFormation template.
 *
 * Deploys into the user's own AWS account and creates the four foundational
 * roles, Cognito auth, and the Pulumi-state S3 bucket.
 * No "self-hosted vs SaaS" mode parameter — there is only one mode.
 *
 * Roles created:
 *   1. ${StackPrefix}-app-admin-role — federated entry point + admin app runtime
 *   2. ${StackPrefix}-manager-role   — pure-delegation role for install/uninstall
 *   3. Permissions boundary managed policy for Manager-minted per-app roles
 */
export function generateBootstrapTemplate(
  input: GenerateBootstrapTemplateInput = {},
): string {
  const stackPrefix = input.stackPrefix ?? "starkeep";

  const adminAppPolicyYaml = renderStatementsYaml(
    adminAppPolicyStatements(stackPrefix),
    14,
  );
  const managerPolicyYaml = renderStatementsYaml(
    managerPolicyStatements(stackPrefix),
    14,
  );
  const boundaryPolicyYaml = renderStatementsYaml(
    appPermissionsBoundaryStatements(stackPrefix),
    10,
  );
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: >
  Starkeep Bootstrap — creates Cognito auth, IAM roles (admin-app, manager),
  the permissions boundary for per-app roles, and the
  Pulumi-state S3 bucket. Run once per AWS account.

Parameters:
  StackPrefix:
    Type: String
    Default: ${stackPrefix}
    Description: Prefix for all Starkeep-managed resource names.
    MinLength: 1
    MaxLength: 20
    AllowedPattern: '^[a-z][a-z0-9-]*$'

Resources:

  # ---------------------------------------------------------------------------
  # Cognito User Pool
  # ---------------------------------------------------------------------------
  UserPool:
    Type: AWS::Cognito::UserPool
    Properties:
      UserPoolName: !Sub '\${StackPrefix}-auth'
      AdminCreateUserConfig:
        AllowAdminCreateUserOnly: true
        InviteMessageTemplate:
          EmailSubject: 'Your Starkeep account'
          EmailMessage: >
            Your Starkeep account has been created. Your temporary password is
            {####}. Sign in with username {username}.
      AutoVerifiedAttributes:
        - email
      UsernameAttributes:
        - email
      Schema:
        - Name: email
          AttributeDataType: String
          Required: true
          Mutable: false
      EmailConfiguration:
        EmailSendingAccount: COGNITO_DEFAULT
      Policies:
        PasswordPolicy:
          MinimumLength: 8
          RequireUppercase: false
          RequireLowercase: false
          RequireNumbers: false
          RequireSymbols: false
      UserPoolTags:
        starkeep:managed: 'true'
        StackPrefix: !Ref StackPrefix

  UserPoolClient:
    Type: AWS::Cognito::UserPoolClient
    Properties:
      ClientName: !Sub '\${StackPrefix}-admin'
      UserPoolId: !Ref UserPool
      GenerateSecret: false
      ExplicitAuthFlows:
        - ALLOW_USER_PASSWORD_AUTH
        - ALLOW_REFRESH_TOKEN_AUTH
      TokenValidityUnits:
        RefreshToken: days
      RefreshTokenValidity: 30
      PreventUserExistenceErrors: ENABLED

  # ---------------------------------------------------------------------------
  # Cognito Identity Pool — exchanges Cognito ID tokens for STS credentials
  # ---------------------------------------------------------------------------
  IdentityPool:
    Type: AWS::Cognito::IdentityPool
    Properties:
      IdentityPoolName: !Sub '\${StackPrefix}_admin'
      AllowUnauthenticatedIdentities: false
      CognitoIdentityProviders:
        - ClientId: !Ref UserPoolClient
          ProviderName: !Sub 'cognito-idp.\${AWS::Region}.amazonaws.com/\${UserPool}'
          ServerSideTokenCheck: false

  # ---------------------------------------------------------------------------
  # App Permissions Boundary — applied to every Manager-minted per-app role
  # ---------------------------------------------------------------------------
  AppPermissionsBoundary:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: !Sub '\${StackPrefix}-app-permissions-boundary'
      Description: >-
        Maximum permissions any Manager-minted per-app role may hold.
        Scopes S3 to the app's own prefix via PrincipalTag, denies all IAM.
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
${boundaryPolicyYaml}

  # ---------------------------------------------------------------------------
  # Admin App Role — federated entry point + admin-app runtime identity
  # NOT under the permissions boundary (it's bootstrap-created).
  # ---------------------------------------------------------------------------
  AdminAppRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub '\${StackPrefix}-app-admin-role'
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Federated: cognito-identity.amazonaws.com
            Action: sts:AssumeRoleWithWebIdentity
            Condition:
              StringEquals:
                'cognito-identity.amazonaws.com:aud': !Ref IdentityPool
              ForAnyValue:StringLike:
                'cognito-identity.amazonaws.com:amr': authenticated
      Policies:
        - PolicyName: StarkeepAdminAppPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
${adminAppPolicyYaml}
      Tags:
        - Key: starkeep:managed
          Value: 'true'
        - Key: starkeep:appId
          Value: admin
        - Key: StackPrefix
          Value: !Ref StackPrefix

  IdentityPoolRoleAttachment:
    Type: AWS::Cognito::IdentityPoolRoleAttachment
    Properties:
      IdentityPoolId: !Ref IdentityPool
      Roles:
        authenticated: !GetAtt AdminAppRole.Arn

  # ---------------------------------------------------------------------------
  # Manager Role — pure delegation; no data-plane actions
  # ---------------------------------------------------------------------------
  ManagerRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub '\${StackPrefix}-manager-role'
      Description: >-
        Mints and revokes per-app IAM roles within the permissions boundary.
        Cannot read or write user data.
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS: !GetAtt AdminAppRole.Arn
            Action: sts:AssumeRole
      Policies:
        - PolicyName: StarkeepManagerPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
${managerPolicyYaml}
      Tags:
        - Key: starkeep:managed
          Value: 'true'
        - Key: StackPrefix
          Value: !Ref StackPrefix

  # ---------------------------------------------------------------------------
  # Pulumi state bucket for per-app stack state
  # ---------------------------------------------------------------------------
  PulumiStateBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${StackPrefix}-pulumi-state-\${AWS::AccountId}'
      VersioningConfiguration:
        Status: Enabled
      Tags:
        - Key: starkeep:managed
          Value: 'true'
        - Key: StackPrefix
          Value: !Ref StackPrefix

  PulumiPassphrase:
    Type: AWS::SSM::Parameter
    Properties:
      Name: !Sub '/\${StackPrefix}/pulumi/passphrase'
      Type: String
      Value: 'REPLACE_WITH_RANDOM_32_BYTE_VALUE'
      Description: >-
        Pulumi stack-state encryption passphrase. Replace Value with a random
        32-byte string before deploying (or use a post-deploy custom resource).
      Tags:
        starkeep:managed: 'true'

Outputs:
  UserPoolId:
    Description: Cognito User Pool ID
    Value: !Ref UserPool

  UserPoolClientId:
    Description: Cognito App Client ID
    Value: !Ref UserPoolClient

  IdentityPoolId:
    Description: Cognito Identity Pool ID
    Value: !Ref IdentityPool

  AdminAppRoleArn:
    Description: ARN of the admin-app role (federated entry point)
    Value: !GetAtt AdminAppRole.Arn

  ManagerRoleArn:
    Description: ARN of the Manager role (pure-delegation install/uninstall)
    Value: !GetAtt ManagerRole.Arn

  AppPermissionsBoundaryArn:
    Description: ARN of the permissions boundary for Manager-minted per-app roles
    Value: !Ref AppPermissionsBoundary

  PulumiStateBucketName:
    Description: S3 bucket for Pulumi per-app stack state
    Value: !Ref PulumiStateBucket

  Region:
    Description: AWS region where this stack was deployed
    Value: !Ref AWS::Region

  StackPrefix:
    Description: Stack prefix used for all Starkeep resources
    Value: !Ref StackPrefix

  ConsoleLink:
    Description: >
      Click to create your Starkeep user account in the Cognito console.
    Value: !Sub >
      https://\${AWS::Region}.console.aws.amazon.com/cognito/v2/idp/user-pools/\${UserPool}/users/create

`;
}

export function getCloudFormationCreateStackUrl(region: string): string {
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create/template`;
}

export function getBootstrapStackOutputsUrl(
  region: string,
  stackName = "starkeep-bootstrap",
): string {
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?filteringStatus=active&filteringText=${encodeURIComponent(stackName)}&viewNested=true&hideStacks=false`;
}
