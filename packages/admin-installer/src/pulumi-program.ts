/**
 * Generates the inline Pulumi program for a per-app compute stack.
 *
 * The manifest is the spec — apps don't ship Pulumi code. This caps what
 * third-party apps can request to what the manifest schema permits.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { AppManifest } from "@starkeep/admin-manifest";
import type { ComputeContext } from "./compute-stack";

export function buildPulumiProgram(
  manifest: AppManifest,
  ctx: ComputeContext,
): () => Promise<Record<string, unknown>> {
  return async () => {
    const handlers = manifest.infraRequirements.compute.handlers;
    const outputs: Record<string, unknown> = {};

    for (const handler of handlers) {
      const fnName = `${ctx.stackPrefix}-app-${ctx.appId}-${handler.name}`;

      const logGroup = new aws.cloudwatch.LogGroup(`logGroup-${handler.name}`, {
        name: `/aws/lambda/${fnName}`,
        retentionInDays: 14,
        tags: { "starkeep:appId": ctx.appId, "starkeep:managed": "true" },
      });

      const fn = new aws.lambda.Function(`fn-${handler.name}`, {
        name: fnName,
        role: ctx.appRoleArn,
        runtime: aws.lambda.Runtime.NodeJS22dX,
        handler: handler.handler,
        s3Bucket: ctx.artifactsBucket,
        s3Key: `apps/${ctx.appId}/latest/dist.zip`,
        memorySize: handler.memoryMb,
        timeout: handler.timeoutSeconds,
        environment: {
          variables: {
            STARKEEP_APP_ID: ctx.appId,
            STARKEEP_STACK_PREFIX: ctx.stackPrefix,
            STARKEEP_DSQL_HOSTNAME: ctx.dsqlHostname,
            STARKEEP_FILES_BUCKET: ctx.filesBucket,
            ...handler.env,
          },
        },
        tags: { "starkeep:appId": ctx.appId, "starkeep:managed": "true" },
      }, { dependsOn: [logGroup] });

      // Allow the shared API Gateway to invoke this Lambda. AWS_PROXY
      // integrations require a Lambda resource-based policy entry — without
      // it, every request through the gateway returns 403 from API Gateway.
      // The sourceArn is the gateway execution ARN with /*/* wildcards
      // (stage/method).
      new aws.lambda.Permission(`invoke-${handler.name}`, {
        action: "lambda:InvokeFunction",
        function: fn.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: `${ctx.apiGatewayExecutionArn}/*/*`,
      });

      const integration = new aws.apigatewayv2.Integration(`integration-${handler.name}`, {
        apiId: ctx.apiGatewayId,
        integrationType: "AWS_PROXY",
        integrationUri: fn.arn,
        payloadFormatVersion: "2.0",
      });

      const routes = handler.routes.length > 0 ? handler.routes : ["$default"];
      for (let i = 0; i < routes.length; i++) {
        const routeKey = routes[i] === "$default"
          ? `$default`
          : routes[i]!;

        // Prefix every app route under /apps/<appId>. A route key like
        // "GET /foo" becomes "GET /apps/photos/foo". The root "GET /" must
        // collapse to "GET /apps/photos" (no trailing slash) — API Gateway v2
        // rejects keys with empty path segments ("BadRequestException: Part of
        // the given route key path is empty").
        const prefixedRouteKey = routeKey === "$default"
          ? routeKey
          : routeKey.replace(/^([A-Z]+) \/(.*)$/, (_m, method, rest) =>
              rest === "" ? `${method} /apps/${ctx.appId}` : `${method} /apps/${ctx.appId}/${rest}`);

        const route = new aws.apigatewayv2.Route(`route-${handler.name}-${i}`, {
          apiId: ctx.apiGatewayId,
          routeKey: prefixedRouteKey,
          target: pulumi.interpolate`integrations/${integration.id}`,
          authorizerId: ctx.authorizerId,
          authorizationType: "JWT",
        });

        outputs[`routeId:${handler.name}-${i}`] = route.id;
      }

      outputs[`functionArn:${handler.name}`] = fn.arn;
    }

    return outputs;
  };
}
