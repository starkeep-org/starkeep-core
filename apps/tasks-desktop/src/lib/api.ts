import type { StarkeepSdk } from "@starkeep/sdk";
import { registerTasksEndpoints } from "@tasks/tasks-lib";

let registered = false;

export function ensureEndpointsRegistered(sdk: StarkeepSdk): void {
  if (registered) return;
  registerTasksEndpoints(sdk.api.router);
  registered = true;
}

export async function apiGet<T>(
  sdk: StarkeepSdk,
  path: string,
  userId: string,
  query?: Record<string, string>,
): Promise<T> {
  const response = await sdk.api.handleRequest({
    path,
    method: "GET",
    query,
    subject: { subjectType: "user", subjectId: userId },
  });
  if (response.status >= 400) {
    const err = `API GET ${path} → ${response.status}: ${JSON.stringify(response.body)}`;
    console.error(err);
    throw new Error(err);
  }
  return response.body as T;
}

export async function apiPost<T>(
  sdk: StarkeepSdk,
  path: string,
  userId: string,
  body: unknown,
): Promise<T> {
  const response = await sdk.api.handleRequest({
    path,
    method: "POST",
    body,
    subject: { subjectType: "user", subjectId: userId },
  });
  if (response.status >= 400) {
    const err = `API POST ${path} → ${response.status}: ${JSON.stringify(response.body)}`;
    console.error(err);
    throw new Error(err);
  }
  return response.body as T;
}

export async function apiPut<T>(
  sdk: StarkeepSdk,
  path: string,
  userId: string,
  body: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const response = await sdk.api.handleRequest({
    path,
    method: "PUT",
    body,
    query,
    subject: { subjectType: "user", subjectId: userId },
  });
  if (response.status >= 400) {
    throw new Error(
      `API error ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body as T;
}

export async function apiDelete<T>(
  sdk: StarkeepSdk,
  path: string,
  userId: string,
  query?: Record<string, string>,
): Promise<T> {
  const response = await sdk.api.handleRequest({
    path,
    method: "DELETE",
    query,
    subject: { subjectType: "user", subjectId: userId },
  });
  if (response.status >= 400) {
    throw new Error(
      `API error ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body as T;
}
