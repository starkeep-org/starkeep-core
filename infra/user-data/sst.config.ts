/// <reference path="./.sst/platform/config.d.ts" />

// Deploys the per-user Starkeep data infrastructure:
//   - S3 bucket for object storage (images, markdown, etc.)
//   - Aurora DSQL cluster for the remote metadata index
//   - Lambda function + API Gateway for mediated data access
//
// Triggered by CodeBuild with environment variables:
//   STAGE               — stack prefix / stage name (e.g. "myname")
//   USER_POOL_ID        — Cognito User Pool ID for JWT authorizer
//   USER_POOL_CLIENT_ID — Cognito App Client ID for JWT authorizer
//
// Outputs: auroraHostname, bucketName, apiGatewayUrl, region
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

    // Lambda function — handles all API routes (mediated access to DSQL + S3)
    const apiFunction = new sst.aws.Function(`starkeep-api-${stage}`, {
      handler: "src/api-handler.handler",
      runtime: "nodejs22.x",
      timeout: "30 seconds",
      memory: "256 MB",
      nodejs: {
        install: ["pg", "@aws-sdk/dsql-signer", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "@aws-sdk/lib-storage"],
      },
      environment: {
        AURORA_ENDPOINT: $interpolate`${cluster.identifier}.dsql.${region}.on.aws`,
        S3_BUCKET: bucket.name,
      },
      permissions: [
        {
          actions: ["dsql:DbConnectAdmin"],
          resources: [cluster.arn],
        },
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
          resources: [$interpolate`${bucket.arn}`, $interpolate`${bucket.arn}/*`],
        },
      ],
    });

    // HTTP API Gateway with Cognito JWT authorizer
    const gateway = new sst.aws.ApiGatewayV2(`starkeep-gateway-${stage}`, {
      cors: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    const authorizer = gateway.addAuthorizer({
      name: "cognitoJwt",
      jwt: {
        audiences: [userPoolClientId],
        issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
      },
    });

    // OPTIONS preflight must be unauthenticated — JWT authorizer blocks CORS preflights
    // if they go through the $default route. Specific routes take precedence over $default.
    gateway.route("OPTIONS /{proxy+}", apiFunction.arn);

    // All other routes require a valid Cognito JWT.
    gateway.route("$default", apiFunction.arn, {
      auth: { jwt: { authorizer: authorizer.id } },
    });

    return {
      auroraHostname: $interpolate`${cluster.identifier}.dsql.${region}.on.aws`,
      bucketName: bucket.name,
      apiGatewayUrl: gateway.url,
      region: "us-east-1",
    };
  },
});
