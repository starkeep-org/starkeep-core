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
  /**
   * The first admin's email, written as the `AdminEmail` default. The wizard
   * passes it only for a new deployment. A re-download for an existing stack
   * omits it, so the default stays empty.
   */
  adminEmail?: string;
}

/**
 * Maximum length of StackPrefix, enforced by the template's parameter
 * constraint and the admin-web wizard input.
 *
 * Not cosmetic: every `${stackPrefix}` occurrence in a permissions-boundary
 * managed policy grows with the prefix, and the foundational boundary is the
 * closest to AWS's hard 6144-char managed-policy size limit. At length 16 it
 * renders to ~6091 chars (~53 headroom); a longer cap would risk a
 * PolicySize deploy failure. `policies.test.ts` asserts every managed policy
 * fits at exactly this length, so the cap and the boundaries stay in lockstep.
 */
export const MAX_STACK_PREFIX_LENGTH = 16;

/**
 * Single bootstrap CloudFormation template.
 *
 * Deploys into the user's own AWS account and creates the four foundational
 * roles, Cognito auth, and the Pulumi-state S3 bucket.
 * No "self-hosted vs SaaS" mode parameter — there is only one mode.
 *
 * Roles created:
 *   1. \${StackPrefix}-app-admin-role — federated entry point + admin app runtime
 *   2. \${StackPrefix}-manager-role   — pure-delegation role for install/uninstall
 *   3. Permissions boundary managed policy for Manager-minted per-app roles
 */
