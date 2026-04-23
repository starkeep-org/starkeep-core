/**
 * Generate CloudFormation template for self-hosted Starkeep bootstrap.
 *
 * Unlike the SaaS bootstrap template (bootstrap-template.ts), which sets up
 * cross-account IAM roles so a separate Starkeep control-plane AWS account can
 * manage the customer's infrastructure, this template is for self-hosted mode:
 * the user's own machine (running admin-desktop) IS the control plane.
 *
 * No cross-account roles are needed. Instead, this template creates:
 *   - A Cognito User Pool for authenticating the user
 *   - A Cognito Identity Pool to exchange Cognito tokens for temporary AWS
 *     credentials (STS), scoped via an IAM role
 *   - An IAM role for authenticated Cognito users with the permissions needed
 *     to deploy data infrastructure (S3, Aurora DSQL) and manage Cognito users
 *
 * The resulting AWS credentials let admin-desktop trigger a CodeBuild job to
 * provision the user's Starkeep data infrastructure via SST deploy.
 *
 * In addition to Cognito and IAM, this template now creates:
 *   - An S3 artifacts bucket for the versioned deployment source zip
 *   - A CodeBuild service role with the permissions needed to run sst deploy
 *   - A CodeBuild project that pulls the source zip and runs sst deploy
 */

export interface GenerateSelfHostedBootstrapTemplateInput {
  stackPrefix?: string;
}

