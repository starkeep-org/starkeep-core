/**
 * Generate the CloudFormation bootstrap template for self-hosted Starkeep.
 *
 * This is a one-time setup stack that creates Cognito auth, the desktop and
 * CodeBuild IAM roles, and the CodeBuild deploy project. It does NOT contain
 * the SST-deploy permissions — those live in a separate "deploy permissions"
 * stack ({stackPrefix}-deploy-permissions) created and updated by admin-web.
 *
 * Why two stacks: iterating on permissions is a frequent need (new SST
 * versions, new app capabilities), and CloudFormation updates to a stack
 * that owns Cognito + IAM + S3 + CodeBuild often fail with rollback errors
 * that leave the user re-bootstrapping from scratch. Splitting the policy
 * into its own tiny stack lets admin-web update permissions safely.
 *
 * The desktop role's bootstrap inline policy grants only what's needed to:
 *   - Use admin-web (Cognito user mgmt, sts:GetCallerIdentity)
 *   - Trigger remote CodeBuild deploys + upload source artifacts
 *   - Manage the {stackPrefix}-deploy-permissions stack itself, with an
 *     iam:AttachRolePolicy condition that restricts attachable policies to
 *     ones whose name starts with "{stackPrefix}-deploy-permissions". This
 *     is the security boundary: a compromised admin-web cannot attach
 *     AdministratorAccess to its own role.
 */

import { renderStatementsYaml, type IamStatement } from "./self-hosted-deploy-policy.js";

export interface GenerateSelfHostedBootstrapTemplateInput {
  stackPrefix?: string;
}

const SUB = (s: string) => ({ Sub: s }) as const;

function authRoleBootstrapStatements(): IamStatement[] {
  return [
    {
      Sid: "BootstrapStsIdentity",
      Effect: "Allow",
      Action: "sts:GetCallerIdentity",
      Resource: "*",
    },
    {
      Sid: "BootstrapCognitoUserMgmt",
      Effect: "Allow",
      Action: [
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminSetUserPassword",
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:ListUsers",
        "cognito-idp:DescribeUserPool",
        "cognito-idp:DescribeUserPoolClient",
      ],
      Resource: { GetAtt: "UserPool.Arn" },
    },
    {
      Sid: "BootstrapCodeBuildTrigger",
      Effect: "Allow",
      Action: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
      Resource: { GetAtt: "DeployProject.Arn" },
    },
    {
      Sid: "BootstrapArtifactsWrite",
      Effect: "Allow",
      Action: ["s3:PutObject", "s3:GetObject"],
      Resource: SUB("arn:aws:s3:::${StackPrefix}-deploy-artifacts/*"),
    },
    {
      Sid: "PermissionsStackManage",
      Effect: "Allow",
      Action: [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:ValidateTemplate",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ListChangeSets",
        "cloudformation:ListStackResources",
        "cloudformation:DetectStackDrift",
        "cloudformation:DescribeStackDriftDetectionStatus",
        "cloudformation:DescribeStackResourceDrifts",
      ],
      Resource: SUB(
        "arn:aws:cloudformation:*:${AWS::AccountId}:stack/${StackPrefix}-deploy-permissions/*",
      ),
    },
    {
      Sid: "PermissionsManagedPolicyMutate",
      Effect: "Allow",
      Action: [
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:ListPolicyVersions",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:GetPolicyVersion",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      Resource: SUB(
        "arn:aws:iam::${AWS::AccountId}:policy/${StackPrefix}-deploy-permissions*",
      ),
    },
    {
      // Security boundary: the desktop role can attach/detach policies on the
      // bootstrap-created roles, but only policies whose name starts with
      // "{StackPrefix}-deploy-permissions". A compromised admin-web cannot
      // attach AdministratorAccess or any other arbitrary policy.
      Sid: "PermissionsAttachConstrained",
      Effect: "Allow",
      Action: ["iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:ListAttachedRolePolicies"],
      Resource: [
        SUB("arn:aws:iam::${AWS::AccountId}:role/${StackPrefix}-admin-desktop-role"),
        SUB("arn:aws:iam::${AWS::AccountId}:role/${StackPrefix}-codebuild-deploy-role"),
      ],
      Condition: {
        ArnLike: {
          "iam:PolicyARN": SUB(
            "arn:aws:iam::${AWS::AccountId}:policy/${StackPrefix}-deploy-permissions*",
          ),
        },
      },
    },
  ];
}

function codeBuildRoleBootstrapStatements(): IamStatement[] {
  return [
    {
      Sid: "ArtifactsBucketRead",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:GetObjectVersion"],
      Resource: SUB("arn:aws:s3:::${StackPrefix}-deploy-artifacts/*"),
    },
    {
      Sid: "OwnLogGroup",
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
      ],
      Resource: [
        SUB("arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${StackPrefix}*"),
        SUB("arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${StackPrefix}*:*"),
      ],
    },
  ];
}