export function generateBootstrapTemplate(input: GenerateBootstrapTemplateInput = {}): string {
  const stackPrefix = input.stackPrefix ?? "starkeep";
  // A single-quoted YAML scalar, so an address with an apostrophe stays valid.
  const adminEmailDefault = `'${(input.adminEmail ?? "").replace(/'/g, "''")}'`;

  const adminAppPolicyYaml = renderStatementsYaml(adminAppPolicyStatements(stackPrefix), 14);
  const managerPolicyYaml = renderStatementsYaml(managerPolicyStatements(stackPrefix), 14);
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
    MaxLength: ${MAX_STACK_PREFIX_LENGTH}
    AllowedPattern: '^[a-z][a-z0-9-]*$'
  # The wizard bakes in the email it asked for only when the operator creates a
  # new deployment. A re-download for an existing stack leaves the default
  # empty: a different email reaching an update would replace the first admin.
  AdminEmail:
    Type: String
    Default: ${adminEmailDefault}
    Description: >-
      Your email address. The stack creates your Starkeep account as its first
      admin and emails you a temporary password. Leave this as it is after the
      first deploy, and add other accounts in Starkeep Admin.

Conditions:
  HasAdminEmail: !Not [!Equals [!Ref AdminEmail, '']]

Resources:

  # Cognito User Pool
  UserPool:
    Type: AWS::Cognito::UserPool
    Properties:
      UserPoolName: !Sub '\${StackPrefix}-auth'
      # Essentials: managed login and passkeys. The live pool already runs it.
      UserPoolTier: ESSENTIALS
      AdminCreateUserConfig:
        AllowAdminCreateUserOnly: true
        InviteMessageTemplate:
          EmailSubject: 'Your Starkeep account'
          # Cognito sends this as HTML. The password sits alone in its own
          # paragraph, with no punctuation beside it, so a tap or a
          # double-click selects exactly the password, on a phone too.
          EmailMessage: >-
            <p>Your Starkeep account has been created.</p>
            <p>Your temporary password:</p>
            <p style="font-family: monospace; font-size: 18px">{####}</p>
            <p>Sign in with username {username}</p>
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

  # The device client. Desktops sign in here through the local data server and
  # sync with the ID token alone; phones use the mobile-apps client that the
  # cloud data server install creates. No OAuth flow, so no app gets a device
  # token without the password, and the identity pool does NOT trust this
  # client, so a device token reaches no AWS role. Ten-year refresh tokens,
  # since an expired one stops background sync silently; fifteen-minute ID
  # tokens bound how long a disabled or ungrouped user keeps syncing. Public
  # (no secret) with revocation on, so a device can revoke its own sign-in.
  DeviceUserPoolClient:
    Type: AWS::Cognito::UserPoolClient
    Properties:
      ClientName: !Sub '\${StackPrefix}-devices'
      UserPoolId: !Ref UserPool
      GenerateSecret: false
      ExplicitAuthFlows:
        - ALLOW_USER_PASSWORD_AUTH
        - ALLOW_REFRESH_TOKEN_AUTH
      TokenValidityUnits:
        IdToken: minutes
        AccessToken: minutes
        RefreshToken: days
      IdTokenValidity: 15
      AccessTokenValidity: 15
      RefreshTokenValidity: 3650
      EnableTokenRevocation: true
      PreventUserExistenceErrors: ENABLED

  # The managed login page's domain. Cloud apps and mobile apps sign in on it,
  # so no app code ever receives a password. The prefix carries the account
  # id because prefixes are unique per region across every AWS account. The
  # cloud data server install creates the two clients that use the page,
  # because their callbacks name the CloudFront domain, which exists only
  # after that install.
  UserPoolDomain:
    Type: AWS::Cognito::UserPoolDomain
    Properties:
      Domain: !Sub '\${StackPrefix}-\${AWS::AccountId}'
      UserPoolId: !Ref UserPool
      ManagedLoginVersion: 2

  # Cognito Identity Pool — exchanges Cognito ID tokens for STS credentials
  IdentityPool:
    Type: AWS::Cognito::IdentityPool
    Properties:
      IdentityPoolName: !Sub '\${StackPrefix}_admin'
      AllowUnauthenticatedIdentities: false
      CognitoIdentityProviders:
        - ClientId: !Ref UserPoolClient
          ProviderName: !Sub 'cognito-idp.\${AWS::Region}.amazonaws.com/\${UserPool}'
          ServerSideTokenCheck: false

  # App Permissions Boundary — applied to every Manager-minted per-app role
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

  # Foundational Permissions Boundary — only for the cloud-data-server role,
  # which provisions the DSQL cluster, files bucket and API Gateway. Wider than
  # the per-app boundary, scoped to \${StackPrefix}-app-cloud-data-server-*.
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

  # User-Data-Owner Permissions Boundary — only for the Starkeep Drive role,
  # minted at Drive install. It adds read/write across shared/*, the layer-2
  # hard floor for shared-record custody, and nothing else: no Lambda, API
  # Gateway, per-app schema, DSQL cluster admin or IAM mutation. The installer
  # routes only the \`starkeep-drive\` app id here.
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

  # Admin App Role — federated entry point + admin-app runtime identity
  # NOT under the permissions boundary (it's bootstrap-created).
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

  # Only members of starkeep-admins get AWS credentials. Every other user —
  # a member, or an admin removed from the group — matches no rule, and
  # AmbiguousRoleResolution: Deny refuses them, with no default role to fall
  # back to. Membership in starkeep-users is the data plane's concern, checked
  # by the cloud data server, not here. Roles stays an empty map: Cognito's
  # SetIdentityPoolRoles requires the field and rejects an update that omits it.
  IdentityPoolRoleAttachment:
    Type: AWS::Cognito::IdentityPoolRoleAttachment
    Properties:
      IdentityPoolId: !Ref IdentityPool
      Roles: {}
      RoleMappings:
        userpool:
          IdentityProvider: !Sub '\${UserPool.ProviderName}:\${UserPoolClient}'
          Type: Rules
          AmbiguousRoleResolution: Deny
          RulesConfiguration:
            Rules:
              - Claim: cognito:groups
                MatchType: Contains
                Value: starkeep-admins
                RoleARN: !GetAtt AdminAppRole.Arn

  # The two account groups. An admin is in starkeep-admins; a user whose data
  # syncs is in starkeep-users. An admin may be in either or both.
  AdminsGroup:
    Type: AWS::Cognito::UserPoolGroup
    Properties:
      GroupName: starkeep-admins
      UserPoolId: !Ref UserPool
      Description: Manages users, cloud apps, settings and the deployment.

  UsersGroup:
    Type: AWS::Cognito::UserPoolGroup
    Properties:
      GroupName: starkeep-users
      UserPoolId: !Ref UserPool
      Description: Has a data library that syncs through the cloud.

  # The first admin, in both groups. The operator names the account in the
  # create-stack form, so the pool has an admin from the start, and Cognito
  # emails the invitation above. Every property of a user or an attachment
  # forces a replacement, and clearing AdminEmail removes all three; Retain
  # keeps the account and its memberships either way, since removing an
  # attachment would bypass admin-web's last-admin guard. Admin-web owns the
  # memberships after setup, and teardown removes the account with the pool.
  # A new property here replaces the user everywhere, which fails on the
  # existing email; bootstrap-template.test.ts pins the properties.
  FirstAdmin:
    Type: AWS::Cognito::UserPoolUser
    Condition: HasAdminEmail
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      UserPoolId: !Ref UserPool
      Username: !Ref AdminEmail
      UserAttributes:
        - Name: email
          Value: !Ref AdminEmail
        - Name: email_verified
          Value: 'true'
      DesiredDeliveryMediums:
        - EMAIL

  FirstAdminInAdmins:
    Type: AWS::Cognito::UserPoolUserToGroupAttachment
    Condition: HasAdminEmail
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      UserPoolId: !Ref UserPool
      GroupName: !Ref AdminsGroup
      Username: !Ref FirstAdmin

  FirstAdminInUsers:
    Type: AWS::Cognito::UserPoolUserToGroupAttachment
    Condition: HasAdminEmail
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      UserPoolId: !Ref UserPool
      GroupName: !Ref UsersGroup
      Username: !Ref FirstAdmin

  # Manager Role — pure delegation; no data-plane actions
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

  # Install-DDL Permissions Boundary — ceiling for the install-ddl-role
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

  # Install-DDL Role — the only identity that can connect to DSQL as PG admin.
  # No standing permissions; Manager attaches a per-app temp policy around DDL.
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

  # Install-Infra Permissions Boundary — ceiling for the install-infra-role
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

  # Install-Infra Role — centralized identity that runs per-app Pulumi
  # provisioning. Manager attaches a temp policy scoped to the app being
  # installed, then detaches it. No standing permissions at steady state.
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

  # Pulumi state bucket for per-app stack state
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

  # Artifacts bucket — each app's Lambda bundle (apps/<appId>/latest/dist.zip).
  # install-infra uploads it at install and deletes it at uninstall. Never
  # holds user data. The account and region suffix keeps the name globally
  # unique; policies use a \`\${StackPrefix}-artifacts-*\` wildcard for it.
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

  # The Pulumi passphrase, an SSM SecureString at
  # /\${StackPrefix}/pulumi/passphrase, is NOT created here: AWS::SSM::Parameter
  # cannot make a SecureString. ensurePulumiPassphrase in the admin-installer
  # creates it on the first cloud-data-server install and never overwrites it,
  # since Pulumi state depends on it. scripts/teardown-bootstrap.sh deletes it.

Outputs:
  UserPoolId:
    Description: Cognito User Pool ID
    Value: !Ref UserPool

  UserPoolClientId:
    Description: Cognito App Client ID
    Value: !Ref UserPoolClient

  DeviceUserPoolClientId:
    Description: Cognito app client that desktops sign in with to sync
    Value: !Ref DeviceUserPoolClient

  CognitoDomain:
    Description: Host name of the managed login page
    Value: !Sub '\${UserPoolDomain}.auth.\${AWS::Region}.amazoncognito.com'

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

  UsersConsoleLink:
    Description: >
      The user pool's accounts in the Cognito console, for recovery: an
      expired invitation, or a pool with no admin who can sign in.
    Value: !Sub >
      https://\${AWS::Region}.console.aws.amazon.com/cognito/v2/idp/user-pools/\${UserPool}/user-management/users?region=\${AWS::Region}

`;
}

/**
 * CloudFormation's cap on a template sent inline as `TemplateBody`, which is
 * how the tier-3 suite creates and updates the stack. The template's comments
 * count toward it, so a long new comment can push the template over; keep them
 * concise. `bootstrap-template.test.ts` checks the template fits.
 */
export const MAX_INLINE_TEMPLATE_BYTES = 51_200;

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
  // We can't include the per-stack stackId ARN (it isn't known until the stack
  // is created), so the console can't pin the exact stack. filteringText
  // narrows the stack list to the bootstrap stack on the Outputs tab.
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/outputs?filteringStatus=active&filteringText=${encodeURIComponent(stackName)}&viewNested=true&hideStacks=false`;
}
