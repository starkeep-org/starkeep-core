/**
 * Inline Pulumi program for the cloud-data-server built-in app.
 *
 * Provisions the cloud-side data plane:
 *   - Aurora DSQL cluster (the per-user metadata index)
 *   - S3 files bucket + bucket policy (apps/<id>/* prefix isolation)
 *   - Lambda function (the protocol-core broker) using the per-app role
 *     ${stackPrefix}-app-cloud-data-server-role minted by Manager outside Pulumi
 *   - CloudWatch log group for the Lambda
 *   - API Gateway v2 + Cognito JWT authorizer + explicit reserved sub-namespaces
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
  /**
   * Base64-encoded SHA-256 of dist.zip. Wired to aws.lambda.Function.sourceCodeHash
   * so Pulumi detects bundle changes across redeploys. Mirrors the per-app installer.
   */
  bundleHash: string;
  /** Cognito user-pool resources from bootstrap, needed to wire the JWT authorizer. */
  userPoolId: string;
  userPoolClientId: string;
}

export function buildCloudDataServerProgram(
  ctx: CloudDataServerProgramContext,
): () => Promise<Record<string, unknown>> {
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
      bucket: `${ctx.stackPrefix}-files-${ctx.accountId}-${ctx.region}`,
      tags: {
        "starkeep:managed": "true",
        "starkeep:appId": "cloud-data-server",
      },
    });

    // Defense-in-depth: deny any principal whose starkeep:appId tag does not
    // match the apps/<appId>/* prefix being accessed. The IAM permissions
    // boundary already scopes per-app roles to their own prefix; this is a
    // redundant second gate enforced at the bucket itself. cloud-data-server,
    // when brokering on behalf of an app, uses the assumed app role's
    // credentials (which carry the matching tag), so brokering is unaffected.
    new aws.s3.BucketPolicy(`${ctx.stackPrefix}-files-policy`, {
      bucket: bucket.id,
      policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            // Deny object-level access under apps/* whose key does not live
            // under apps/<principal's starkeep:appId>/*. The IAM permissions
            // boundary already enforces this on the principal side; the
            // bucket policy is a redundant second gate on the resource side.
            //
            // The ArnNotLike condition on aws:ResourceArn expands the
            // ${aws:PrincipalTag/starkeep:appId} policy variable at
            // evaluation time and compares against the requested resource
            // ARN, so the same statement covers GetObject, PutObject,
            // DeleteObject, etc.
            //
            // cloud-data-server, when brokering on behalf of an app, uses
            // the assumed app role's credentials (which carry the matching
            // tag), so brokering naturally satisfies the condition.
            // Untagged principals get an empty expansion and are denied —
            // which is intentional for the apps/* keyspace.
            Sid: "DenyCrossAppPrefixAccess",
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: pulumi.interpolate`${bucket.arn}/apps/*`,
            Condition: {
              ArnNotLike: {
                "aws:ResourceArn": pulumi.interpolate`${bucket.arn}/apps/\${aws:PrincipalTag/starkeep:appId}/*`,
              },
            },
          },
        ],
      }),
    });

    // Browser uploads/downloads go directly to S3 via presigned URLs from the
    // photos app served at the API Gateway origin, so the bucket itself must
    // answer CORS preflights. Mirrors the gateway's `allowOrigins: ["*"]`.
    new aws.s3.BucketCorsConfigurationV2(`${ctx.stackPrefix}-files-cors`, {
      bucket: bucket.id,
      corsRules: [{
        allowedMethods: ["GET", "PUT", "HEAD"],
        allowedOrigins: ["*"],
        allowedHeaders: ["*"],
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3000,
      }],
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
        sourceCodeHash: ctx.bundleHash,
        memorySize: 256,
        timeout: 30,
        environment: {
          variables: {
            AURORA_ENDPOINT: auroraHostname,
            S3_BUCKET: bucket.bucket,
            STACK_PREFIX: ctx.stackPrefix,
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
    // API Gateway v2 + Cognito JWT authorizer + explicit reserved sub-namespaces
    //
    // The cloud-data-server lambda is reached via:
    //   - OPTIONS /{proxy+}             (CORS preflight, no auth)
    //   - GET     /health               (public liveness check)
    //   - GET     /apps/{appId}/health  (per-app authenticated health)
    //   - ANY     /apps/{appId}/data/{proxy+}
    //   - ANY     /apps/{appId}/files/{proxy+}
    //   - ANY     /apps/{appId}/sync/{proxy+}
    //
    // These routes claim the reserved data-plane sub-namespaces on the shared
    // gateway. APIGW v2 picks the most-specific match, so an app's own
    // `GET /apps/{appId}/{proxy+}` (e.g. photos static site) still serves UI
    // paths but loses to these routes for `data`, `files`, `sync`, `health`.
    // No `$default` — stray traffic gets an APIGW 404 without invoking lambda.
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

    // Public liveness check (no auth)
    new aws.apigatewayv2.Route("route-root-health", {
      apiId: api.id,
      routeKey: "GET /health",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    // Per-app health endpoint. App identity is established by the handler's
    // HMAC verifier (X-Starkeep-App-Id + X-Starkeep-App-Sig against the SSM
    // SecureString at /${stackPrefix}/app-creds/${appId}), not by the
    // gateway's JWT authorizer. The data plane identifies the *app*, not the
    // end user; end-user identity is the app's business.
    new aws.apigatewayv2.Route("route-app-health", {
      apiId: api.id,
      routeKey: "GET /apps/{appId}/health",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    // Reserved data-plane sub-namespaces. {appId} is a path variable purely
    // for APIGW route specificity — the handler parses appId from rawPath
    // itself and does not read event.pathParameters. All four routes rely on
    // the handler's HMAC verifier for identity; no gateway authorizer.
    new aws.apigatewayv2.Route("route-data-proxy", {
      apiId: api.id,
      routeKey: "ANY /apps/{appId}/data/{proxy+}",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    new aws.apigatewayv2.Route("route-files-proxy", {
      apiId: api.id,
      routeKey: "ANY /apps/{appId}/files/{proxy+}",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    new aws.apigatewayv2.Route("route-sync-proxy", {
      apiId: api.id,
      routeKey: "ANY /apps/{appId}/sync/{proxy+}",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    // Step 2: cloud-side /app-data/* surface (mirrors local-data-server's
    // /app-data/db/<table> and /app-data/files/<key> routes). Handler logic
    // lives in api-handler.ts; this route is what makes it reachable through
    // the gateway. Identity gated by the HMAC verifier, same as the others.
    new aws.apigatewayv2.Route("route-app-data-proxy", {
      apiId: api.id,
      routeKey: "ANY /apps/{appId}/app-data/{proxy+}",
      target: pulumi.interpolate`integrations/${integration.id}`,
    });

    // -----------------------------------------------------------------------
    // Billing bucket + CUR report definition
    //
    // CUR is a global service (us-east-1 only), so we need a dedicated
    // provider for those resources regardless of the deployment region.
    // -----------------------------------------------------------------------
    const usEast1Provider = new aws.Provider("us-east-1-provider", { region: "us-east-1" });

    const billingBucket = new aws.s3.BucketV2(`${ctx.stackPrefix}-billing`, {
      bucket: `${ctx.stackPrefix}-billing-${ctx.accountId}-${ctx.region}`,
      tags: { "starkeep:managed": "true", "starkeep:appId": "cloud-data-server" },
    });

    const curSourceArn = `arn:aws:cur:us-east-1:${ctx.accountId}:definition/*`;
    const billingBucketPolicy = new aws.s3.BucketPolicy(`${ctx.stackPrefix}-billing-policy`, {
      bucket: billingBucket.id,
      policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowCurServiceCheck",
            Effect: "Allow",
            Principal: { Service: "billingreports.amazonaws.com" },
            Action: ["s3:GetBucketAcl", "s3:GetBucketPolicy"],
            Resource: billingBucket.arn,
            Condition: {
              StringEquals: {
                "aws:SourceArn": curSourceArn,
                "aws:SourceAccount": ctx.accountId,
              },
            },
          },
          {
            Sid: "AllowCurDelivery",
            Effect: "Allow",
            Principal: { Service: "billingreports.amazonaws.com" },
            Action: "s3:PutObject",
            Resource: pulumi.interpolate`${billingBucket.arn}/*`,
            Condition: {
              StringEquals: {
                "aws:SourceArn": curSourceArn,
                "aws:SourceAccount": ctx.accountId,
              },
            },
          },
        ],
      }),
    });

    const reportName = `${ctx.stackPrefix}-billing`;
    new aws.cur.ReportDefinition(reportName, {
      reportName,
      timeUnit: "DAILY",
      format: "textORcsv",
      compression: "GZIP",
      additionalSchemaElements: [],
      s3Bucket: billingBucket.bucket,
      s3Prefix: "reports",
      s3Region: ctx.region,
      refreshClosedReports: true,
      reportVersioning: "OVERWRITE_REPORT",
    }, { provider: usEast1Provider, dependsOn: [billingBucket, billingBucketPolicy] });

    // -----------------------------------------------------------------------
    // Stack outputs — matches what per-app installs read to attach their
    // own routes to this gateway.
    // -----------------------------------------------------------------------
    return {
      auroraHostname,
      bucketName: bucket.bucket,
      billingBucketName: billingBucket.bucket,
      apiGatewayId: api.id,
      apiGatewayExecutionArn: api.executionArn,
      // $default stage is served at the API root — do not append the stage name.
      apiGatewayUrl: pulumi.all([api.apiEndpoint, stage.name]).apply(([endpoint, name]) =>
        name === "$default" ? endpoint : `${endpoint}/${name}`,
      ),
      authorizerId: authorizer.id,
      functionArn: fn.arn,
      region: ctx.region,
    };
  };
}
