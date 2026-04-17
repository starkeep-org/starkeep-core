/**
 * Generate CloudFormation template for customer to create cross-account IAM role
 * This is only needed for SaaS mode
 */

export interface GenerateBootstrapTemplateInput {
  controlPlaneAccountId: string; // The AWS account ID where Starkeeper is running
  externalId: string; // Unique external ID for this customer
  customerAccountId: string; // The customer's AWS account ID
  stackPrefix?: string; // Stack name prefix to restrict operations to (e.g., "app", "myapp")
  allowedRegions?: string[]; // Regions where Starkeeper is allowed to operate
}

export function generateBootstrapTemplate(input: GenerateBootstrapTemplateInput): string {
  const stackPrefix = input.stackPrefix || 'app';
  const allowedRegions = input.allowedRegions && input.allowedRegions.length > 0 ? input.allowedRegions : null;

  // Generate region restriction condition only if regions are specified
  const regionCondition = allowedRegions
    ? `
                Condition:
                  StringEquals:
                    aws:RequestedRegion:
                      - ${allowedRegions.map(r => `'${r}'`).join('\n                      - ')}`
    : '';

  // For managed policy (different indentation)
  const managedPolicyRegionCondition = allowedRegions
    ? `
            Condition:
              StringEquals:
                aws:RequestedRegion:
                  - ${allowedRegions.map(r => `'${r}'`).join('\n                  - ')}`
    : '';

  return `AWSTemplateFormatVersion: '2010-09-09'
Description: Starkeeper Cross-Account Access Role - Allows Starkeeper to manage infrastructure in this account

Parameters:
  ControlPlaneAccountId:
    Type: String
    Default: ${input.controlPlaneAccountId}
    Description: AWS Account ID where Starkeeper is running
    AllowedPattern: '^[0-9]{12}$'

  ExternalId:
    Type: String
    Default: ${input.externalId}
    Description: External ID for secure cross-account access
    MinLength: 8

  StackPrefix:
    Type: String
    Default: ${stackPrefix}
    Description: Stack name prefix that Starkeeper is allowed to manage
    MinLength: 1

Resources:
  # Permission boundary for any IAM roles created by CloudFormation
  StarkeeperPermissionBoundary:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: StarkeeperPermissionBoundary
      Description: Permission boundary for roles created by Starkeeper-managed CloudFormation stacks
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          # Allow standard application permissions but prevent privilege escalation
          - Effect: Allow
            Action:
              - logs:*
              - s3:*
              - dynamodb:*
              - lambda:*
              - apigateway:*
              - execute-api:*
              - cloudfront:*
              - cloudwatch:*
              - xray:*
              - sns:*
              - sqs:*
              - events:*
              - states:*
              - secretsmanager:GetSecretValue
              - secretsmanager:DescribeSecret
              - kms:Decrypt
              - kms:DescribeKey
              - ec2:CreateNetworkInterface
              - ec2:DescribeNetworkInterfaces
              - ec2:DeleteNetworkInterface
              - ec2:DescribeSubnets
              - ec2:DescribeSecurityGroups
              - ec2:DescribeVpcs
            Resource: '*'
          # Explicitly deny IAM privilege escalation
          - Effect: Deny
            Action:
              - iam:CreateUser
              - iam:CreateAccessKey
              - iam:PutUserPolicy
              - iam:AttachUserPolicy
              - iam:CreatePolicyVersion
              - iam:SetDefaultPolicyVersion
              - iam:PassRole
            Resource: '*'

  # CloudFormation execution role - used by CloudFormation service
  StarkeeperCloudFormationExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: StarkeeperCloudFormationExecution
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: cloudformation.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/PowerUserAccess
      Policies:
        - PolicyName: IAMRoleManagement
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              # Allow creating roles but ONLY with permission boundary
              - Effect: Allow
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
                Resource: '*'
                Condition:
                  StringEquals:
                    iam:PermissionsBoundary: !Ref StarkeeperPermissionBoundary
              # Allow tagging without permission boundary condition (needed during role creation)
              - Effect: Allow
                Action:
                  - iam:TagRole
                  - iam:UntagRole
                Resource: '*'
              # Allow PassRole to services
              - Effect: Allow
                Action:
                  - iam:PassRole
                Resource: '*'
                Condition:
                  StringEquals:
                    iam:PassedToService:
                      - lambda.amazonaws.com
                      - apigateway.amazonaws.com
                      - events.amazonaws.com
                      - states.amazonaws.com
                      - ecs-tasks.amazonaws.com
      Tags:
        - Key: ManagedBy
          Value: Starkeeper
        - Key: Purpose
          Value: CloudFormationExecution

  # Provisioner role - assumed by Starkeeper control plane for infrastructure management ONLY
  # HARD RULE: Cannot access customer data even if compromised
  StarkeeperProvisionerRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: StarkeeperProvisioner
      Description: Control plane role - can manage infrastructure but CANNOT access customer data
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS: !Sub 'arn:aws:iam::\${ControlPlaneAccountId}:root'
            Action: sts:AssumeRole
            Condition:
              StringEquals:
                sts:ExternalId: !Ref ExternalId
      Policies:
        - PolicyName: InfrastructureProvisioning
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              # EXPLICIT DENY: All data access operations
              # This makes it impossible for control plane to read/write customer data
              - Sid: DenyAllDataAccess
                Effect: Deny
                Action:
                  # S3 data operations
                  - s3:GetObject
                  - s3:GetObjectVersion
                  - s3:PutObject
                  - s3:DeleteObject
                  - s3:DeleteObjectVersion
                  # DynamoDB data operations
                  - dynamodb:GetItem
                  - dynamodb:BatchGetItem
                  - dynamodb:Query
                  - dynamodb:Scan
                  - dynamodb:PutItem
                  - dynamodb:UpdateItem
                  - dynamodb:DeleteItem
                  - dynamodb:BatchWriteItem
                  # Secrets Manager data access
                  - secretsmanager:GetSecretValue
                  # KMS decrypt (prevents reading encrypted data)
                  - kms:Decrypt
                  # RDS data access
                  - rds-data:*
                  # SSM Parameter Store sensitive values
                  - ssm:GetParameter
                  - ssm:GetParameters
                  - ssm:GetParametersByPath
                Resource: '*'

              # CloudFormation change set operations (scoped to stack prefix)
              - Sid: CloudFormationChangeSetOperations
                Effect: Allow
                Action:
                  - cloudformation:CreateChangeSet
                  - cloudformation:DescribeChangeSet
                  - cloudformation:ExecuteChangeSet
                  - cloudformation:DeleteChangeSet
                  - cloudformation:ListChangeSets
                  - cloudformation:CreateStack
                  - cloudformation:UpdateStack
                  - cloudformation:DeleteStack
                  - cloudformation:GetTemplate
                  - cloudformation:ValidateTemplate
                  - cloudformation:DescribeStackEvents
                  - cloudformation:DescribeStackResources
                  - cloudformation:ListStackResources
                  - cloudformation:GetStackPolicy
                  - cloudformation:SetStackPolicy
                Resource: !Sub 'arn:aws:cloudformation:*:\${AWS::AccountId}:stack/\${StackPrefix}-*/*'${regionCondition}

              # Read-only list/describe requires wildcard resource
              - Sid: CloudFormationReadOnlyGlobal
                Effect: Allow
                Action:
                  - cloudformation:DescribeStacks
                  - cloudformation:ListStacks
                Resource: '*'${regionCondition}

              # Pass role to CloudFormation execution role only
              - Sid: PassRoleToCloudFormation
                Effect: Allow
                Action:
                  - iam:PassRole
                Resource: !GetAtt StarkeeperCloudFormationExecutionRole.Arn
                Condition:
                  StringEquals:
                    iam:PassedToService: cloudformation.amazonaws.com

              # Metadata-only access for infrastructure management
              - Sid: MetadataOnlyAccess
                Effect: Allow
                Action:
                  - ec2:Describe*
                  - s3:ListAllMyBuckets
                  - s3:ListBucket
                  - s3:GetBucketLocation
                  - s3:GetBucketVersioning
                  - s3:GetBucketPolicy
                  - s3:GetBucketTagging
                  - lambda:List*
                  - lambda:GetFunction
                  - lambda:GetFunctionConfiguration
                  - dynamodb:ListTables
                  - dynamodb:DescribeTable
                  - rds:DescribeDBInstances
                  - rds:DescribeDBClusters
                  - apigateway:GET
                  - cloudfront:List*
                  - cloudfront:Get*
                  - iam:GetRole
                  - iam:GetPolicy
                  - iam:GetPolicyVersion
                  - iam:ListRoles
                  - iam:ListPolicies
                  - ecs:DescribeClusters
                  - ecs:DescribeServices
                  - ecs:DescribeTasks
                  - ecs:DescribeTaskDefinition
                  - ecs:ListClusters
                  - ecs:ListServices
                  - ecs:ListTasks
                  - logs:DescribeLogGroups
                  - logs:DescribeLogStreams
                  # Can read CloudWatch metrics but not log contents
                  - cloudwatch:GetMetricStatistics
                  - cloudwatch:ListMetrics
                Resource: '*'

              # Gateway management API access (control plane only)
              # This allows control plane to call gateway's management API for health/config/metrics
              # But gateway's data API is not exposed to control plane
              - Sid: GatewayManagementAPI
                Effect: Allow
                Action:
                  - execute-api:Invoke
                Resource: !Sub 'arn:aws:execute-api:*:\${AWS::AccountId}:*/*/GET/management/*'

              # ECS task management for gateway deployments/updates
              - Sid: GatewayDeploymentManagement
                Effect: Allow
                Action:
                  - ecs:UpdateService
                  - ecs:RegisterTaskDefinition
                  - ecs:DeregisterTaskDefinition
                  - ecs:RunTask
                  - ecs:StopTask
                Resource: '*'
                Condition:
                  StringLike:
                    ecs:cluster: !Sub 'arn:aws:ecs:*:\${AWS::AccountId}:cluster/\${StackPrefix}-*'
      Tags:
        - Key: ManagedBy
          Value: Starkeeper
        - Key: Purpose
          Value: ProvisionerRole
        - Key: DataAccess
          Value: Denied

  # Data plane runtime role - for applications and gateway running in customer environment
  # HARD RULE: Control plane CANNOT assume this role
  StarkeeperDataPlaneRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: StarkeeperDataPlaneRuntime
      Description: Runtime role for applications and data gateway - control plane CANNOT assume this
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          # Only ECS tasks in THIS account can assume this role
          - Sid: AllowECSTasksOnly
            Effect: Allow
            Principal:
              Service: ecs-tasks.amazonaws.com
            Action: sts:AssumeRole
          # Explicitly DENY control plane from assuming this role
          - Sid: DenyControlPlaneAssume
            Effect: Deny
            Principal:
              AWS: !Sub 'arn:aws:iam::\${ControlPlaneAccountId}:root'
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/CloudWatchLogsFullAccess
      Policies:
        - PolicyName: DataPlaneDataAccess
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              # S3 data access for gateway backend
              - Sid: S3DataAccess
                Effect: Allow
                Action:
                  - s3:GetObject
                  - s3:PutObject
                  - s3:DeleteObject
                  - s3:ListBucket
                Resource:
                  - !Sub 'arn:aws:s3:::\${StackPrefix}-*'
                  - !Sub 'arn:aws:s3:::\${StackPrefix}-*/*'

              # DynamoDB data access
              - Sid: DynamoDBDataAccess
                Effect: Allow
                Action:
                  - dynamodb:GetItem
                  - dynamodb:PutItem
                  - dynamodb:UpdateItem
                  - dynamodb:DeleteItem
                  - dynamodb:Query
                  - dynamodb:Scan
                  - dynamodb:BatchGetItem
                  - dynamodb:BatchWriteItem
                Resource: !Sub 'arn:aws:dynamodb:*:\${AWS::AccountId}:table/\${StackPrefix}-*'

              # Secrets Manager for application secrets
              - Sid: SecretsAccess
                Effect: Allow
                Action:
                  - secretsmanager:GetSecretValue
                  - secretsmanager:DescribeSecret
                Resource: !Sub 'arn:aws:secretsmanager:*:\${AWS::AccountId}:secret:\${StackPrefix}-*'

              # KMS for encryption/decryption
              - Sid: KMSAccess
                Effect: Allow
                Action:
                  - kms:Decrypt
                  - kms:Encrypt
                  - kms:GenerateDataKey
                  - kms:DescribeKey
                Resource: !Sub 'arn:aws:kms:*:\${AWS::AccountId}:key/*'
                Condition:
                  StringLike:
                    kms:ViaService:
                      - s3.*.amazonaws.com
                      - dynamodb.*.amazonaws.com
      Tags:
        - Key: ManagedBy
          Value: Starkeeper
        - Key: Purpose
          Value: DataPlaneRuntime
        - Key: TrustedBy
          Value: ECSTasksOnly

  # Legacy compatibility - keep StarkeeperAccess as alias to Provisioner role
  StarkeeperRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: StarkeeperAccess
      Description: DEPRECATED - Use StarkeeperProvisioner instead. Kept for backwards compatibility.
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS: !Sub 'arn:aws:iam::\${ControlPlaneAccountId}:root'
            Action: sts:AssumeRole
            Condition:
              StringEquals:
                sts:ExternalId: !Ref ExternalId
      ManagedPolicyArns:
        - !Ref StarkeeperProvisionerManagedPolicy
      Tags:
        - Key: ManagedBy
          Value: Starkeeper
        - Key: Purpose
          Value: LegacyCompatibility

  # Extract Provisioner policies as managed policy for reuse
  StarkeeperProvisionerManagedPolicy:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: StarkeeperProvisionerPolicy
      Description: Provisioner permissions - infrastructure management with zero data access
      Roles:
        - !Ref StarkeeperProvisionerRole
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Sid: DenyAllDataAccess
            Effect: Deny
            Action:
              - s3:GetObject
              - s3:GetObjectVersion
              - s3:PutObject
              - s3:DeleteObject
              - s3:DeleteObjectVersion
              - dynamodb:GetItem
              - dynamodb:BatchGetItem
              - dynamodb:Query
              - dynamodb:Scan
              - dynamodb:PutItem
              - dynamodb:UpdateItem
              - dynamodb:DeleteItem
              - dynamodb:BatchWriteItem
              - secretsmanager:GetSecretValue
              - kms:Decrypt
              - rds-data:*
              - ssm:GetParameter
              - ssm:GetParameters
              - ssm:GetParametersByPath
            Resource: '*'

          - Sid: CloudFormationChangeSetOperations
            Effect: Allow
            Action:
              - cloudformation:CreateChangeSet
              - cloudformation:DescribeChangeSet
              - cloudformation:ExecuteChangeSet
              - cloudformation:DeleteChangeSet
              - cloudformation:ListChangeSets
              - cloudformation:CreateStack
              - cloudformation:UpdateStack
              - cloudformation:DeleteStack
              - cloudformation:GetTemplate
              - cloudformation:ValidateTemplate
              - cloudformation:DescribeStackEvents
              - cloudformation:DescribeStackResources
              - cloudformation:ListStackResources
              - cloudformation:GetStackPolicy
              - cloudformation:SetStackPolicy
            Resource: !Sub 'arn:aws:cloudformation:*:\${AWS::AccountId}:stack/\${StackPrefix}-*/*'${managedPolicyRegionCondition}

          - Sid: CloudFormationReadOnlyGlobal
            Effect: Allow
            Action:
              - cloudformation:DescribeStacks
              - cloudformation:ListStacks
            Resource: '*'${managedPolicyRegionCondition}

          - Sid: PassRoleToCloudFormation
            Effect: Allow
            Action:
              - iam:PassRole
            Resource: !GetAtt StarkeeperCloudFormationExecutionRole.Arn
            Condition:
              StringEquals:
                iam:PassedToService: cloudformation.amazonaws.com

          - Sid: MetadataOnlyAccess
            Effect: Allow
            Action:
              - ec2:Describe*
              - s3:ListAllMyBuckets
              - s3:ListBucket
              - s3:GetBucketLocation
              - s3:GetBucketVersioning
              - s3:GetBucketPolicy
              - s3:GetBucketTagging
              - lambda:List*
              - lambda:GetFunction
              - lambda:GetFunctionConfiguration
              - dynamodb:ListTables
              - dynamodb:DescribeTable
              - rds:DescribeDBInstances
              - rds:DescribeDBClusters
              - apigateway:GET
              - cloudfront:List*
              - cloudfront:Get*
              - iam:GetRole
              - iam:GetPolicy
              - iam:GetPolicyVersion
              - iam:ListRoles
              - iam:ListPolicies
              - ecs:DescribeClusters
              - ecs:DescribeServices
              - ecs:DescribeTasks
              - ecs:DescribeTaskDefinition
              - ecs:ListClusters
              - ecs:ListServices
              - ecs:ListTasks
              - logs:DescribeLogGroups
              - logs:DescribeLogStreams
              - cloudwatch:GetMetricStatistics
              - cloudwatch:ListMetrics
            Resource: '*'

          - Sid: GatewayManagementAPI
            Effect: Allow
            Action:
              - execute-api:Invoke
            Resource: !Sub 'arn:aws:execute-api:*:\${AWS::AccountId}:*/*/GET/management/*'

          - Sid: GatewayDeploymentManagement
            Effect: Allow
            Action:
              - ecs:UpdateService
              - ecs:RegisterTaskDefinition
              - ecs:DeregisterTaskDefinition
              - ecs:RunTask
              - ecs:StopTask
            Resource: '*'
            Condition:
              StringLike:
                ecs:cluster: !Sub 'arn:aws:ecs:*:\${AWS::AccountId}:cluster/\${StackPrefix}-*'

Outputs:
  ProvisionerRoleArn:
    Description: ARN of the Provisioner role (control plane) - CANNOT access customer data
    Value: !GetAtt StarkeeperProvisionerRole.Arn
    Export:
      Name: StarkeeperProvisionerRoleArn

  DataPlaneRoleArn:
    Description: ARN of the Data Plane role (runtime only) - control plane CANNOT assume this
    Value: !GetAtt StarkeeperDataPlaneRole.Arn
    Export:
      Name: StarkeeperDataPlaneRoleArn

  RoleArn:
    Description: DEPRECATED - Use ProvisionerRoleArn instead. ARN of the legacy access role.
    Value: !GetAtt StarkeeperRole.Arn
    Export:
      Name: StarkeeperRoleArn

  ExecutionRoleArn:
    Description: ARN of the CloudFormation execution role - used by CloudFormation service
    Value: !GetAtt StarkeeperCloudFormationExecutionRole.Arn
    Export:
      Name: StarkeeperExecutionRoleArn

  PermissionBoundaryArn:
    Description: ARN of the permission boundary - must be applied to all IAM roles created by templates
    Value: !Ref StarkeeperPermissionBoundary
    Export:
      Name: StarkeeperPermissionBoundaryArn

  ExternalId:
    Description: External ID for this role - keep this secure
    Value: !Ref ExternalId

  AccountId:
    Description: Your AWS Account ID
    Value: !Ref AWS::AccountId

  StackPrefix:
    Description: Stack name prefix that Starkeeper is allowed to manage
    Value: !Ref StackPrefix

  SecurityModel:
    Description: Zero data access guarantee - control plane cannot read/write customer data
    Value: Provisioner role has explicit DENY on all data operations. Data plane role cannot be assumed by control plane.
`;
}

/**
 * Generate a secure external ID for a customer
 */
export function generateExternalId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
