// ---------------------------------------------------------------------------
// Button colors carry meaning on the dashboard, so the three action classes
// each get one color and every card uses the same one.
//
//   ACTION_OCCASIONAL — light green. Install, manage, discover, set up: the
//                       actions an operator takes once or now and then.
//   ACTION_START      — dark green. Bringing something up.
//   ACTION_OPEN       — dark blue. Going to a running app.
//
// Apply these through the Button `className`; the shadcn variants stay as-is
// for everything outside the three classes.
// ---------------------------------------------------------------------------

export const ACTION_OCCASIONAL =
  "bg-green-100 text-green-900 hover:bg-green-200 dark:bg-green-900 dark:text-green-100 dark:hover:bg-green-800";

export const ACTION_START = "bg-green-600 text-white hover:bg-green-700";

export const ACTION_OPEN = "bg-blue-600 text-white hover:bg-blue-700";
