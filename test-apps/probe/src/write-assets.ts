/**
 * Stage Probe's static assets into a directory the cloud bundle ships.
 *
 * Run by `build.mjs` during the cloud build, and only there. The local surface
 * answers the same bytes from `handleRequest`, so nothing here is a second
 * source of truth: both call `assetScript()`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ASSET_NAME, assetScript } from "./assets.js";

const assetsDir = process.argv[2];
if (!assetsDir) throw new Error("write-assets needs the staging assets dir as its argument");

const target = join(assetsDir, "_next", "static", ASSET_NAME);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, assetScript(), "utf8");
console.log(`Staged: ${target}`);
