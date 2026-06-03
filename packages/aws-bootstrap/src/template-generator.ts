/**
 * CloudFormation template generators
 * Generate templates on-demand based on app type and parameters
 */

export interface TemplateParams {
  environment: string;
  [key: string]: unknown;
}

export interface GenerateTemplateInput {
  appType: string;
  params: TemplateParams;
}

/**
 * Generate a CloudFormation template for a static web app
 */
function generateWebAppTemplate(params: TemplateParams): string {
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: Static Website with CloudFront and S3 - ${params.environment}

Parameters:
  Environment:
    Type: String
    Default: ${params.environment}
    AllowedValues:
      - dev
      - staging
      - prod
    Description: Environment name

Resources:
  WebsiteBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${AWS::StackName}-\${Environment}-website'
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true
      VersioningConfiguration:
        Status: Enabled
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  CloudFrontOAC:
    Type: AWS::CloudFront::OriginAccessControl
    Properties:
      OriginAccessControlConfig:
        Name: !Sub '\${AWS::StackName}-oac'
        OriginAccessControlOriginType: s3
        SigningBehavior: always
        SigningProtocol: sigv4

  CloudFrontDistribution:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        Enabled: true
        DefaultRootObject: index.html
        HttpVersion: http2
        PriceClass: PriceClass_100
        Origins:
          - Id: S3Origin
            DomainName: !GetAtt WebsiteBucket.RegionalDomainName
            OriginAccessControlId: !Ref CloudFrontOAC
            S3OriginConfig:
              OriginAccessIdentity: ''
        DefaultCacheBehavior:
          TargetOriginId: S3Origin
          ViewerProtocolPolicy: redirect-to-https
          AllowedMethods:
            - GET
            - HEAD
            - OPTIONS
          CachedMethods:
            - GET
            - HEAD
          Compress: true
          ForwardedValues:
            QueryString: false
            Cookies:
              Forward: none
        CustomErrorResponses:
          - ErrorCode: 403
            ResponseCode: 200
            ResponsePagePath: /index.html
          - ErrorCode: 404
            ResponseCode: 200
            ResponsePagePath: /index.html
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  BucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref WebsiteBucket
      PolicyDocument:
        Statement:
          - Sid: AllowCloudFrontServicePrincipal
            Effect: Allow
            Principal:
              Service: cloudfront.amazonaws.com
            Action: s3:GetObject
            Resource: !Sub '\${WebsiteBucket.Arn}/*'
            Condition:
              StringEquals:
                'AWS:SourceArn': !Sub 'arn:aws:cloudfront::\${AWS::AccountId}:distribution/\${CloudFrontDistribution}'

Outputs:
  BucketName:
    Description: S3 bucket name
    Value: !Ref WebsiteBucket
    Export:
      Name: !Sub '\${AWS::StackName}-BucketName'

  CloudFrontURL:
    Description: CloudFront distribution URL
    Value: !GetAtt CloudFrontDistribution.DomainName
    Export:
      Name: !Sub '\${AWS::StackName}-CloudFrontURL'

  DistributionId:
    Description: CloudFront distribution ID
    Value: !Ref CloudFrontDistribution
    Export:
      Name: !Sub '\${AWS::StackName}-DistributionId'
`;
}

/**
 * Generate a CloudFormation template for an API service
 */
function generateApiServiceTemplate(params: TemplateParams): string {
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: API Service with API Gateway, Lambda, and DynamoDB - ${params.environment}

Parameters:
  Environment:
    Type: String
    Default: ${params.environment}
    AllowedValues:
      - dev
      - staging
      - prod
    Description: Environment name

Resources:
  DynamoDBTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: !Sub '\${AWS::StackName}-\${Environment}'
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: id
          AttributeType: S
      KeySchema:
        - AttributeName: id
          KeyType: HASH
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  LambdaExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
      Policies:
        - PolicyName: DynamoDBAccess
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - dynamodb:GetItem
                  - dynamodb:PutItem
                  - dynamodb:UpdateItem
                  - dynamodb:DeleteItem
                  - dynamodb:Query
                  - dynamodb:Scan
                Resource: !GetAtt DynamoDBTable.Arn

  ApiFunction:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: !Sub '\${AWS::StackName}-api'
      Runtime: nodejs20.x
      Handler: index.handler
      Role: !GetAtt LambdaExecutionRole.Arn
      Code:
        ZipFile: |
          exports.handler = async (event) => {
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: 'Hello from Lambda!' })
            };
          };
      Environment:
        Variables:
          TABLE_NAME: !Ref DynamoDBTable
          ENVIRONMENT: !Ref Environment
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  ApiGateway:
    Type: AWS::ApiGatewayV2::Api
    Properties:
      Name: !Sub '\${AWS::StackName}-api'
      ProtocolType: HTTP
      Tags:
        Environment: !Ref Environment
        ManagedBy: Starkeeper

  ApiIntegration:
    Type: AWS::ApiGatewayV2::Integration
    Properties:
      ApiId: !Ref ApiGateway
      IntegrationType: AWS_PROXY
      IntegrationUri: !GetAtt ApiFunction.Arn
      PayloadFormatVersion: '2.0'

  ApiRoute:
    Type: AWS::ApiGatewayV2::Route
    Properties:
      ApiId: !Ref ApiGateway
      RouteKey: 'ANY /{proxy+}'
      Target: !Sub 'integrations/\${ApiIntegration}'

  ApiStage:
    Type: AWS::ApiGatewayV2::Stage
    Properties:
      ApiId: !Ref ApiGateway
      StageName: !Ref Environment
      AutoDeploy: true

  LambdaPermission:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !Ref ApiFunction
      Action: lambda:InvokeFunction
      Principal: apigateway.amazonaws.com
      SourceArn: !Sub 'arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${ApiGateway}/*'

Outputs:
  ApiUrl:
    Description: API Gateway endpoint URL
    Value: !Sub 'https://\${ApiGateway}.execute-api.\${AWS::Region}.amazonaws.com/\${Environment}'
    Export:
      Name: !Sub '\${AWS::StackName}-ApiUrl'

  TableName:
    Description: DynamoDB table name
    Value: !Ref DynamoDBTable
    Export:
      Name: !Sub '\${AWS::StackName}-TableName'

  FunctionArn:
    Description: Lambda function ARN
    Value: !GetAtt ApiFunction.Arn
    Export:
      Name: !Sub '\${AWS::StackName}-FunctionArn'
`;
}

