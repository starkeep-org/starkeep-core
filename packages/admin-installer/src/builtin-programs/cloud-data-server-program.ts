/**
 * Inline Pulumi program for the cloud-data-server built-in app.
 *
 * Provisions the cloud-side data plane:
 *   - Aurora DSQL cluster (the per-user metadata index)
 *   - S3 files bucket + bucket policy (apps/<id>/* prefix isolation)
 *   - Lambda function (the protocol-core broker) using the per-app role
 *     ${stackPrefix}-app-cloud-data-server-role minted by Manager outside Pulumi
 *   - CloudWatch log group for the Lambda
 *   - API Gateway v2 + Cognito JWT authorizer + default catch-all routes
 *
 * Stack outputs match the previous SST shape so per-app Pulumi installs can
 * read apiGatewayId and authorizerId to attach their own routes:
 *   auroraHostname, bucketName, apiGatewayUrl, apiGatewayId, authorizerId, region
 *
 * The Lambda's IAM role is NOT a Pulumi resource — Manager mints it as part
 * of the install pipeline (createAppRole + broker-power policy). Pulumi only
 * references its ARN.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface CloudDataServerProgramContext {
  stackPrefix: string;
  region: string;
  accountId: string;
  /** ARN of the per-app role minted by Manager (used as the Lambda execution role). */
  appRoleArn: string;
  /** Local filesystem path to the prebuilt Lambda zip (admin-installer reads it from disk). */
  distZipPath: string;
  /** Cognito user-pool resources from bootstrap, needed to wire the JWT authorizer. */
  userPoolId: string;
  userPoolClientId: string;
}

export function buildCloudDataServerProgram(
  ctx: CloudDataServerProgramContext,
): () => Promise<void> {
  return async () => {
    // -----------------------------------------------------------------------
    // DSQL cluster
    // -----------------------------------------------------------------------
    const cluster = new aws.dsql.Cluster(`${ctx.stackPrefix}-db`, {
      deletionProtectionEnabled: false,
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    });

    const auroraHostname = pulumi.interpolate`${cluster.identifier}.dsql.${ctx.region}.on.aws`;

    // -----------------------------------------------------------------------
    // Files bucket + bucket policy
    // -----------------------------------------------------------------------
    const bucket = new aws.s3.BucketV2(`${ctx.stackPrefix}-files`, {
      bucket: `${ctx.stackPrefix}-files-${ctx.accountId}`,
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    });

    new aws.s3.BucketPolicy(`${ctx.stackPrefix}-files-policy`, {
      bucket: bucket.id,
      policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyMismatchedAppPrefix",
            Effect: "Deny",
            Principal: "*",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            Resource: pulumi.interpolate`${bucket.arn}/apps/*`,
            Condition: {
              StringNotLike: {
                "s3:prefix": [
                  "apps/${aws:PrincipalTag/starkeep:appId}/*",
                ],
              },
            },
          },
        ],
      }),
    });

    // -----------------------------------------------------------------------
    // Lambda log group
    // -----------------------------------------------------------------------
    const lambdaName = `${ctx.stackPrefix}-app-cloud-data-server-api`;

    const logGroup = new aws.cloudwatch.LogGroup("api-log-group", {
      name: `/aws/lambda/${lambdaName}`,
      retentionInDays: 14,
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    });

    // -----------------------------------------------------------------------
    // Lambda function
    // -----------------------------------------------------------------------
    const fn = new aws.lambda.Function(
      "api",
      {
        name: lambdaName,
        role: ctx.appRoleArn,
        runtime: aws.lambda.Runtime.NodeJS22dX,
        handler: "api-handler.handler",
        code: new pulumi.asset.FileArchive(ctx.distZipPath),
        memorySize: 256,
        timeout: 30,
        environment: {
          variables: {
            AURORA_ENDPOINT: auroraHostname,
            S3_BUCKET: bucket.bucket,
            STACK_PREFIX: ctx.stackPrefix,
            MANAGER_ROLE_ARN: `arn:aws:iam::${ctx.accountId}:role/${ctx.stackPrefix}-manager-role`,
            STARKEEP_APP_ID: "cloud-data-server",
            STARKEEP_STACK_PREFIX: ctx.stackPrefix,
          },
        },
        tags: {
          "starkeep:managed": "true",
          "starkeep:appId": "cloud-data-server",
        },
      },
      { dependsOn: [logGroup] },
    );

    // -----------------------------------------------------------------------
    // API Gateway v2 + Cognito JWT authorizer + default catch-all routes
    // -----------------------------------------------------------------------
    const api = new aws.apigatewayv2.Api(`${ctx.stackPrefix}-gateway`, {
      name: `${ctx.stackPrefix}-gateway`,
      protocolType: "HTTP",
      corsConfiguration: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: [
          "Content-Type",
          "Authorization",
          "X-Starkeep-App-Id",
          "X-Starkeep-App-Sig",
        ],
      },
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    });

    const stage = new aws.apigatewayv2.Stage(`${ctx.stackPrefix}-gateway-stage`, {
      apiId: api.id,
      name: "$default",
      autoDeploy: true,
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    });

    const authorizer = new aws.apigatewayv2.Authorizer("cognito-jwt", {
      apiId: api.id,
      authorizerType: "JWT",
      identitySources: ["$request.header.Authorization"],
      jwtConfiguration: {
        audiences: [ctx.userPoolClientId],
        issuer: `https://cognito-idp.${ctx.region}.amazonaws.com/${ctx.userPoolId}`,
      },
      name: "cognitoJwt",
    });

    // Lambda integration
    const integration = new aws.apigatewayv2.Integration("api-integration", {
      apiId: api.id,
      integrationType: "AWS_PROXY",
      integrationUri: fn.invokeArn,
      payloadFormatVersion: "2.0",
    });

    // Permit API Gateway to invoke the Lambda
    new aws.lambda.Permission("api-invoke", {
      action: "lambda:InvokeFunction",
      function: fn.name,
      principal: "apigateway.amazonaws.com",
      sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
    });

    // OPTIONS catch-all (no auth, for CORS preflight)
    new aws.apigatewayv2.Route("options-proxy", {
      apiId: api.id,
      routeKey: "OPTIONS /{proxy+}",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    // $default — every authenticated request not claimed by another route
    new aws.apigatewayv2.Route("default", {
      apiId: api.id,
      routeKey: "$default",
      target: pulumi.interpolate`integrations/${integration.id}`,
      authorizerId: authorizer.id,
      authorizationType: "JWT",
    });

    // -----------------------------------------------------------------------
    // Stack outputs — matches what per-app installs read to attach their
    // own routes to this gateway.
    // -----------------------------------------------------------------------
    pulumi.export("auroraHostname", auroraHostname);
    pulumi.export("bucketName", bucket.bucket);
    pulumi.export("apiGatewayId", api.id);
    pulumi.export("apiGatewayUrl", pulumi.interpolate`${api.apiEndpoint}/${stage.name}`);
    pulumi.export("authorizerId", authorizer.id);
    pulumi.export("functionArn", fn.arn);
    pulumi.export("region", ctx.region);
  };
}
