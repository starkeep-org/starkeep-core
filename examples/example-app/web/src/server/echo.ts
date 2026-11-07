/**
 * `POST /api/echo`: the example's JWT-gated route.
 *
 * Most of an app's server routes sit behind the session cookie, like every
 * route `app.ts` serves. A JWT-gated route is the other kind. In the cloud the
 * manifest gives it a handler of its own, `api`, with no `auth` field, so the
 * gateway's Cognito JWT authorizer guards it. The caller presents the
 * signed-in user's token as `Authorization: Bearer <token>`; a page gets that
 * token from `GET /api/session/token`. A route that a phone or a script calls
 * with a token, rather than a browser with a cookie, has this shape.
 *
 * The route echoes its JSON body back and adds nothing of its own, so a
 * caller learns only that the gateway let it through. That makes it the route
 * an app gives core's tier-3 journey as `jwtRoute`: `defineCloudJourney` calls
 * it directly on the gateway and again through CloudFront, to prove the
 * `Authorization` header survives the edge.
 *
 * On the local surface `app.ts` serves the same function same-origin, with no
 * token: the person and the data share one computer.
 */
export async function echo(req: Request): Promise<Response> {
  let body: unknown = null;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    return Response.json({ error: "The body must be JSON" }, { status: 400 });
  }
  return Response.json({ ok: true, echo: body });
}