/**
 * Generate a CloudFormation template for a data pipeline
 */
function generateDataPipelineTemplate(params: TemplateParams): string {
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: Data Pipeline with S3, Glue, and Athena - ${params.environment}

Parameters:
  Environment:
    Type: String
    Default: ${params.environment}
    AllowedValues:
      - dev
      - staging
      - prod
    Description: Environment name

Resources:
  DataBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${AWS::StackName}-\${Environment}-data'
      VersioningConfiguration:
        Status: Enabled
      LifecycleConfiguration:
        Rules:
          - Id: DeleteOldVersions
            Status: Enabled
            NoncurrentVersionExpirationInDays: 30
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  GlueDatabase:
    Type: AWS::Glue::Database
    Properties:
      CatalogId: !Ref AWS::AccountId
      DatabaseInput:
        Name: !Sub '\${AWS::StackName}_\${Environment}_db'
        Description: !Sub 'Glue database for \${AWS::StackName}'

  AthenaWorkgroup:
    Type: AWS::Athena::WorkGroup
    Properties:
      Name: !Sub '\${AWS::StackName}-\${Environment}'
      State: ENABLED
      WorkGroupConfiguration:
        ResultConfiguration:
          OutputLocation: !Sub 's3://\${DataBucket}/athena-results/'
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

Outputs:
  DataBucketName:
    Description: S3 data bucket name
    Value: !Ref DataBucket
    Export:
      Name: !Sub '\${AWS::StackName}-DataBucketName'

  GlueDatabaseName:
    Description: Glue database name
    Value: !Ref GlueDatabase
    Export:
      Name: !Sub '\${AWS::StackName}-GlueDatabaseName'

  AthenaWorkgroupName:
    Description: Athena workgroup name
    Value: !Ref AthenaWorkgroup
    Export:
      Name: !Sub '\${AWS::StackName}-AthenaWorkgroupName'
`;
}

/**
 * Generate a CloudFormation template for a Tailscale exit node on EC2
 */
function generateTailscaleExitNodeTemplate(params: TemplateParams): string {
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: Tailscale Exit Node on EC2 - ${params.environment}

Parameters:
  Environment:
    Type: String
    Default: ${params.environment}
    AllowedValues:
      - dev
      - staging
      - prod
    Description: Environment name

  TailscaleAuthKey:
    Type: String
    NoEcho: true
    Description: Tailscale auth key (generate at https://login.tailscale.com/admin/settings/keys)

  InstanceType:
    Type: String
    Default: t3.micro
    Description: EC2 instance type

  PermissionBoundaryArn:
    Type: String
    Description: ARN of the permission boundary for IAM roles
    Default: ''

Conditions:
  HasPermissionBoundary: !Not [!Equals [!Ref PermissionBoundaryArn, '']]

Resources:
  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.0.0.0/16
      EnableDnsHostnames: true
      EnableDnsSupport: true
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-vpc'
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  InternetGateway:
    Type: AWS::EC2::InternetGateway
    Properties:
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-igw'

  AttachGateway:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref VPC
      InternetGatewayId: !Ref InternetGateway

  PublicSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: 10.0.1.0/24
      MapPublicIpOnLaunch: true
      AvailabilityZone: !Select [0, !GetAZs '']
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-public'

  RouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VPC
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-rt'

  PublicRoute:
    Type: AWS::EC2::Route
    DependsOn: AttachGateway
    Properties:
      RouteTableId: !Ref RouteTable
      DestinationCidrBlock: 0.0.0.0/0
      GatewayId: !Ref InternetGateway

  SubnetRouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PublicSubnet
      RouteTableId: !Ref RouteTable

  SecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Tailscale exit node - WireGuard UDP inbound
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: udp
          FromPort: 41641
          ToPort: 41641
          CidrIp: 0.0.0.0/0
      SecurityGroupEgress:
        - IpProtocol: -1
          CidrIp: 0.0.0.0/0
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-sg'

  InstanceRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: ec2.amazonaws.com
            Action: sts:AssumeRole
      PermissionsBoundary: !If [HasPermissionBoundary, !Ref PermissionBoundaryArn, !Ref 'AWS::NoValue']
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  InstanceProfile:
    Type: AWS::IAM::InstanceProfile
    Properties:
      Roles:
        - !Ref InstanceRole

  Instance:
    Type: AWS::EC2::Instance
    DependsOn: PublicRoute
    Properties:
      InstanceType: !Ref InstanceType
      ImageId: !Sub '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}'
      SubnetId: !Ref PublicSubnet
      SecurityGroupIds:
        - !Ref SecurityGroup
      IamInstanceProfile: !Ref InstanceProfile
      UserData:
        Fn::Base64: !Sub |
          #!/bin/bash
          set -e
          echo 'net.ipv4.ip_forward = 1' >> /etc/sysctl.d/99-tailscale.conf
          echo 'net.ipv6.conf.all.forwarding = 1' >> /etc/sysctl.d/99-tailscale.conf
          sysctl -p /etc/sysctl.d/99-tailscale.conf
          curl -fsSL https://tailscale.com/install.sh | sh
          tailscale up --authkey=\${TailscaleAuthKey} --advertise-exit-node --hostname=\${AWS::StackName}
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-exit-node'
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

Outputs:
  InstanceId:
    Description: EC2 instance ID
    Value: !Ref Instance

  PublicIp:
    Description: Instance public IP address
    Value: !GetAtt Instance.PublicIp

  TailscaleExitNode:
    Description: Approve this exit node in Tailscale admin console
    Value: !Sub 'Approve exit node "\${AWS::StackName}" at https://login.tailscale.com/admin/machines'
`;
}

