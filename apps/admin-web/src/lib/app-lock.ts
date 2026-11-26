/**
 * The per-app lock that admin-web and the CLI share (`@starkeep/operator/locks`).
 */
import { acquireLock } from "@starkeep/operator/locks";

/**
 * Hold the app's lock, the one the CLI takes, for the length of `body`. A held
 * lock answers 409 with the command that holds it.
 */
export async function withAppLock(
  appId: string,
  command: string,
  body: () => Promise<Response>,
): Promise<Response> {
  const lock = acquireLock(`app-${appId}`, command);
  if (!lock.ok) {
    return Response.json(
      {
        error: `Another operation on ${appId} is running (pid ${lock.holder.pid}: ${lock.holder.command}). Try again once it ends.`,
      },
      { status: 409 },
    );
  }
  try {
    return await body();
  } finally {
    lock.release();
  }
}
