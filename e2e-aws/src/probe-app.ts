/**
 * Core's own app profile: the Probe fixture in `test-apps/probe`.
 *
 * This is what the tier-3 journey runs against when no app is configured, and
 * it is what makes the suite runnable on a machine holding nothing but this
 * checkout. Probe declares every surface the journey needs — a label vocabulary,
 * an app-private table, a JWT-gated route, a browser UI — so core's default run
 * is a full journey rather than a subset of one.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { JourneyApp } from "./journey-app.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const probeApp: JourneyApp = {
  appId: "probe",
  appDir: resolve(REPO_ROOT, "test-apps", "probe"),
  // Neither key may be Probe's size-class key (`variant`): a size-class label
  // claims the record is a derived rung of some original, which would make the
  // later variant-resolution reads treat this record as its own variant.
  labelKeys: { flag: "flag", valued: "tag" },
  appTable: {
    name: "probe_notes",
    row: (recordId) => ({ record_id: recordId, note: "tier-3 note" }),
    expectInBody: "tier-3 note",
  },
  jwtRoute: {
    path: "/api/echo",
    method: "POST",
    // Echoed straight back. The assertion is about who was let through the
    // authorizer and whether the Bearer header survived CloudFront, so the
    // handler must add nothing that could fail for its own reasons.
    body: (recordId) => ({ targetId: recordId }),
  },
  browser: { signedInControl: "Upload" },
};
