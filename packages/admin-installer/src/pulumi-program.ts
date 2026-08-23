/**
 * Generates the inline Pulumi program for a per-app compute stack.
 *
 * The manifest is the spec — apps don't ship Pulumi code. This caps what
 * third-party apps can request to what the manifest schema permits.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { AppManifest } from "@starkeep/admin-manifest";
import { prefixAppRouteKey, resolveHandlerRoutes } from "@starkeep/admin-manifest";
import type { ComputeContext } from "./compute-stack";

/**
 * Sub-paths under /apps/{appId}/ claimed by the cloud-data-server's
 * explicit APIGW routes (see cloud-data-server-program.ts). Per-app
 * handlers may not register literal routes whose first sub-segment matches
 * one of these — those paths are routed to the shared data broker by
 * APIGW v2 specificity regardless of any app's {proxy+} claim, so a
 * literal collision in a manifest is always a mistake.
 */
const RESERVED_SUBPATHS = new Set(["data", "files", "sync", "health", "app-data"]);

/**
 * The session authorizer's id, or a refusal.
 *
 * Falling back to no authorizer here would silently deploy the app wide open —
 * exactly the failure this whole mechanism exists to prevent, and one that
 * would look like a successful install. A missing id means the CDS stack
 * predates the authorizer, and the fix is to reinstall it, not to ship an
 * ungated app.
 */
function requireSessionAuthorizer(ctx: ComputeContext): string {
  if (!ctx.sessionAuthorizerId) {
    throw new Error(
      `App "${ctx.appId}" declares auth "session" but the cloud-data-server stack exposes no ` +
        `sessionAuthorizerId. Reinstall the cloud-data-server so the session authorizer exists; ` +
        `installing this app without it would publish every route to the internet.`,
    );
  }
  return ctx.sessionAuthorizerId;
}

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
        ...(ctx.bundleHash ? { sourceCodeHash: ctx.bundleHash } : {}),
        memorySize: handler.memoryMb,
        timeout: handler.timeoutSeconds,
        environment: {
          variables: {
            STARKEEP_APP_ID: ctx.appId,
            STARKEEP_STACK_PREFIX: ctx.stackPrefix,
            STARKEEP_DSQL_HOSTNAME: ctx.dsqlHostname,
            STARKEEP_FILES_BUCKET: ctx.filesBucket,
            // Activate @starkeep/app-client cloud mode: the client will fetch
            // its HMAC secret from SSM via the Lambda's exec role and route
            // signed calls through the shared API Gateway. See
            // packages/app-client/src/credentials.ts.
            STARKEEP_APP_CLIENT_MODE: "cloud",
            STARKEEP_CLOUD_DATA_BASE: ctx.apiGatewayUrl,
            STARKEEP_APP_CREDS_PARAMETER_NAME: `/${ctx.stackPrefix}/app-creds/${ctx.appId}`,
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

      // Each route carries its own resolved auth: the route-level override if
      // the manifest gave one, else the handler's `auth`. A handler is
      // therefore no longer all-or-nothing — a public shell can sit beside a
      // JWT-gated data subtree on the same Lambda.
      const routes = resolveHandlerRoutes(handler);
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i]!;

        // Prefix every app route under /apps/<appId>. A route key like
        // "GET /foo" becomes "GET /apps/photos/foo". The root "GET /" must
        // collapse to "GET /apps/photos" (no trailing slash) — API Gateway v2
        // rejects keys with empty path segments ("BadRequestException: Part of
        // the given route key path is empty").
        //
        // The first sub-segment after /apps/<appId>/ is a reserved namespace
        // for the cloud-data-server (data, files, sync, health). A literal
        // segment matching any of those is rejected below; {proxy+} is fine
        // and is shadowed by the more-specific reserved routes at runtime.
        // `routeKey`, not `declared`: a route derived from a publicPaths entry
        // carries the bare path in `declared` and its real key here.
        const prefixedRouteKey = prefixAppRouteKey(ctx.appId, route.routeKey);

        if (prefixedRouteKey !== "$default") {
          const match = prefixedRouteKey.match(/^[A-Z]+ (\/.*)$/);
          const path = match?.[1] ?? "";
          const prefix = `/apps/${ctx.appId}/`;
          if (path.startsWith(prefix)) {
            const firstSeg = path.slice(prefix.length).split("/")[0] ?? "";
            if (RESERVED_SUBPATHS.has(firstSeg)) {
              throw new Error(
                `App "${ctx.appId}" handler "${handler.name}" declares route "${route.declared}" ` +
                `which after prefixing becomes "${prefixedRouteKey}". The sub-paths ` +
                `/apps/${ctx.appId}/{data,files,sync,health,app-data}/... are reserved for the ` +
                `cloud-data-server and cannot be claimed by an app handler. ` +
                `Note: these paths are also unreachable via a wildcard like "GET /{proxy+}" — ` +
                `API Gateway v2 routes the broker's more-specific reserved routes first, ` +
                `so a wildcard handler will silently never see them.`,
              );
            }
          }
        }

        // Three ways a route can be gated, and the choice is the app's:
        //
        //   public  — no authorizer. Under `session` these are the routes
        //             derived from publicPaths, each more specific than the
        //             gated catch-all, so the declaration is the reach.
        //   jwt     — the Cognito JWT authorizer, reading a bearer token from
        //             `Authorization`. Right for a route the app's own code
        //             calls; a browser navigation cannot send that header.
        //   session — the platform's REQUEST authorizer, reading the session
        //             cookie. The answer for anything a browser navigates to,
        //             and the reason enforcement can live here rather than in
        //             an app's own middleware gating itself.
        const authorization =
          route.auth === "public"
            ? {}
            : route.auth === "session"
              ? {
                  authorizerId: requireSessionAuthorizer(ctx),
                  authorizationType: "CUSTOM",
                }
              : { authorizerId: ctx.authorizerId, authorizationType: "JWT" };

        const created = new aws.apigatewayv2.Route(`route-${handler.name}-${i}`, {
          apiId: ctx.apiGatewayId,
          routeKey: prefixedRouteKey,
          target: pulumi.interpolate`integrations/${integration.id}`,
          ...authorization,
        });

        outputs[`routeId:${handler.name}-${i}`] = created.id;
      }

      outputs[`functionArn:${handler.name}`] = fn.arn;
    }

    return outputs;
  };
}
