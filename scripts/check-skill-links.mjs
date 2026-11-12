#!/usr/bin/env node
/**
 * Checks every Markdown link in the `starkeep` plugin's skills
 * (`plugins/starkeep/skills/<name>/SKILL.md`).
 *
 * A destination is resolved relative to the SKILL.md's directory; a bare
 * `#anchor` means the SKILL.md itself. An installed plugin contains only
 * `plugins/starkeep/`, so a destination that resolves outside it is a failure:
 * skills link docs through the synced copies under `plugins/starkeep/ref/`
 * (see `scripts/sync-plugin-ref.mjs`), as `../../ref/<repo path>#anchor`. The
 * file must exist, and an anchor must equal the GitHub slug of an ATX heading
 * in it. `http:`, `https:` and `mailto:` destinations are skipped; query
 * strings are dropped.
 *
 * Prints `path:line  destination  reason` per failure and exits 1; otherwise
 * prints `checked N skills, M links` and exits 0, including when there are no
 * skills. Node built-ins only; runs from any working directory.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repoRoot, "plugins", "starkeep");
const skillsRoot = join(pluginRoot, "skills");

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
// `[text](dest)` and `![alt](dest)`; dest may be `<...>` and may carry a title.
const INLINE_LINK = /\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_DEF = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)/; // not `[^1]:` footnotes
const EXTERNAL = /^(https?|mailto):/i;

/** Lines outside fenced code blocks, as `{ text, line }` with 1-based numbers. */
function proseLines(source) {
  const out = [];
  let fence = null;
  source.split(/\r?\n/).forEach((text, i) => {
    const open = FENCE.exec(text);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      return;
    }
    if (open) {
      fence = open[1];
      return;
    }
    out.push({ text, line: i + 1 });
  });
  return out;
}

/** GitHub's heading slug: lowercase, keep letters/digits/spaces/-/_, spaces to hyphens. */
function slug(heading) {
  const rendered = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // a link renders as its text
    .trim()
    .toLowerCase();
  return rendered.replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
}

const anchorCache = new Map();

/** The set of heading anchors a Markdown file exposes, with `-1`, `-2` for repeats. */
function anchorsOf(file) {
  let anchors = anchorCache.get(file);
  if (anchors) return anchors;
  anchors = new Set();
  const seen = new Map();
  for (const { text } of proseLines(readFileSync(file, "utf8"))) {
    const m = ATX_HEADING.exec(text);
    if (!m) continue;
    const base = slug(m[1] ?? "");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

/** Every link destination in a SKILL.md, as `{ dest, line }`. */
function linksIn(source) {
  const links = [];
  for (const { text, line } of proseLines(source)) {
    const def = REFERENCE_DEF.exec(text);
    if (def) {
      links.push({ dest: def[1], line });
      continue;
    }
    const prose = text.replace(/(`+)[^`]*?\1/g, ""); // code spans hold no links
    for (const m of prose.matchAll(INLINE_LINK)) links.push({ dest: m[1], line });
  }
  return links.map(({ dest, line }) => ({ dest: dest.replace(/^<(.*)>$/, "$1"), line }));
}

/** The reason a destination fails, or null when it is fine. */
function check(skillFile, dest) {
  const hash = dest.indexOf("#");
  const pathPart = (hash === -1 ? dest : dest.slice(0, hash)).split("?")[0];
  let decoded;
  let anchor;
  try {
    decoded = decodeURI(pathPart);
    anchor = hash === -1 ? null : decodeURIComponent(dest.slice(hash + 1));
  } catch {
    return "malformed percent-encoding";
  }
  const target = decoded === "" ? skillFile : resolve(dirname(skillFile), decoded);
  if (target !== pluginRoot && !target.startsWith(pluginRoot + sep)) {
    return "outside plugins/starkeep/ (link the synced copy under ref/)";
  }
  if (!existsSync(target)) return "file does not exist";
  if (anchor === null || anchor === "") return null;
  if (statSync(target).isDirectory()) return "anchor on a directory";
  if (!anchorsOf(target).has(anchor)) return "no heading with this anchor";
  return null;
}

const skillFiles = existsSync(skillsRoot)
  ? readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(skillsRoot, d.name, "SKILL.md"))
      .filter((f) => existsSync(f))
      .sort()
  : [];

let linkCount = 0;
const failures = [];
for (const skillFile of skillFiles) {
  for (const { dest, line } of linksIn(readFileSync(skillFile, "utf8"))) {
    if (EXTERNAL.test(dest)) continue;
    linkCount++;
    const reason = check(skillFile, dest);
    if (reason) failures.push(`${relative(repoRoot, skillFile)}:${line}  ${dest}  ${reason}`);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(`checked ${skillFiles.length} skills, ${linkCount} links`);
