/**
 * The platform's default sign-in page, for an app that has no reason to style
 * its own.
 *
 * In the cloud, CloudFront's `signed-out-redirect` function sends every
 * signed-out navigation under `/apps/<appId>/` to `/apps/<appId>/sign-in`, so
 * every cloud app must answer that path. Before this helper, each app wrote the
 * same page: one button that starts the platform's managed sign-in, plus a
 * script that first tries to restore a live session. This module is that page.
 *
 * Opt-in, like `createSessionRoutes`. An app mounts the handler at `/sign-in`,
 * or mounts its own page there instead. Nothing in the platform intercepts the
 * path, so an app that wants its own page keeps full control of it.
 */

import { cookiePath, SIGN_IN_START_PATH } from "./session.js";

export interface SignInPageOptions {
  /** The app's id, as in the manifest. */
  appId: string;
  /** The name the page shows. Defaults to the app id. */
  appName?: string;
}

/**
 * Build the `/sign-in` handler: `app.get("/sign-in", () => page())`.
 *
 * The password goes to the managed login page, never to the app. In the cloud,
 * the page first trades a live session for a fresh token without asking
 * anything: `sk_token` lasts about an hour and `sk_session` lasts weeks, so a
 * person who never signed out lands here an hour after the last page load, and
 * `POST /api/session/refresh` sends them straight back. The refresh needs the
 * app to mount `createSessionRoutes` at `/api/session/*`, which every cloud app
 * that signs people in already does.
 *
 * One bounce, not a loop: when the app sends the browser straight back here
 * within 15 seconds of a refresh that succeeded, the page shows the button
 * rather than refreshing again.
 */
export function createSignInPage(opts: SignInPageOptions): () => Response {
  const base = cookiePath(opts.appId);
  const name = escapeHtml(opts.appName ?? opts.appId);
  const appId = escapeHtml(opts.appId);
  const returnPath = escapeHtml(`${base}/`);

  return () => {
    // Read per request rather than at build time, so a test or a local run
    // that sets the mode after import gets the page for that mode.
    const cloud = process.env.STARKEEP_APP_CLIENT_MODE === "cloud";
    const restore = cloud ? restoreSessionScript(base, opts.appId) : "";
    const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${name}: sign in</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
<h1>${name}</h1>
<form method="get" action="${SIGN_IN_START_PATH}">
  <input type="hidden" name="app" value="${appId}">
  <input type="hidden" name="return" value="${returnPath}">
  <button type="submit">Sign in</button>
</form>
${restore}
</body></html>`;
    return new Response(body, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  };
}

function restoreSessionScript(base: string, appId: string): string {
  const refresh = scriptString(`${base}/api/session/refresh`);
  const home = scriptString(`${base}/`);
  const key = scriptString(`starkeep:${appId}:signInBounce`);
  return `<script>
(async () => {
  const key = ${key};
  try {
    if (Date.now() - Number(sessionStorage.getItem(key)) < 15000) return;
  } catch {}
  try {
    const res = await fetch(${refresh}, { method: "POST", credentials: "same-origin" });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.signedIn) {
      try { sessionStorage.setItem(key, String(Date.now())); } catch {}
      location.replace(${home});
    }
  } catch {}
})();
</script>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A JSON string literal that cannot close the surrounding `<script>` element. */
function scriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
