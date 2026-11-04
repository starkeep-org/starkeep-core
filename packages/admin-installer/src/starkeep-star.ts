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

type Point = readonly [number, number];

// The star's points in a 64-unit box, alternating inner corner and tip.
const POINTS: readonly Point[] = [
  [17.5, 22.2],
  [18.61, 1.0],
  [36.42, 12.56],
  [56.93, 7.07],
  [51.44, 27.58],
  [63.0, 45.39],
  [41.8, 46.5],
  [28.43, 63.0],
  [20.82, 43.18],
  [1.0, 35.57],
];
// The circumcentre of the star's tips, which the star turns about.
const PIVOT = "-33.59 -30.41";
// The black pentagon through the inner corners is this wide.
const OUTLINE_WIDTH = 1.4;

const path = (rings: readonly (readonly Point[])[]) =>
  rings
    .map(
      (ring) =>
        ring
          .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`)
          .join(" ") + " Z",
    )
    .join(" ");

const STAR = path([POINTS]);

/**
 * The pentagon through the star's inner corners, as a filled band rather than
 * a stroke. A stroke centred on the pentagon would poke past the star's edge
 * at each inner corner, and Cognito's asset check may refuse a clip path, so
 * the band's outer edge follows the star's edge near each corner instead.
 */
function outlineBand(): string {
  const half = OUTLINE_WIDTH / 2;
  const corners = POINTS.filter((_, i) => i % 2 === 0);
  const tips = POINTS.filter((_, i) => i % 2 === 1);
  const mean = (axis: 0 | 1) =>
    corners.reduce((sum, corner) => sum + corner[axis], 0) / corners.length;
  const centre: Point = [mean(0), mean(1)];
  // Where the line through `p` along `d` meets the line through `q` along `e`.
  const meet = (p: Point, d: Point, q: Point, e: Point): Point => {
    const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / (d[0] * e[1] - d[1] * e[0]);
    return [p[0] + t * d[0], p[1] + t * d[1]];
  };
  // Each pentagon side, from corner i to corner i + 1, with its tip beyond it
  // and the side pushed out (+half) or in (-half) by half the outline's width.
  const sides = corners.map((from, i) => {
    const to = corners[(i + 1) % corners.length];
    const along: Point = [to[0] - from[0], to[1] - from[1]];
    const length = Math.hypot(along[0], along[1]);
    let normal: Point = [-along[1] / length, along[0] / length];
    if (normal[0] * (from[0] - centre[0]) + normal[1] * (from[1] - centre[1]) < 0)
      normal = [-normal[0], -normal[1]];
    const offset = (by: number): Point => [from[0] + by * normal[0], from[1] + by * normal[1]];
    return { from, to, tip: tips[i], along, offset };
  });
  const outer = sides.flatMap(({ from, to, tip, along, offset }) => [
    from,
    meet(offset(half), along, from, [tip[0] - from[0], tip[1] - from[1]]),
    meet(offset(half), along, to, [tip[0] - to[0], tip[1] - to[1]]),
  ]);
  const inner = sides.map((side, i) => {
    const before = sides[(i + sides.length - 1) % sides.length];
    return meet(before.offset(-half), before.along, side.offset(-half), side.along);
  });
  return path([outer, inner]);
}

const OUTLINE = outlineBand();

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
    `    <path d="${OUTLINE}" fill="#000" fill-rule="evenodd"/>`,
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
