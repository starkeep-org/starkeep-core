/**
 * The dispatcher function's entry point: `dispatcher.handler` in the data
 * server's bundle, on the data server's role. See `dispatcher.ts`.
 */
import { dispatcherDeps } from "./api-handler.js";
import { dispatch, type RunReport } from "./dispatcher.js";
import type { LambdaContext } from "./handler-utils.js";

export async function handler(event: unknown, context: LambdaContext): Promise<RunReport[]> {
  const toClose: Array<() => Promise<void>> = [];
  try {
    return await dispatch(event, dispatcherDeps(context, toClose));
  } finally {
    await Promise.allSettled(toClose.map((close) => close()));
  }
}
