/// <reference path="./.sst/platform/config.d.ts" />

// Deploys the per-user Starkeep data infrastructure:
//   - S3 bucket for object storage (shared data files + app-private prefixes)
//   - Aurora DSQL cluster for the shared metadata index
//   - Protocol-core Lambda + API Gateway for mediated data access
//
// S3 prefix layout:
//   shared/<typeId>/data/<recordId>/<file>  — shared type data files
//   apps/<appId>/...                        — app-private files (opaque to protocol)
//   admin/...                               — admin-app prefix
//
// The protocol-core Lambda execution role holds only:
//   sts:AssumeRole on ${StackPrefix}-app-* (to forward calls under each app's identity)
//   dsql:DbConnect (not Admin) — for base-level DSQL token signing
//   log writes on its own log group
//
// Triggered by CodeBuild with environment variables:
//   STAGE               — stack prefix / stage name (e.g. "myname")
//   USER_POOL_ID        — Cognito User Pool ID for JWT authorizer
//   USER_POOL_CLIENT_ID — Cognito App Client ID for JWT authorizer
//
// Outputs: auroraHostname, bucketName, apiGatewayUrl, apiGatewayId, region
export default $config({
  app(input) {
    return {
      name: "starkeep-user-data",
      removal: input?.stage === "prod" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    const stage = $app.stage;
    const region = aws.getRegionOutput().name;
    const accountId = aws.getCallerIdentityOutput({}).accountId;

    const userPoolId = process.env.USER_POOL_ID;
    const userPoolClientId = process.env.USER_POOL_CLIENT_ID;

    if (!userPoolId) throw new Error("USER_POOL_ID env var is required");
    if (!userPoolClientId) throw new Error("USER_POOL_CLIENT_ID env var is required");

    const cluster = new aws.dsql.Cluster(`starkeep-db-${stage}`, {
      deletionProtectionEnabled: stage === "prod",
      tags: { "starkeep:managed": "true", Stage: stage },
    });

    const bucket = new sst.aws.Bucket(`starkeep-files-${stage}`, {
      versioning: false,
    });

    // Bucket policy: deny any principal whose appId tag doesn't match the key's app prefix.
    // This is defense-in-depth — IAM already enforces this at the role level.
    new aws.s3.BucketPolicy(`starkeep-files-${stage}-policy`, {
      bucket: bucket.name,
      policy: $jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyMismatchedAppPrefix",
            Effect: "Deny",
            Principal: "*",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            Resource: $interpolate`${bucket.arn}/apps/*`,
            Condition: {
              StringNotLike: {
                "s3:prefix": [
                  $interpolate`apps/\${aws:PrincipalTag/starkeep:appId}/*`,
                ],
              },
            },
          },
        ],
      }),
    });

    // Protocol-core Lambda execution role — no broad S3 or DbConnectAdmin.
    // All shared-data access runs under the per-app assumed role.
    const apiRole = new aws.iam.Role(`starkeep-api-role-${stage}`, {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      inlinePolicies: [
        {
          name: "protocol-core-policy",
          policy: $jsonStringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AssumePerAppRoles",
                Effect: "Allow",
                Action: "sts:AssumeRole",
                Resource: $interpolate`arn:aws:iam::${accountId}:role/${stage}-app-*`,
              },
              {
                Sid: "DsqlConnect",
                Effect: "Allow",
                Action: "dsql:DbConnect",
                Resource: cluster.arn,
              },
              {
                Sid: "LogWrites",
                Effect: "Allow",
                Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: $interpolate`arn:aws:logs:*:${accountId}:log-group:/aws/lambda/${stage}-*`,
              },
            ],
          }),
        },
      ],
      tags: { "starkeep:managed": "true", "starkeep:appId": "data-server" },
    });

    const apiFunction = new sst.aws.Function(`starkeep-api-${stage}`, {
      handler: "src/api-handler.handler",
      runtime: "nodejs22.x",
      timeout: "30 seconds",
      memory: "256 MB",
      role: apiRole.arn,
      nodejs: {
        install: ["pg", "@aws-sdk/dsql-signer", "@aws-sdk/client-sts", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "@aws-sdk/lib-storage"],
      },
      environment: {
        AURORA_ENDPOINT: $interpolate`${cluster.identifier}.dsql.${region}.on.aws`,
        S3_BUCKET: bucket.name,
        STACK_PREFIX: stage,
        MANAGER_ROLE_ARN: $interpolate`arn:aws:iam::${accountId}:role/${stage}-manager-role`,
      },
    });

    const gateway = new sst.aws.ApiGatewayV2(`starkeep-gateway-${stage}`, {
      cors: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-Starkeep-App-Id", "X-Starkeep-App-Sig"],
      },
    });

    const authorizer = gateway.addAuthorizer({
      name: "cognitoJwt",
      jwt: {
        audiences: [userPoolClientId],
        issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
      },
    });

    gateway.route("OPTIONS /{proxy+}", apiFunction.arn);
    gateway.route("$default", apiFunction.arn, {
      auth: { jwt: { authorizer: authorizer.id } },
    });

    return {
      auroraHostname: $interpolate`${cluster.identifier}.dsql.${region}.on.aws`,
      bucketName: bucket.name,
      apiGatewayUrl: gateway.url,
      apiGatewayId: gateway.nodes.api.id,
      authorizerId: authorizer.id,
      region: "us-east-1",
    };
  },
});
