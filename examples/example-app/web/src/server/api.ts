/**
 * The cloud entry of the manifest's `api` handler: the JWT-gated routes.
 *
 * The gateway sends this Lambda only the routes the handler declares, after
 * its Cognito JWT authorizer has accepted the caller's Bearer token. The
 * handler therefore checks no credential itself. `scripts/bundle.mjs` builds
 * this file to `api.mjs`, beside the `static` handler's `index.mjs`.
 */

import {
  toRequest,
  toResult,
  type ApiGatewayV2Event,
  type ApiGatewayV2Result,
} from "@starkeep/app-client/web";
import { echo } from "./echo.js";

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Result> {
  const req = toRequest(event);
  const path = new URL(req.url).pathname;
  if (req.method === "POST" && path.endsWith("/api/echo")) return toResult(await echo(req));
  return toResult(
    Response.json({ error: `The api handler has no route for ${path}` }, { status: 404 }),
  );
}
