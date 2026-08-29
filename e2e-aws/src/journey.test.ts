/**
 * Core's tier-3 run.
 *
 * The journey itself lives in `journey.ts` and is app-agnostic; this file only
 * decides which app it runs against. Unset, that is the Probe fixture core
 * ships, so the suite needs no other checkout on the machine and asserts
 * nothing about any real application. `STARKEEP_AWS_APP_DIR=<path>` points the
 * same journey at a real app instead — the mode that proves a genuine
 * framework application survives the bundle-and-deploy path.
 *
 * A configured app supplies no assertions of its own here: what is true of that
 * app belongs in that app's repository, which consumes this harness through
 * `@starkeep/e2e-aws` and adds its own steps. What this file runs, in either
 * mode, is the platform journey.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCloudJourney } from "./journey.js";
import { APP_DIR } from "./env.js";
import { probeApp } from "./probe-app.js";
import type { JourneyApp } from "./journey-app.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Resolve the configured app into a profile, or fail saying why.
 *
 * A bad path fails the run rather than falling back to the fixture. Asking for
 * a real app and silently getting the fixture would report a green journey that
 * never tested what was asked for, which is worse than no run at all.
 */
function configuredApp(dir: string): JourneyApp {
  const appDir = isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir);
  const manifestPath = join(appDir, "starkeep.manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `STARKEEP_AWS_APP_DIR=${dir} holds no starkeep.manifest.json (looked at ${manifestPath}). ` +
        "Point it at an app's source directory, or unset it to run against the Probe fixture.",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    id?: string;
    infraRequirements?: {
      labelKeys?: Array<{ key: string; sizeClass?: boolean }>;
      appSpecificSyncable?: { tables?: Array<{ name: string; columns: Array<{ name: string }> }> };
      compute?: { handlers?: Array<{ routes?: string[]; auth?: string }> };
    };
  };
  if (!manifest.id) throw new Error(`${manifestPath} declares no id`);

  // Everything below is read out of the app's own manifest rather than written
  // down here, so the profile cannot drift from what the app actually declared
  // — a stale name would fail as a broker 400 and read as a platform fault.
  const ir = manifest.infraRequirements ?? {};

  // Any two declared keys that are not the size-class key. A size-class label
  // claims the record is a derived rung of some original, which would make the
  // later variant-resolution reads treat the record as its own variant.
  const keys = (ir.labelKeys ?? []).filter((k) => !k.sizeClass).map((k) => k.key);
  if (keys.length < 2) {
    throw new Error(
      `${manifest.id} declares ${keys.length} non-size-class label key(s); the cross-app ` +
        "label step needs two (one written valueless, one written with a value).",
    );
  }

  const table = (ir.appSpecificSyncable?.tables ?? [])[0];
  if (!table) {
    throw new Error(
      `${manifest.id} declares no appSpecificSyncable table; the /app-data step needs one.`,
    );
  }
  // The first non-key text column is where the marker value goes. The record-id
  // column is the primary key by convention, so anything after it is free.
  const valueColumn = table.columns[1]?.name;
  if (!valueColumn) {
    throw new Error(`${manifest.id}'s ${table.name} has no column to write a value into.`);
  }

  // A route on a handler the manifest did NOT put behind the session
  // authorizer: that is what leaves it on the gateway's JWT authorizer, which
  // is the credential this step follows across the CloudFront edge.
  const jwtRoute = (ir.compute?.handlers ?? [])
    .filter((h) => h.auth !== "session")
    .flatMap((h) => h.routes ?? [])
    .map((r) => r.split(" "))
    .find(([method, path]) => method !== undefined && path !== undefined && path !== "$default");
  if (!jwtRoute) {
    throw new Error(
      `${manifest.id} declares no JWT-gated compute route; the CloudFront Bearer step needs one.`,
    );
  }

  const marker = `tier-3 ${manifest.id}`;
  return {
    appId: manifest.id,
    appDir,
    labelKeys: { flag: keys[0]!, valued: keys[1]! },
    appTable: {
      name: table.name,
      row: (recordId) => ({ [table.columns[0]!.name]: recordId, [valueColumn]: marker }),
      expectInBody: marker,
    },
    jwtRoute: {
      method: jwtRoute[0]!,
      path: jwtRoute[1]!,
      body: (recordId) => ({ targetId: recordId }),
    },
    // No browser surface: the control names are the one thing a manifest cannot
    // describe. An app that wants its UI driven runs the journey from its own
    // repository, where it can name them.
  };
}

defineCloudJourney(APP_DIR ? configuredApp(APP_DIR) : probeApp);
