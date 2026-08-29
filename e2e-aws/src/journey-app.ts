/**
 * What the tier-3 journey needs to know about the app it is driving.
 *
 * The journey asserts platform properties — an app installs, its bundle
 * deploys, its routes register, its shell serves, its session gates, its
 * records sync, its app-private table takes a row, its uninstall leaves shared
 * data behind. None of those claims is about a particular application, but
 * making any of them requires *an* application, and the details differ: which
 * label keys the manifest declared, what the app-private table is called, which
 * route sits behind the JWT authorizer.
 *
 * This interface is that difference, and nothing more. It carries no
 * assertions: an app describes itself here, and the journey decides what to
 * conclude. Anything an app wants asserted about *itself* goes in `extraSteps`,
 * which runs in that app's own repository against the same live stack.
 */

import type { LdsApp } from "@starkeep/e2e";
import type { AdminSession } from "./installers.js";
import type { AdminCredentials, TestStackConfig } from "./run-state.js";

/** A label key the app declared, as the journey needs to exercise it. */
export interface JourneyLabelKeys {
  /** A valueless key. Exercises the presence half of the reverse label index. */
  readonly flag: string;
  /** A valued key. Exercises the exact-value seek half of the reverse index. */
  readonly valued: string;
}

/** The app-private table the journey writes one row into. */
export interface JourneyAppTable {
  readonly name: string;
  /** A row whose columns the manifest declared. Must include the record-id column. */
  row(recordId: string): Record<string, unknown>;
  /** A value the row write must make readable back out, proving the write landed. */
  readonly expectInBody: string;
}

/** A route of the app's own, behind the gateway's Cognito JWT authorizer. */
export interface JourneyJwtRoute {
  /** App-relative path, e.g. "/api/echo". */
  readonly path: string;
  readonly method?: string;
  body(recordId: string): unknown;
}

/**
 * The browser surface, when the app has one worth driving.
 *
 * Every field here is about locating things on a page, because that is the only
 * part of a browser journey an app cannot share. The sign-in form itself is the
 * platform's, so the journey drives it directly.
 */
export interface JourneyBrowserSurface {
  /** Accessible name of the control that proves sign-in completed. */
  readonly signedInControl: string;
  /** Accessible name of the upload control. */
  readonly uploadControl?: string;
}

export interface JourneyApp {
  /** Manifest id. The journey installs, drives and uninstalls this app. */
  readonly appId: string;
  /** Absolute path to the app's source directory (holding `starkeep.manifest.json`). */
  readonly appDir: string;
  /** Label keys the manifest declares, for the cross-app label step. */
  readonly labelKeys: JourneyLabelKeys;
  /** The app-private table the app-data step writes to. */
  readonly appTable: JourneyAppTable;
  /** A JWT-gated route of the app's own, for the CloudFront Bearer step. */
  readonly jwtRoute: JourneyJwtRoute;
  /** Present when the app serves a browser UI the journey should drive. */
  readonly browser?: JourneyBrowserSurface;
  /**
   * Refuse to start when the machine is in a state that would take the run down
   * later — a dev server already holding the app's directory, say. Runs before
   * the first AWS call, which is the only cheap moment to fail.
   */
  preflight?(): void | Promise<void>;
  /**
   * Steps that assert things about *this app* rather than about the platform.
   * Registered after the platform steps that set up the state they read, and
   * before uninstall. An app with nothing to add omits this.
   *
   * Called inside the journey's `describe`, so it may register `afterAll` and
   * friends as well as `it`. Anything a step starts — a dev server, a watcher —
   * must be stopped in such a hook rather than on the last step's success path:
   * a step that fails midway would otherwise leak the process into the next
   * run, and the next run would refuse to start.
   */
  extraSteps?(ctx: JourneyContext): void;
}

/**
 * The live journey state an app's own steps read.
 *
 * Every field is a getter rather than a value, because the steps are registered
 * before the journey runs and the state is filled in step by step. A captured
 * value would be `undefined` forever.
 */
export interface JourneyContext {
  /** This run's stack config, after the cloud-data-server install rewrote it. */
  config(): TestStackConfig;
  /** The admin session, for a Bearer token or an AWS credential. */
  session(): AdminSession;
  /**
   * The test admin's email and password, for a step that signs in through a
   * browser rather than through the token exchange.
   */
  adminCredentials(): AdminCredentials;
  /** The app under test, signed against the LOCAL data server. */
  localApp(): LdsApp;
  /** The app under test, signed against the cloud broker with an end-user token. */
  cloudApp(): LdsApp;
  /** Drive's all-access identity against the local data server — drives `/sync/now`. */
  drive(): LdsApp;
  /** Drive against the cloud broker. */
  cloudDrive(): LdsApp;
  /** The local data server's base URL. */
  ldsUrl(): string;
  /**
   * Everything the local data server has written to stdout/stderr this run.
   *
   * Exists because the sync supervisor swallows a per-engine exchange failure
   * into a logged `lastError` and still answers `/sync/now` with 200 and
   * `shipped: 0`. A step that waits for rows to arrive therefore cannot tell
   * "nothing to ship" from "every round threw" out of the HTTP response, and
   * fails as a bare timeout. Dump this when that wait runs out.
   */
  ldsLogs(): string;
  /** This run's STARKEEP_DIR, shared by the CLIs and the local data server. */
  dataDir(): string;
  /** Sign in through the app's own session route; returns the `Cookie` header. */
  signInToApp(appId: string): Promise<string>;
}
