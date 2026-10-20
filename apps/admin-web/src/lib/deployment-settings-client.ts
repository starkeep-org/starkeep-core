/**
 * Saving a change to the deployment's settings from the browser.
 *
 * The server route decides where the change goes: the cloud's SSM parameter
 * when this machine has a cloud, this machine's config otherwise. The browser
 * sends the operator's session whenever someone is signed in, and the route
 * says so when it needs one it did not get.
 */

import { operatorSessionIfSignedIn } from "./operator-session";

/** Save one change. Returns the refusal's sentences, or none. */
export async function saveDeploymentSettings(change: unknown): Promise<string[]> {
  let session;
  try {
    session = await operatorSessionIfSignedIn();
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const res = await fetch("/api/deployment-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      change,
      ...(session
        ? {
            credentials: session.credentials,
            stackPrefix: session.stackPrefix,
            region: session.region,
          }
        : {}),
    }),
  });
  if (res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { problems?: string[]; error?: string };
  return body.problems ?? [body.error ?? `Save failed (${res.status})`];
}
