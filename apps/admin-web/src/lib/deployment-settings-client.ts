/**
 * Saving a change to the deployment's settings from the browser.
 *
 * The server route decides where the change goes: the cloud's SSM parameter
 * when this machine has a cloud, this machine's config otherwise. With a cloud,
 * the route acts as the signed-in admin, and says so when no one is signed in.
 */

/** Save one change. Returns the refusal's sentences, or none. */
export async function saveDeploymentSettings(change: unknown): Promise<string[]> {
  const res = await fetch("/api/deployment-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ change }),
  });
  if (res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { problems?: string[]; error?: string };
  return body.problems ?? [body.error ?? `Save failed (${res.status})`];
}
