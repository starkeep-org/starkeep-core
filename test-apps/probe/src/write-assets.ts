/**
 * Stage Probe's static assets into a directory.
 *
 * Run by `build.mjs` for both surfaces: the cloud build ships the directory in
 * the Lambda zip, and the local build writes it beside `serve.mjs`. Both
 * surfaces then answer the same bytes through the platform's static responder.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ASSET_NAME,
  assetScript,
  OAUTH_CLIENT_PATH,
  oauthClientDocument,
  STATIC_NAME,
  staticStylesheet,
} from "./assets.js";

const assetsDir = process.argv[2];
if (!assetsDir) throw new Error("write-assets needs the staging assets dir as its argument");

const target = join(assetsDir, "_immutable", ASSET_NAME);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, assetScript(), "utf8");
console.log(`Staged: ${target}`);

const stylesheet = join(assetsDir, "_static", STATIC_NAME);
mkdirSync(dirname(stylesheet), { recursive: true });
writeFileSync(stylesheet, staticStylesheet(), "utf8");
console.log(`Staged: ${stylesheet}`);

// The OAuth client document, for a cloud build the installer names the
// deployment's URL to. CloudFront serves `_static/*` from the assets bucket,
// so the document has to be a file in the bundle.
const publicBaseUrl = process.env.STARKEEP_PUBLIC_BASE_URL;
const appBasePath = process.env.STARKEEP_APP_BASE_PATH;
if (publicBaseUrl && appBasePath) {
  const doc = join(assetsDir, OAUTH_CLIENT_PATH);
  writeFileSync(doc, oauthClientDocument(publicBaseUrl, appBasePath), "utf8");
  console.log(`Staged: ${doc}`);
}