export function generateSelfHostedBootstrapTemplate(
  input: GenerateSelfHostedBootstrapTemplateInput = {},
): string {
  const stackPrefix = input.stackPrefix ?? "starkeep";

  const authPolicyYaml = renderStatementsYaml(authRoleBootstrapStatements(), 14);
  const codeBuildPolicyYaml = renderStatementsYaml(codeBuildRoleBootstrapStatements(), 14);

  return `AWSTemplateFormatVersion: '2010-09-09'
Description: >
  Starkeep Self-Hosted Bootstrap — creates Cognito auth, the desktop and
  CodeBuild IAM roles (with only enough permissions to manage the deploy
  permissions stack), the artifacts S3 bucket, and the CodeBuild deploy
  project. The actual SST-deploy permissions live in a separate stack
  ({StackPrefix}-deploy-permissions) created and updated by admin-web.

Parameters:
  StackPrefix:
    Type: String
    Default: ${stackPrefix}
    Description: >
      Prefix for all Starkeep-managed resource names (e.g. "starkeep").
      Infrastructure deployed later will be named "{StackPrefix}-files", etc.
    MinLength: 1
    MaxLength: 20
    AllowedPattern: '^[a-z][a-z0-9-]*$'

Resources:

  # ---------------------------------------------------------------------------
  # Cognito User Pool — single-user, admin-created accounts only.
  # No self-signup: the user creates their account via the AWS console after
  # this stack deploys, using the ConsoleLink output below.
  # Cognito's built-in email service sends the temporary password (no SES needed).
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

  # App client used by admin-desktop (no secret — frontend SPA flow)
  UserPoolClient:
    Type: AWS::Cognito::UserPoolClient
    Properties:
      ClientName: !Sub '\${StackPrefix}-admin-desktop'
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
  # Cognito Identity Pool — exchanges Cognito ID tokens for temporary AWS
  # credentials, allowing admin-desktop to call AWS APIs directly.
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
  # Desktop role — assumed by Cognito-authenticated users via the Identity
  # Pool. Bootstrap-only inline policy: enough to use admin-web, trigger
  # remote builds, and manage the deploy-permissions stack. The actual
  # SST-deploy permissions are attached as a managed policy by the
  # {StackPrefix}-deploy-permissions stack.
  # ---------------------------------------------------------------------------
  AuthenticatedRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub '\${StackPrefix}-admin-desktop-role'
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
        - PolicyName: StarkeepBootstrapPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
${authPolicyYaml}
      Tags:
        - Key: starkeep:managed
          Value: 'true'
        - Key: StackPrefix
          Value: !Ref StackPrefix

  # Wire the authenticated role to the Identity Pool
  IdentityPoolRoleAttachment:
    Type: AWS::Cognito::IdentityPoolRoleAttachment
    Properties:
      IdentityPoolId: !Ref IdentityPool
      Roles:
        authenticated: !GetAtt AuthenticatedRole.Arn

  # ---------------------------------------------------------------------------
  # Deployment infrastructure — CodeBuild-based SST deploy
  #
  # admin-desktop uploads a versioned source zip to ArtifactsBucket, then
  # calls codebuild:StartBuild to deploy the user-data SST stack remotely.
  # ---------------------------------------------------------------------------

  # S3 bucket for the versioned deployment source zip (infra/user-data + handlers)
  ArtifactsBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${StackPrefix}-deploy-artifacts'
      VersioningConfiguration:
        Status: Enabled
      CorsConfiguration:
        CorsRules:
          - AllowedOrigins:
              - 'tauri://localhost'
              - 'https://tauri.localhost'
            AllowedMethods:
              - GET
              - PUT
              - HEAD
            AllowedHeaders:
              - '*'
            MaxAge: 3000
      Tags:
        - Key: starkeep:managed
          Value: 'true'
        - Key: StackPrefix
          Value: !Ref StackPrefix

  # CodeBuild service role — bootstrap-only inline policy: enough to read the
  # source zip and write its own log group. The actual SST-deploy permissions
  # are attached as a managed policy by the {StackPrefix}-deploy-permissions
  # stack.
  CodeBuildServiceRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub '\${StackPrefix}-codebuild-deploy-role'
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: codebuild.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: StarkeepCodeBuildBootstrapPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
${codeBuildPolicyYaml}
      Tags:
        - Key: starkeep:managed
          Value: 'true'
        - Key: StackPrefix
          Value: !Ref StackPrefix

  # CodeBuild project — pulls the source zip from S3 and runs sst deploy.
  # admin-desktop triggers builds via codebuild:StartBuild, overriding STAGE
  # and the Cognito env vars so each user deploys their own named stack.
  DeployProject:
    Type: AWS::CodeBuild::Project
    Properties:
      Name: !Sub '\${StackPrefix}-deploy'
      Description: Deploys Starkeep user-data infrastructure via SST
      ServiceRole: !GetAtt CodeBuildServiceRole.Arn
      Source:
        Type: S3
        Location: !Sub '\${StackPrefix}-deploy-artifacts/\${StackPrefix}-user-data-source.zip'
        BuildSpec: |
          version: 0.2
          phases:
            install:
              runtime-versions:
                nodejs: 22
              commands:
                - npm ci
                - |
                  for pkg in sst pg @aws-sdk/dsql-signer; do
                    if [ ! -d "node_modules/$pkg" ]; then
                      echo "::error:: node_modules/$pkg missing after npm ci — lockfile is likely broken"
                      ls node_modules | head -20
                      exit 1
                    fi
                  done
                  echo "All critical dependencies present."
            build:
              commands:
                - bash -c 'set -o pipefail && node ./node_modules/sst/bin/sst.mjs deploy --stage $STAGE 2>&1 | tee /tmp/deploy-output.txt'
            post_build:
              commands:
                - aws s3 cp /tmp/deploy-output.txt s3://\${STACK_PREFIX}-deploy-artifacts/\${STAGE}-raw-output.txt || true
      Artifacts:
        Type: NO_ARTIFACTS
      Environment:
        Type: LINUX_CONTAINER
        Image: aws/codebuild/standard:8.0
        ComputeType: BUILD_GENERAL1_SMALL
        EnvironmentVariables:
          - Name: STAGE
            Value: placeholder
          - Name: STACK_PREFIX
            Value: !Ref StackPrefix
          - Name: USER_POOL_ID
            Value: !Ref UserPool
          - Name: USER_POOL_CLIENT_ID
            Value: !Ref UserPoolClient
      TimeoutInMinutes: 15
      Tags:
        - Key: starkeep:managed
          Value: 'true'
        - Key: StackPrefix
          Value: !Ref StackPrefix

Outputs:
  UserPoolId:
    Description: Cognito User Pool ID — enter this in admin-desktop setup
    Value: !Ref UserPool

  UserPoolClientId:
    Description: Cognito App Client ID — enter this in admin-desktop setup
    Value: !Ref UserPoolClient

  IdentityPoolId:
    Description: Cognito Identity Pool ID — enter this in admin-desktop setup
    Value: !Ref IdentityPool

  Region:
    Description: AWS region where this stack was deployed
    Value: !Ref AWS::Region

  StackPrefix:
    Description: Stack prefix used for all Starkeep resources
    Value: !Ref StackPrefix

  ConsoleLink:
    Description: >
      Click this link to create your Starkeep user account in the Cognito console.
      After creating your account, return to admin-desktop to sign in.
    Value: !Sub >
      https://\${AWS::Region}.console.aws.amazon.com/cognito/v2/idp/user-pools/\${UserPool}/users/create

  ArtifactsBucketName:
    Description: >
      S3 bucket for deployment source zips. admin-desktop uploads the user-data
      source package here before triggering the CodeBuild deploy job.
    Value: !Sub '\${StackPrefix}-deploy-artifacts'

  CodeBuildProjectName:
    Description: >
      CodeBuild project that runs sst deploy. Triggered by admin-desktop via
      codebuild:StartBuild with STAGE and Cognito env var overrides.
    Value: !Ref DeployProject

  PermissionsStackName:
    Description: >
      Name of the deploy-permissions CloudFormation stack that admin-web
      creates and updates to grant the SST-deploy permissions to the desktop
      and CodeBuild roles.
    Value: !Sub '\${StackPrefix}-deploy-permissions'

  AuthenticatedRoleName:
    Description: Name of the desktop IAM role
    Value: !Ref AuthenticatedRole

  CodeBuildServiceRoleName:
    Description: Name of the CodeBuild service IAM role
    Value: !Ref CodeBuildServiceRole
`;
}

/**
 * Generate the CloudFormation "Create stack" console URL for the bootstrap template.
 * Since the template is bundled with admin-desktop and written to a local file,
 * this returns the base URL to the CloudFormation "create stack" page in the
 * specified region. The user uploads the template file from there.
 */
export function getCloudFormationCreateStackUrl(region: string): string {
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create/template`;
}

/**
 * Generate the CloudFormation stack outputs URL for a deployed bootstrap stack.
 * Used in the setup wizard to direct the user to where they can copy the outputs.
 */
export function getBootstrapStackOutputsUrl(region: string, stackName = "starkeep-bootstrap"): string {
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?filteringStatus=active&filteringText=${encodeURIComponent(stackName)}&viewNested=true&hideStacks=false`;
}
