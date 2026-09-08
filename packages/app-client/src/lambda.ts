/**
 * The platform's Lambda entry shape: `@starkeep/app-client/lambda`.
 *
 * One invariant, stated as an API rather than as a comment. **A Node handler
 * must load its module graph during Lambda's INIT phase.** INIT runs at
 * elevated CPU, is not billed, and has its own budget, so the graph belongs at
 * module scope. A handler that defers the load into the first invocation pays
 * for it inside the billed, timeout-bounded request instead, and the telemetry
 * hides the trade: `Init Duration` still reads healthy because the entry module
 * itself loaded quickly.
 *
 * Memo is the worked example. Its wrapper deferred an `import()` into the
 * handler and reported `Init Duration: 120-171 ms` with 7766-8015 ms inside the
 * request, against a ten-second timeout it had already touched once. Photos
 * ships the same wrapper with the import at module scope and reports
 * `Init Duration: 981-1066 ms` with 570-609 ms in the handler, on a larger
 * bundle.
 *
 * `upstream` therefore takes a **promise, not a thunk**, and that is the whole
 * design. A thunk can be called at any time, so a thunk-shaped API permits
 * exactly the defect this fixes. A promise handed to a top-level `await` has
 * already started and must settle before the entry module finishes evaluating,
 * which is to say during INIT. The correct thing is the only thing that
 * type-checks.
 *
 * Deliberately kept to that one job. Per-invocation platform concerns —
 * request correlation, structured logging — belong here eventually, and adding
 * them now would make every app's migration a behavior change rather than a
 * refactor.
 */

/** Any function a Lambda entry module may export as `handler`. */
// The generic ranges over the whole function type rather than over an
// `(event, context)` pair because the same guarantee is worth having for a
// handler with a different calling convention — the web adapter's upstream
// takes a `Request` and an app-relative path, and it composes with this rather
// than reimplementing it.
export type UpstreamHandler = (...args: never[]) => unknown;

export interface LambdaEntryOptions<H extends UpstreamHandler> {
  /**
   * The already-started import of the module that exports `handler`.
   *
   * Write it as `import("./app/index.mjs")`, never as
   * `() => import("./app/index.mjs")`.
   *
   * A module that names its entry something else maps with `.then` on the same
   * already-started import — `import("./app.js").then((m) => ({ handler:
   * m.handleRequest }))` — which keeps the guarantee and stays type-checked.
   */
  upstream: Promise<{ handler: H }>;
  /**
   * How to name the upstream when it exports no handler. The failure happens
   * during INIT, where the only thing Lambda reports is that the module threw,
   * so the message has to carry the identification itself.
   */
  label?: string;
}

/**
 * Resolve an upstream module to its `handler` export.
 *
 * Await this at module scope:
 *
 * ```js
 * export const handler = await createLambdaEntry({
 *   upstream: import("./app/index.mjs"),
 * });
 * ```
 */
export async function createLambdaEntry<H extends UpstreamHandler>(
  opts: LambdaEntryOptions<H>,
): Promise<H> {
  const label = opts.label ?? "the upstream module";
  const mod = await opts.upstream;
  const handler = (mod as { handler?: unknown } | undefined)?.handler;
  if (typeof handler !== "function") {
    throw new Error(
      `Starkeep Lambda entry: ${label} does not export a \`handler\` function ` +
        `(got ${handler === undefined ? "undefined" : typeof handler}). The entry resolves ` +
        `this during INIT, so the deployment fails at startup rather than on the first request.`,
    );
  }
  return handler as H;
}
