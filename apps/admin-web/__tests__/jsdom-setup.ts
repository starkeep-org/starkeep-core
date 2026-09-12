/**
 * The handful of DOM APIs jsdom does not implement, stubbed so a component
 * under test fails for its own reasons rather than for the environment's.
 *
 * Each stub is here because a real component calls it: `scrollIntoView` keeps
 * the install log pinned to its newest line, and `matchMedia` is what the
 * layout primitives ask for a breakpoint with. Both are no-ops worth nothing in
 * a test and worth asserting nothing about.
 *
 * Guarded on `Element` because this file also loads for the route-handler tests,
 * which run in plain Node with no DOM at all.
 */
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
