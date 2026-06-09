import { renderStatementsYaml } from "../iam-utils.js";
import { managerPolicyStatements } from "./manager-policy.js";
import { adminAppPolicyStatements } from "./admin-app-policy.js";
import { appPermissionsBoundaryStatements } from "./permissions-boundary.js";
import { foundationalPermissionsBoundaryStatements } from "./foundational-permissions-boundary.js";
import { userDataOwnerPermissionsBoundaryStatements } from "./user-data-owner-permissions-boundary.js";
import { installDdlBoundaryStatements } from "./install-ddl-boundary.js";
import { installInfraBoundaryStatements } from "./install-infra-boundary.js";

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
  const foundationalBoundaryPolicyYaml = renderStatementsYaml(
    foundationalPermissionsBoundaryStatements(stackPrefix),
    10,
  );
  const userDataOwnerBoundaryPolicyYaml = renderStatementsYaml(
    userDataOwnerPermissionsBoundaryStatements(stackPrefix),
    10,
  );
  const installDdlBoundaryPolicyYaml = renderStatementsYaml(
    installDdlBoundaryStatements(stackPrefix),
    10,
  );
  const installInfraBoundaryPolicyYaml = renderStatementsYaml(
    installInfraBoundaryStatements(stackPrefix),
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
  # Foundational Permissions Boundary — attached only to the cloud-data-server
  # role, which provisions the foundational cloud resources (DSQL cluster, files
  # bucket, API Gateway). Wider than the regular boundary but tightly scoped
  # to \${StackPrefix}-app-cloud-data-server-* resource names.
  # ---------------------------------------------------------------------------
  AppFoundationalPermissionsBoundary:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: !Sub '\${StackPrefix}-foundational-permissions-boundary'
      Description: >-
        Maximum permissions for foundational app roles (currently just
        cloud-data-server). Permits DSQL cluster admin, S3 bucket admin on
        ${stackPrefix}-{files,billing}-*, Lambda + log-group + apigatewayv2
        + CUR scoped to cloud-data-server, and iam:PassRole own-role-to-lambda.
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
${foundationalBoundaryPolicyYaml}

  # ---------------------------------------------------------------------------
  # User-Data-Owner Permissions Boundary — attached only to the Starkeep Drive
  # role (app id \`starkeep-drive\`), minted at Drive install (not at bootstrap).
  # Wider than the per-app boundary only in that it permits read/write across
  # the whole shared-data prefix (shared/*) — the layer-2 hard floor for
  # shared-record custody. No Lambda, no API Gateway, no per-app schema, no DSQL
  # cluster admin, no IAM mutation. A magic-string check in the installer routes
  # only the \`starkeep-drive\` app id to this boundary.
  # ---------------------------------------------------------------------------
  UserDataOwnerPermissionsBoundary:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: !Sub '\${StackPrefix}-user-data-owner-permissions-boundary'
      Description: >-
        Maximum permissions for the User-Data-Owner (Starkeep Drive) role.
        Permits dsql:DbConnect and S3 read/write/list on ${stackPrefix}-files-*
        under the shared/* prefix only. No Lambda, API Gateway, or IAM mutation.
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
${userDataOwnerBoundaryPolicyYaml}

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
  # Install-DDL Permissions Boundary — ceiling for the install-ddl-role
  # ---------------------------------------------------------------------------
  InstallDdlPermissionsBoundary:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: !Sub '\${StackPrefix}-install-ddl-permissions-boundary'
      Description: >-
        Maximum permissions the install-ddl-role may hold. Permits only
        dsql:DbConnectAdmin (used during app install/uninstall DDL) and
        explicitly denies all IAM mutations for defense-in-depth.
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
${installDdlBoundaryPolicyYaml}

  # ---------------------------------------------------------------------------
  # Install-DDL Role — the only identity that can connect to DSQL as PG admin.
  # No standing permissions; Manager attaches a per-app temp policy around DDL.
  # ---------------------------------------------------------------------------
  InstallDdlRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub '\${StackPrefix}-install-ddl-role'
      Description: >-
        Dedicated role for running app install/uninstall DDL as DSQL PG admin.
        Manager temporarily grants dsql:DbConnectAdmin via an inline policy
        around each install/uninstall; no standing permissions at steady state.
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS: !GetAtt ManagerRole.Arn
            Action: sts:AssumeRole
      PermissionsBoundary: !Ref InstallDdlPermissionsBoundary
      Tags:
        - Key: starkeep:managed
          Value: 'true'
        - Key: StackPrefix
          Value: !Ref StackPrefix

  # ---------------------------------------------------------------------------
  # Install-Infra Permissions Boundary — ceiling for the install-infra-role
  # ---------------------------------------------------------------------------
  InstallInfraPermissionsBoundary:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: !Sub '\${StackPrefix}-install-infra-permissions-boundary'
      Description: >-
        Maximum permissions the install-infra-role may hold. Permits per-app
        Lambda admin, CloudWatch log-group admin, API Gateway v2
        integration/route admin, Pulumi state bucket access, and PassRole of
        per-app roles to Lambda. Mutating IAM is denied for defense-in-depth.
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
${installInfraBoundaryPolicyYaml}

  # ---------------------------------------------------------------------------
  # Install-Infra Role — centralized identity that runs per-app Pulumi
  # provisioning. Manager attaches a temp policy scoped to the app being
  # installed, then detaches it. No standing permissions at steady state.
  # ---------------------------------------------------------------------------
  InstallInfraRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub '\${StackPrefix}-install-infra-role'
      Description: >-
        Dedicated role for running per-app compute-stack Pulumi provisioning.
        Manager attaches temp-install-infra-<appId> inline policies for each
        install/uninstall and detaches them after; no standing permissions.
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS: !GetAtt ManagerRole.Arn
            Action: sts:AssumeRole
      PermissionsBoundary: !Ref InstallInfraPermissionsBoundary
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
      BucketName: !Sub '\${StackPrefix}-pulumi-state-\${AWS::AccountId}-\${AWS::Region}'
      VersioningConfiguration:
        Status: Enabled
      Tags:
        - Key: starkeep:managed
          Value: 'true'
        - Key: StackPrefix
          Value: !Ref StackPrefix

  # ---------------------------------------------------------------------------
  # Artifacts bucket — deployment-bundle store
  # ---------------------------------------------------------------------------
  # Holds each app's compiled Lambda bundle (apps/<appId>/latest/dist.zip).
  # install-infra uploads here during install; aws.lambda.Function reads from
  # here at function create/update; install-infra deletes the prefix on
  # uninstall. Not data-plane — never holds user data.
  #
  # Name is suffixed with account+region to keep it globally unique, matching
  # the PulumiStateBucket pattern. Policies that grant access use a
  # \`\${StackPrefix}-artifacts-*\` wildcard to absorb the suffix.
  ArtifactsBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${StackPrefix}-artifacts-\${AWS::AccountId}-\${AWS::Region}'
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
      Type: SecureString
      Value: 'REPLACE_WITH_RANDOM_32_BYTE_VALUE'
      Description: >-
        Pulumi stack-state encryption passphrase. The placeholder Value is
        overwritten on first cloud-data-server install by a per-deployment
        random value (see admin-installer rotatePulumiPassphraseIfPlaceholder).
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

  AppFoundationalPermissionsBoundaryArn:
    Description: ARN of the wider permissions boundary for foundational app roles (cloud-data-server)
    Value: !Ref AppFoundationalPermissionsBoundary

  UserDataOwnerPermissionsBoundaryArn:
    Description: ARN of the permissions boundary for the User-Data-Owner (Starkeep Drive) role
    Value: !Ref UserDataOwnerPermissionsBoundary

  InstallDdlRoleArn:
    Description: ARN of the install-DDL role (the only identity that can connect to DSQL as PG admin)
    Value: !GetAtt InstallDdlRole.Arn

  InstallInfraRoleArn:
    Description: ARN of the install-infra role (centralized per-app compute provisioning identity)
    Value: !GetAtt InstallInfraRole.Arn

  PulumiStateBucketName:
    Description: S3 bucket for Pulumi per-app stack state
    Value: !Ref PulumiStateBucket

  ArtifactsBucketName:
    Description: S3 bucket holding compiled Lambda bundles per installed app
    Value: !Ref ArtifactsBucket

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

export function getCloudFormationCreateStackUrl(
  region: string,
  opts?: { stackName?: string },
): string {
  const base = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create/template`;
  const stackName = opts?.stackName;
  return stackName ? `${base}?stackName=${encodeURIComponent(stackName)}` : base;
}

export function getBootstrapStackOutputsUrl(
  region: string,
  stackName = "starkeep-bootstrap",
): string {
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?filteringStatus=active&filteringText=${encodeURIComponent(stackName)}&viewNested=true&hideStacks=false`;
}
