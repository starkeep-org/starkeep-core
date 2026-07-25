/**
 * Testing-library's `findBy*` / `waitFor` default to a 1s budget — a bet on how
 * fast a render settles rather than on whether it settles at all. A full
 * `turbo run test` runs every package's suite at once, and these suites wait on
 * effects that resolve promises before the UI is in its asserted state, so 1s of
 * headroom on a loaded machine is thinner than it looks.
 *
 * 5s keeps that headroom well under the 30s per-test timeout, so a genuinely
 * missing element still fails as a testing-library error naming the query
 * rather than as a bare vitest timeout.
 *
 * Only the jsdom suites need this; the API-route tests run in the node
 * environment and never touch the DOM utilities.
 */
export {};

if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/dom");
  configure({ asyncUtilTimeout: 5_000 });
}
