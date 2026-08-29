/**
 * The `api` handler: one route, `POST /api/echo`, behind the gateway's Cognito
 * JWT authorizer.
 *
 * It exists to be a JWT-gated app route. The platform's user-facing app routes
 * take the signed-in user's id token as a Bearer credential rather than an app
 * HMAC signature, and the only place that credential crosses the CloudFront
 * edge is a route like this one — so a suite needs one to prove the edge
 * forwards `Authorization` at all.
 *
 * Echoing the body back is deliberate: the assertion is about who was let
 * through, so the handler should add nothing that could fail for its own
 * reasons.
 */

import { toRequest, toResult, type ApiGatewayV2Event, type ApiGatewayV2Result } from "./lambda.js";

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Result> {
  const req = toRequest(event);
  let echo: unknown = null;
  try {
    const text = await req.text();
    echo = text ? JSON.parse(text) : null;
  } catch {
    echo = null;
  }
  return toResult(
    new Response(JSON.stringify({ ok: true, echo }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}