/**
 * Generate a CloudFormation template for OpenClaw AI assistant
 */
function generateOpenClawTemplate(params: TemplateParams): string {
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: OpenClaw AI Assistant with ECS on EC2 and EFS - ${params.environment}

Parameters:
  Environment:
    Type: String
    Default: ${params.environment}
    AllowedValues:
      - dev
      - staging
      - prod
    Description: Environment name

  LLMProvider:
    Type: String
    AllowedValues:
      - anthropic
      - openai
      - gemini
      - openrouter
    Default: anthropic
    Description: LLM provider for OpenClaw

  LLMApiKey:
    Type: String
    NoEcho: true
    Description: API key for the selected LLM provider

  GatewayToken:
    Type: String
    NoEcho: true
    Description: Authentication token for OpenClaw gateway access

  EC2InstanceType:
    Type: String
    Default: t3.small
    Description: EC2 instance type

  OpenClawImage:
    Type: String
    Default: alpine/openclaw:main
    Description: Docker image for OpenClaw

  ECSOptimizedAMI:
    Type: AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>
    Default: /aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id
    Description: ECS-optimized AMI for EC2 instances

  PermissionBoundaryArn:
    Type: String
    Description: ARN of the permission boundary for IAM roles
    Default: ''

Conditions:
  IsAnthropic: !Equals [!Ref LLMProvider, 'anthropic']
  IsOpenAI: !Equals [!Ref LLMProvider, 'openai']
  IsGemini: !Equals [!Ref LLMProvider, 'gemini']
  IsOpenRouter: !Equals [!Ref LLMProvider, 'openrouter']
  HasPermissionBoundary: !Not [!Equals [!Ref PermissionBoundaryArn, '']]

Resources:
  # Networking
  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.0.0.0/16
      EnableDnsHostnames: true
      EnableDnsSupport: true
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-vpc'
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  InternetGateway:
    Type: AWS::EC2::InternetGateway
    Properties:
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-igw'

  AttachGateway:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref VPC
      InternetGatewayId: !Ref InternetGateway

  PublicSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: 10.0.1.0/24
      MapPublicIpOnLaunch: true
      AvailabilityZone: !Select [0, !GetAZs '']
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-public'

  RouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VPC
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-rt'

  PublicRoute:
    Type: AWS::EC2::Route
    DependsOn: AttachGateway
    Properties:
      RouteTableId: !Ref RouteTable
      DestinationCidrBlock: 0.0.0.0/0
      GatewayId: !Ref InternetGateway

  SubnetRouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PublicSubnet
      RouteTableId: !Ref RouteTable

  # Security Groups
  ECSSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: OpenClaw gateway access
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 18789
          ToPort: 18789
          CidrIp: 0.0.0.0/0
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-ecs-sg'

  EFSSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: EFS access from ECS instances
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 2049
          ToPort: 2049
          SourceSecurityGroupId: !Ref ECSSecurityGroup
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-efs-sg'

  # EFS
  FileSystem:
    Type: AWS::EFS::FileSystem
    Properties:
      Encrypted: true
      PerformanceMode: generalPurpose
      ThroughputMode: bursting
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-efs'
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  MountTarget:
    Type: AWS::EFS::MountTarget
    Properties:
      FileSystemId: !Ref FileSystem
      SubnetId: !Ref PublicSubnet
      SecurityGroups:
        - !Ref EFSSecurityGroup

  # ECS Cluster
  ECSCluster:
    Type: AWS::ECS::Cluster
    Properties:
      ClusterName: !Sub '\${AWS::StackName}-cluster'
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  # EC2 Instance for ECS
  ECSInstanceRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: ec2.amazonaws.com
            Action: sts:AssumeRole
      PermissionsBoundary: !If [HasPermissionBoundary, !Ref PermissionBoundaryArn, !Ref 'AWS::NoValue']
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role
        - arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  ECSInstanceProfile:
    Type: AWS::IAM::InstanceProfile
    Properties:
      Roles:
        - !Ref ECSInstanceRole

  ECSLaunchTemplate:
    Type: AWS::EC2::LaunchTemplate
    Properties:
      LaunchTemplateData:
        ImageId: !Ref ECSOptimizedAMI
        InstanceType: !Ref EC2InstanceType
        IamInstanceProfile:
          Arn: !GetAtt ECSInstanceProfile.Arn
        SecurityGroupIds:
          - !Ref ECSSecurityGroup
        UserData:
          Fn::Base64: !Sub |
            #!/bin/bash
            echo ECS_CLUSTER=\${ECSCluster} >> /etc/ecs/ecs.config

  ECSAutoScalingGroup:
    Type: AWS::AutoScaling::AutoScalingGroup
    Properties:
      MinSize: '1'
      MaxSize: '1'
      DesiredCapacity: '1'
      VPCZoneIdentifier:
        - !Ref PublicSubnet
      LaunchTemplate:
        LaunchTemplateId: !Ref ECSLaunchTemplate
        Version: !GetAtt ECSLaunchTemplate.LatestVersionNumber
      HealthCheckType: EC2
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-ecs-host'
          PropagateAtLaunch: true
        - Key: Environment
          Value: !Ref Environment
          PropagateAtLaunch: true
        - Key: ManagedBy
          Value: Starkeeper
          PropagateAtLaunch: true

  # Elastic IP with Lifecycle Hooks
  OpenClawEip:
    Type: AWS::EC2::EIP
    Properties:
      Domain: vpc

  LifecycleTopic:
    Type: AWS::SNS::Topic

  LifecycleHookRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: autoscaling.amazonaws.com
            Action: sts:AssumeRole
      PermissionsBoundary: !If [HasPermissionBoundary, !Ref PermissionBoundaryArn, !Ref 'AWS::NoValue']
      Policies:
        - PolicyName: PublishLifecycleNotifications
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - sns:Publish
                Resource: !Ref LifecycleTopic

  LifecycleLambdaRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      PermissionsBoundary: !If [HasPermissionBoundary, !Ref PermissionBoundaryArn, !Ref 'AWS::NoValue']
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
      Policies:
        - PolicyName: ManageEipAssociation
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - ec2:AssociateAddress
                  - ec2:DisassociateAddress
                  - ec2:DescribeAddresses
                  - autoscaling:CompleteLifecycleAction
                Resource: '*'

  LifecycleLambda:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: nodejs20.x
      Handler: index.handler
      Role: !GetAtt LifecycleLambdaRole.Arn
      Timeout: 60
      Environment:
        Variables:
          EIP_ALLOCATION_ID: !GetAtt OpenClawEip.AllocationId
      Code:
        ZipFile: |
          const AWS = require('aws-sdk');
          const ec2 = new AWS.EC2();
          const autoscaling = new AWS.AutoScaling();

          exports.handler = async (event) => {
            const record = event.Records && event.Records[0];
            const message = record && record.Sns && record.Sns.Message;
            if (!message) return;

            const payload = JSON.parse(message);
            const instanceId = payload.EC2InstanceId;
            const hookName = payload.LifecycleHookName;
            const asgName = payload.AutoScalingGroupName;
            const token = payload.LifecycleActionToken;
            const transition = payload.LifecycleTransition;
            const allocationId = process.env.EIP_ALLOCATION_ID;

            try {
              if (transition === 'autoscaling:EC2_INSTANCE_LAUNCHING') {
                await ec2.associateAddress({
                  AllocationId: allocationId,
                  InstanceId: instanceId,
                  AllowReassociation: true,
                }).promise();
              } else if (transition === 'autoscaling:EC2_INSTANCE_TERMINATING') {
                const addresses = await ec2.describeAddresses({
                  AllocationIds: [allocationId],
                }).promise();
                const associationId = addresses.Addresses && addresses.Addresses[0] && addresses.Addresses[0].AssociationId;
                if (associationId) {
                  await ec2.disassociateAddress({ AssociationId: associationId }).promise();
                }
              }
            } catch (error) {
              console.error('EIP association error:', error);
            }

            await autoscaling.completeLifecycleAction({
              AutoScalingGroupName: asgName,
              LifecycleHookName: hookName,
              LifecycleActionToken: token,
              LifecycleActionResult: 'CONTINUE',
            }).promise();
          };

  LifecycleLambdaPermission:
    Type: AWS::Lambda::Permission
    Properties:
      Action: lambda:InvokeFunction
      FunctionName: !Ref LifecycleLambda
      Principal: sns.amazonaws.com
      SourceArn: !Ref LifecycleTopic

  LifecycleTopicSubscription:
    Type: AWS::SNS::Subscription
    DependsOn:
      - LifecycleLambdaPermission
    Properties:
      TopicArn: !Ref LifecycleTopic
      Protocol: lambda
      Endpoint: !GetAtt LifecycleLambda.Arn

  LaunchHook:
    Type: AWS::AutoScaling::LifecycleHook
    Properties:
      AutoScalingGroupName: !Ref ECSAutoScalingGroup
      LifecycleTransition: autoscaling:EC2_INSTANCE_LAUNCHING
      HeartbeatTimeout: 300
      DefaultResult: CONTINUE
      NotificationTargetARN: !Ref LifecycleTopic
      RoleARN: !GetAtt LifecycleHookRole.Arn

  TerminateHook:
    Type: AWS::AutoScaling::LifecycleHook
    Properties:
      AutoScalingGroupName: !Ref ECSAutoScalingGroup
      LifecycleTransition: autoscaling:EC2_INSTANCE_TERMINATING
      HeartbeatTimeout: 300
      DefaultResult: CONTINUE
      NotificationTargetARN: !Ref LifecycleTopic
      RoleARN: !GetAtt LifecycleHookRole.Arn

  # ECS Task Roles
  TaskExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: ecs-tasks.amazonaws.com
            Action: sts:AssumeRole
      PermissionsBoundary: !If [HasPermissionBoundary, !Ref PermissionBoundaryArn, !Ref 'AWS::NoValue']
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  TaskRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: ecs-tasks.amazonaws.com
            Action: sts:AssumeRole
      PermissionsBoundary: !If [HasPermissionBoundary, !Ref PermissionBoundaryArn, !Ref 'AWS::NoValue']
      Tags:
        - Key: Environment
          Value: !Ref Environment
        - Key: ManagedBy
          Value: Starkeeper

  # Logging
  LogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub '/ecs/\${AWS::StackName}'
      RetentionInDays: 7

  # Task Definition
  OpenClawTaskDefinition:
    Type: AWS::ECS::TaskDefinition
    Properties:
      Family: !Sub '\${AWS::StackName}-openclaw'
      NetworkMode: host
      RequiresCompatibilities:
        - EC2
      Cpu: '1024'
      Memory: '1800'
      ExecutionRoleArn: !GetAtt TaskExecutionRole.Arn
      TaskRoleArn: !GetAtt TaskRole.Arn
      Volumes:
        - Name: openclaw-data
          EFSVolumeConfiguration:
            FilesystemId: !Ref FileSystem
      ContainerDefinitions:
        - Name: openclaw
          Image: !Ref OpenClawImage
          Essential: true
          Command:
            - node
            - dist/index.js
            - gateway
            - --bind
            - lan
            - --port
            - '18789'
          PortMappings:
            - ContainerPort: 18789
              Protocol: tcp
          Environment:
            - Name: ANTHROPIC_API_KEY
              Value: !If [IsAnthropic, !Ref LLMApiKey, '']
            - Name: OPENAI_API_KEY
              Value: !If [IsOpenAI, !Ref LLMApiKey, '']
            - Name: GEMINI_API_KEY
              Value: !If [IsGemini, !Ref LLMApiKey, '']
            - Name: OPENROUTER_API_KEY
              Value: !If [IsOpenRouter, !Ref LLMApiKey, '']
            - Name: OPENCLAW_GATEWAY_TOKEN
              Value: !Ref GatewayToken
            - Name: OPENCLAW_HOME
              Value: /home/node/.openclaw
          MountPoints:
            - SourceVolume: openclaw-data
              ContainerPath: /home/node/.openclaw
          LogConfiguration:
            LogDriver: awslogs
            Options:
              awslogs-group: !Ref LogGroup
              awslogs-region: !Ref AWS::Region
              awslogs-stream-prefix: openclaw

  # ECS Service
  OpenClawService:
    Type: AWS::ECS::Service
    DependsOn:
      - ECSAutoScalingGroup
      - MountTarget
    Properties:
      ServiceName: !Sub '\${AWS::StackName}-openclaw'
      Cluster: !Ref ECSCluster
      TaskDefinition: !Ref OpenClawTaskDefinition
      DesiredCount: 1
      LaunchType: EC2

Outputs:
  OpenClawURL:
    Description: OpenClaw gateway URL
    Value: !Sub 'http://\${OpenClawEip}:18789'

  ElasticIp:
    Description: Elastic IP address
    Value: !Ref OpenClawEip

  ClusterName:
    Description: ECS Cluster name
    Value: !Ref ECSCluster
`;
}

/**
 * Main template generator function
 */
export function generateTemplate(input: GenerateTemplateInput): string {
  switch (input.appType) {
    case "web-app":
      return generateWebAppTemplate(input.params);
    case "api-service":
      return generateApiServiceTemplate(input.params);
    case "data-pipeline":
      return generateDataPipelineTemplate(input.params);
    case "tailscale-exit-node":
      return generateTailscaleExitNodeTemplate(input.params);
    case "openclaw":
      return generateOpenClawTemplate(input.params);
    default:
      throw new Error(`Unknown app type: ${input.appType}`);
  }
}

/**
 * Get available app types
 */
export function getAvailableAppTypes() {
  return [
    {
      id: "web-app",
      name: "Static Website",
      description: "CloudFront + S3 static website hosting with OAC",
    },
    {
      id: "api-service",
      name: "API Service",
      description: "API Gateway + Lambda + DynamoDB serverless API",
    },
    {
      id: "data-pipeline",
      name: "Data Pipeline",
      description: "S3 + Glue + Athena data analytics pipeline",
    },
    {
      id: "tailscale-exit-node",
      name: "Tailscale Exit Node",
      description: "EC2-based Tailscale exit node for routing tailnet traffic through AWS",
      parameters: [
        {
          name: "TailscaleAuthKey",
          label: "Tailscale Auth Key",
          description: "Generate at https://login.tailscale.com/admin/settings/keys",
          required: true,
          secret: true,
        },
        {
          name: "InstanceType",
          label: "Instance Type",
          description: "EC2 instance type",
          defaultValue: "t3.micro",
        },
      ],
    },
    {
      id: "openclaw",
      name: "OpenClaw AI Assistant",
      description: "Self-hosted AI assistant with ECS on EC2, EFS storage, and Elastic IP (~$15/month)",
      parameters: [
        {
          name: "LLMProvider",
          label: "LLM Provider",
          description: "Which AI provider to use",
          required: true,
          options: ["anthropic", "openai", "gemini", "openrouter"],
          defaultValue: "anthropic",
        },
        {
          name: "LLMApiKey",
          label: "LLM API Key",
          description: "API key for the selected LLM provider",
          required: true,
          secret: true,
        },
        {
          name: "GatewayToken",
          label: "Gateway Token",
          description: "Authentication token for OpenClaw gateway access",
          required: true,
          secret: true,
        },
        {
          name: "EC2InstanceType",
          label: "Instance Type",
          description: "EC2 instance type (t3.small recommended)",
          defaultValue: "t3.small",
        },
      ],
    },
  ];
}