export function generateSelfHostedBootstrapTemplate(
  input: GenerateSelfHostedBootstrapTemplateInput = {}
): string {
  const stackPrefix = input.stackPrefix ?? "starkeep";

  return `AWSTemplateFormatVersion: '2010-09-09'
Description: >
  Starkeep Self-Hosted Bootstrap — creates Cognito auth and IAM permissions
  for admin-desktop to manage this account's Starkeep data infrastructure.
  No cross-account roles are required; admin-desktop runs locally as the control plane.

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

  # IAM role assumed by authenticated Cognito users via the Identity Pool.
  # Scoped to resources prefixed with {StackPrefix}- to prevent accidental
  # access to unrelated account resources.
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
        - PolicyName: StarkeepAdminDesktopPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:

              # ---------------------------------------------------------------
              # SST deployment permissions — copied verbatim from
              # CodeBuildServiceRole below. Keep these two in sync.
              #
              # Three intentional differences from the CodeBuild role:
              #   1. CloudWatchLogsDeploy omits codebuild log group paths
              #      (no CodeBuild process runs locally).
              #   2. AuroraDsqlDeploy adds DbConnect + DbConnectAdmin so the
              #      user can connect to the cluster directly (CodeBuild does
              #      not need this).
              #   3. CodeBuildTrigger + ArtifactsBucketWrite are appended
              #      below for the remote-deploy path (CodeBuild has
              #      ArtifactsBucketRead instead).
              # ---------------------------------------------------------------

              # CloudWatch Logs — describe/list actions require Resource: *
              - Sid: CloudWatchLogsDescribe
                Effect: Allow
                Action:
                  - logs:DescribeLogGroups
                  - logs:DescribeLogStreams
                Resource: '*'

              # CloudWatch Logs — delivery lifecycle for API Gateway v2 access logging.
              # SST's ApiGatewayV2 unconditionally sets accessLogSettings on the $default stage,
              # which triggers these Vended Logs APIs against a service-level delivery resource —
              # they are NOT covered by the log-group-scoped statement below and require Resource: *.
              - Sid: CloudWatchLogsDelivery
                Effect: Allow
                Action:
                  - logs:CreateLogDelivery
                  - logs:GetLogDelivery
                  - logs:UpdateLogDelivery
                  - logs:DeleteLogDelivery
                  - logs:ListLogDeliveries
                  - logs:PutResourcePolicy
                  - logs:DescribeResourcePolicies
                Resource: '*'

              # CloudWatch Logs — write/tag actions scoped to SST-created log groups
              - Sid: CloudWatchLogsDeploy
                Effect: Allow
                Action: 'logs:*'
                Resource:
                  - !Sub 'arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/\${StackPrefix}*'
                  - !Sub 'arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/\${StackPrefix}*:*'
                  - !Sub 'arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/vendedlogs/apis/\${StackPrefix}*'
                  - !Sub 'arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/vendedlogs/apis/\${StackPrefix}*:*'

              # SSM — SST reads/writes its bootstrap config from Parameter Store
              - Sid: SstBootstrapSSM
                Effect: Allow
                Action:
                  - ssm:GetParameter
                  - ssm:PutParameter
                  - ssm:DeleteParameter
                Resource: !Sub 'arn:aws:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter/sst/*'

              # S3 — full access to user-data and SST state/asset buckets
              - Sid: S3DeployAccess
                Effect: Allow
                Action: 's3:*'
                Resource:
                  - !Sub 'arn:aws:s3:::\${StackPrefix}*'
                  - !Sub 'arn:aws:s3:::\${StackPrefix}*/*'
                  - 'arn:aws:s3:::sst-state-*'
                  - 'arn:aws:s3:::sst-state-*/*'
                  - 'arn:aws:s3:::sst-asset-*'
                  - 'arn:aws:s3:::sst-asset-*/*'

              - Sid: S3ListAllGlobal
                Effect: Allow
                Action: s3:ListAllMyBuckets
                Resource: '*'

              # CloudFormation — full stack lifecycle
              - Sid: CloudFormationDeploy
                Effect: Allow
                Action:
                  - cloudformation:CreateStack
                  - cloudformation:UpdateStack
                  - cloudformation:DeleteStack
                  - cloudformation:DescribeStacks
                  - cloudformation:DescribeStackEvents
                  - cloudformation:DescribeStackResources
                  - cloudformation:GetTemplate
                  - cloudformation:ValidateTemplate
                  - cloudformation:CreateChangeSet
                  - cloudformation:DescribeChangeSet
                  - cloudformation:ExecuteChangeSet
                  - cloudformation:DeleteChangeSet
                  - cloudformation:ListChangeSets
                  - cloudformation:ListStackResources
                  - cloudformation:ListStacks
                  - cloudformation:GetStackPolicy
                  - cloudformation:SetStackPolicy
                Resource: '*'

              # Aurora DSQL — create and manage the remote metadata cluster.
              # Superset of CodeBuild role: adds DbConnect + DbConnectAdmin for
              # direct cluster access from the desktop/server.
              - Sid: AuroraDsqlDeploy
                Effect: Allow
                Action:
                  - dsql:CreateCluster
                  - dsql:UpdateCluster
                  - dsql:DeleteCluster
                  - dsql:GetCluster
                  - dsql:ListClusters
                  - dsql:TagResource
                  - dsql:UntagResource
                  - dsql:ListTagsForResource
                  - dsql:GetVpcEndpointServiceName
                  - dsql:DbConnect
                  - dsql:DbConnectAdmin
                Resource: '*'

              # Lambda — full access scoped to StackPrefix functions; list ops need Resource: *
              - Sid: LambdaDeploy
                Effect: Allow
                Action: 'lambda:*'
                Resource: !Sub 'arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:\${StackPrefix}*'

              - Sid: LambdaListGlobal
                Effect: Allow
                Action:
                  - lambda:ListFunctions
                  - lambda:GetAccountSettings
                Resource: '*'

              # API Gateway v2 — create and manage the HTTP API
              - Sid: ApiGatewayDeploy
                Effect: Allow
                Action:
                  - apigateway:GET
                  - apigateway:POST
                  - apigateway:PUT
                  - apigateway:DELETE
                  - apigateway:PATCH
                  - apigateway:TagResource
                  - apigateway:UntagResource
                  - apigateway:ListTagsForResource
                Resource: '*'

              # IAM — create Lambda execution roles and pass them
              - Sid: IAMDeployRoles
                Effect: Allow
                Action:
                  - iam:CreateRole
                  - iam:DeleteRole
                  - iam:GetRole
                  - iam:UpdateRole
                  - iam:PutRolePolicy
                  - iam:DeleteRolePolicy
                  - iam:AttachRolePolicy
                  - iam:DetachRolePolicy
                  - iam:GetRolePolicy
                  - iam:ListRolePolicies
                  - iam:ListAttachedRolePolicies
                  - iam:ListInstanceProfilesForRole
                  - iam:TagRole
                  - iam:UntagRole
                Resource: !Sub 'arn:aws:iam::\${AWS::AccountId}:role/\${StackPrefix}*'

              - Sid: IAMListGlobal
                Effect: Allow
                Action:
                  - iam:ListRoles
                Resource: '*'

              - Sid: IAMPassRoleDeploy
                Effect: Allow
                Action: iam:PassRole
                Resource: !Sub 'arn:aws:iam::\${AWS::AccountId}:role/\${StackPrefix}*'
                Condition:
                  StringLike:
                    iam:PassedToService:
                      - cloudformation.amazonaws.com
                      - lambda.amazonaws.com
                      - apigateway.amazonaws.com

              # ---------------------------------------------------------------
              # Authenticated Role-only permissions (not in CodeBuild role)
              # ---------------------------------------------------------------

              # Cognito user management — create the initial user account and
              # manage sessions from the desktop app.
              - Sid: CognitoUserManagement
                Effect: Allow
                Action:
                  - cognito-idp:AdminCreateUser
                  - cognito-idp:AdminSetUserPassword
                  - cognito-idp:AdminGetUser
                  - cognito-idp:AdminDeleteUser
                  - cognito-idp:ListUsers
                  - cognito-idp:DescribeUserPool
                  - cognito-idp:DescribeUserPoolClient
                Resource: !GetAtt UserPool.Arn

              # CodeBuild — trigger remote deployments and poll build status
              - Sid: CodeBuildTrigger
                Effect: Allow
                Action:
                  - codebuild:StartBuild
                  - codebuild:BatchGetBuilds
                Resource: !GetAtt DeployProject.Arn

              # S3 — upload deployment source zip to the artifacts bucket
              - Sid: ArtifactsBucketWrite
                Effect: Allow
                Action:
                  - s3:PutObject
                  - s3:GetObject
                Resource: !Sub 'arn:aws:s3:::\${StackPrefix}-deploy-artifacts/*'

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
  # This replaces the previous approach of running npx sst deploy locally.
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

  # IAM service role for the CodeBuild project.
  # Needs all permissions required by sst deploy: CloudFormation, S3, DSQL,
  # Lambda, API Gateway, IAM (to create Lambda execution roles).
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
        - PolicyName: StarkeepCodeBuildDeployPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:

              # CloudWatch Logs — describe/list actions require Resource: * (AWS evaluates them against a bare ARN)
              - Sid: CloudWatchLogsDescribe
                Effect: Allow
                Action:
                  - logs:DescribeLogGroups
                  - logs:DescribeLogStreams
                Resource: '*'
              # CloudWatch Logs — delivery lifecycle for API Gateway v2 access logging.
              # SST's ApiGatewayV2 unconditionally sets accessLogSettings on the $default stage,
              # which triggers these Vended Logs APIs against a service-level delivery resource —
              # they are NOT covered by the log-group-scoped statement below and require Resource: *.
              - Sid: CloudWatchLogsDelivery
                Effect: Allow
                Action:
                  - logs:CreateLogDelivery
                  - logs:GetLogDelivery
                  - logs:UpdateLogDelivery
                  - logs:DeleteLogDelivery
                  - logs:ListLogDeliveries
                  - logs:PutResourcePolicy
                  - logs:DescribeResourcePolicies
                Resource: '*'
              # CloudWatch Logs — write/tag actions scoped to SST-created log groups
              - Sid: CloudWatchLogsDeploy
                Effect: Allow
                Action: 'logs:*'
                Resource:
                  - !Sub 'arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/codebuild/\${StackPrefix}*'
                  - !Sub 'arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/codebuild/\${StackPrefix}*:*'
                  - !Sub 'arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/\${StackPrefix}*'
                  - !Sub 'arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/\${StackPrefix}*:*'
                  - !Sub 'arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/vendedlogs/apis/\${StackPrefix}*'
                  - !Sub 'arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/vendedlogs/apis/\${StackPrefix}*:*'

              # SSM — SST reads/writes its bootstrap config from Parameter Store
              - Sid: SstBootstrapSSM
                Effect: Allow
                Action:
                  - ssm:GetParameter
                  - ssm:PutParameter
                  - ssm:DeleteParameter
                Resource: !Sub 'arn:aws:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter/sst/*'

              # S3 — read deployment source zip from artifacts bucket
              - Sid: ArtifactsBucketRead
                Effect: Allow
                Action:
                  - s3:GetObject
                  - s3:GetObjectVersion
                Resource: !Sub 'arn:aws:s3:::\${StackPrefix}-deploy-artifacts/*'

              # S3 — full access to user-data and SST state/asset buckets
              - Sid: S3DeployAccess
                Effect: Allow
                Action: 's3:*'
                Resource:
                  - !Sub 'arn:aws:s3:::\${StackPrefix}*'
                  - !Sub 'arn:aws:s3:::\${StackPrefix}*/*'
                  - 'arn:aws:s3:::sst-state-*'
                  - 'arn:aws:s3:::sst-state-*/*'
                  - 'arn:aws:s3:::sst-asset-*'
                  - 'arn:aws:s3:::sst-asset-*/*'
              - Sid: S3ListAllGlobal
                Effect: Allow
                Action: s3:ListAllMyBuckets
                Resource: '*'

              # CloudFormation — full stack lifecycle
              - Sid: CloudFormationDeploy
                Effect: Allow
                Action:
                  - cloudformation:CreateStack
                  - cloudformation:UpdateStack
                  - cloudformation:DeleteStack
                  - cloudformation:DescribeStacks
                  - cloudformation:DescribeStackEvents
                  - cloudformation:DescribeStackResources
                  - cloudformation:GetTemplate
                  - cloudformation:ValidateTemplate
                  - cloudformation:CreateChangeSet
                  - cloudformation:DescribeChangeSet
                  - cloudformation:ExecuteChangeSet
                  - cloudformation:DeleteChangeSet
                  - cloudformation:ListChangeSets
                  - cloudformation:ListStackResources
                  - cloudformation:ListStacks
                  - cloudformation:GetStackPolicy
                  - cloudformation:SetStackPolicy
                Resource: '*'

              # Aurora DSQL — create and manage the remote metadata cluster
              - Sid: AuroraDsqlDeploy
                Effect: Allow
                Action:
                  - dsql:CreateCluster
                  - dsql:UpdateCluster
                  - dsql:DeleteCluster
                  - dsql:GetCluster
                  - dsql:ListClusters
                  - dsql:TagResource
                  - dsql:UntagResource
                  - dsql:ListTagsForResource
                  - dsql:GetVpcEndpointServiceName
                Resource: '*'

              # Lambda — full access scoped to StackPrefix functions; list ops need Resource: *
              - Sid: LambdaDeploy
                Effect: Allow
                Action: 'lambda:*'
                Resource: !Sub 'arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:\${StackPrefix}*'
              - Sid: LambdaListGlobal
                Effect: Allow
                Action:
                  - lambda:ListFunctions
                  - lambda:GetAccountSettings
                Resource: '*'

              # API Gateway v2 — create and manage the HTTP API
              - Sid: ApiGatewayDeploy
                Effect: Allow
                Action:
                  - apigateway:GET
                  - apigateway:POST
                  - apigateway:PUT
                  - apigateway:DELETE
                  - apigateway:PATCH
                  - apigateway:TagResource
                  - apigateway:UntagResource
                  - apigateway:ListTagsForResource
                Resource: '*'

              # IAM — create Lambda execution roles and pass them
              - Sid: IAMDeployRoles
                Effect: Allow
                Action:
                  - iam:CreateRole
                  - iam:DeleteRole
                  - iam:GetRole
                  - iam:UpdateRole
                  - iam:PutRolePolicy
                  - iam:DeleteRolePolicy
                  - iam:AttachRolePolicy
                  - iam:DetachRolePolicy
                  - iam:GetRolePolicy
                  - iam:ListRolePolicies
                  - iam:ListAttachedRolePolicies
                  - iam:ListInstanceProfilesForRole
                  - iam:TagRole
                  - iam:UntagRole
                Resource: !Sub 'arn:aws:iam::\${AWS::AccountId}:role/\${StackPrefix}*'
              - Sid: IAMListGlobal
                Effect: Allow
                Action:
                  - iam:ListRoles
                Resource: '*'
              - Sid: IAMPassRoleDeploy
                Effect: Allow
                Action: iam:PassRole
                Resource: !Sub 'arn:aws:iam::\${AWS::AccountId}:role/\${StackPrefix}*'
                Condition:
                  StringLike:
                    iam:PassedToService:
                      - cloudformation.amazonaws.com
                      - lambda.amazonaws.com
                      - apigateway.amazonaws.com

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
