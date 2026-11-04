/**
 * The Starkeep star: the one definition core's icons draw from.
 *
 * Admin-web's and Drive's favicons come from here through `scripts/icons.ts`,
 * which writes each app's `src/icon.svg`. The managed login branding in
 * `app-sign-in-clients.ts` draws the same star at install time. Edit the star
 * here, run `pnpm icons`, and commit what it writes; `pnpm check:icons` fails
 * when a committed icon differs.
 *
 * `starkeep-apps` cannot import from core, so its `scripts/icons.mjs` keeps
 * its own copy of the shape for the Photos icons.
 */
import { escapeMarkup } from "@starkeep/protocol-primitives";

// The star and its inner pentagon, in a 64-unit box.
const STAR =
  "M 17.50 22.20 L 18.61 1.00 L 36.42 12.56 L 56.93 7.07 L 51.44 27.58 L 63.00 45.39 L 41.80 46.50 L 28.43 63.00 L 20.82 43.18 L 1.00 35.57 Z";
const PENTAGON = "M 51.44 27.58 L 41.80 46.50 L 20.82 43.18 L 17.50 22.20 L 36.42 12.56 Z";
// The circumcentre of the star's tips, which the star turns about.
const PIVOT = "-33.59 -30.41";

/** What sets one app's star apart: its gradient, corner to corner, and its turn. */
export interface StarLook {
  readonly stops: readonly string[];
  /** Degrees clockwise. */
  readonly turn: number;
}

export const ADMIN_STAR: StarLook = { stops: ["#4098ff", "#6366f1", "#b23bff"], turn: 43 };
export const DRIVE_STAR: StarLook = { stops: ["#22d3ee", "#4098ff", "#1d4ed8"], turn: 58 };

/**
 * The star's gradient and shapes in a 64 by 64 box, each line indented two
 * spaces, for placing inside an `<svg>` or a `<g>`. Scaled to 0.94, the star
 * stays inside the box at any turn.
 */
export function starBody(look: StarLook): string {
  const stops = look.stops.map(
    (color, i) => `      <stop offset="${i / (look.stops.length - 1)}" stop-color="${color}"/>`,
  );
  return [
    "  <defs>",
    '    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    ...stops,
    "    </linearGradient>",
    "  </defs>",
    `  <g transform="translate(32 32) rotate(${look.turn}) scale(0.94) translate(${PIVOT})">`,
    `    <path d="${STAR}" fill="url(#g)"/>`,
    `    <path d="${PENTAGON}" fill="none" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>`,
    "  </g>",
  ].join("\n");
}

/**
 * The star alone, as a 64 by 64 SVG. A `label` names it for assistive
 * technology, as a favicon wants. Cognito's asset check refuses `role` and
 * `aria-label`, so a branding asset passes none.
 */
export function starSvg(look: StarLook, label?: string): string {
  const named = label === undefined ? "" : ` role="img" aria-label="${escapeMarkup(label)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${named}>
${starBody(look)}
</svg>
`;
}
