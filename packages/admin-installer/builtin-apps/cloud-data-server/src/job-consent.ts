/**
 * The job consent page, and the connections page's background jobs.
 *
 * - `GET /connect/job?app=<appId>&job=<name>&tz=<zone>&return=<path>` shows
 *   the job: its app, its sentence, what it may do, a time of day (the
 *   template's default first) or "Only when I ask", and the time zone, with
 *   the browser's zone from `tz` preselected.
 * - `POST /connect/job/approve` keeps the choices in the pending cookie and
 *   starts the managed login, so each enrollment holds its own Cognito
 *   refresh token, as each delegation does.
 * - The managed login returns to `GET /connect/callback`, which calls
 *   {@link jobCallback}: it seals the refresh token under the enrollment's id,
 *   writes the enrollment and links back to the app at `return`.
 * - The connections page lists the user's enrollments
 *   ({@link jobsSection}), and `POST /connections/jobs/<id>/schedule` and
 *   `POST /connections/jobs/<id>/revoke` change a job's time or turn it off.
 *
 * Every page answers on the gateway's execute-api hostname only, as the
 * other consent pages do; see `connect-routes.ts`.
 */
import {
  CONNECT_JOB_APPROVE_ROUTE,
  CONNECT_JOB_ROUTE,
  CONNECTIONS_ROUTE,
  JOB_NAME_PATTERN,
  escapeMarkup,
  jobRevokePath,
  jobSchedulePath,
} from "@starkeep/protocol-primitives";
import {
  clearPending,
  csrfFor,
  csrfOk,
  html,
  message,
  newPendingIds,
  redirect,
  revokeAtCognito,
  sameOriginPost,
  startSignIn,
  type ConnectDeps,
  type ConnectRequest,
  type ConnectResponse,
  type PendingBase,
  type Tokens,
} from "./connect-pages.js";
import { openRefreshToken, sealRefreshToken } from "./delegation-tokens.js";
import { templateFor } from "./dispatcher.js";
import { loadJobApp, type JobApp, type JobTemplate } from "./job-manifest.js";
import { NEEDS_CONSENT_MESSAGE, NO_LIBRARY_MESSAGE, SIGNED_OUT_MESSAGE } from "./job-messages.js";
import { nextDueAt, selectableTimeZones, TIME_OF_DAY_PATTERN, zoneOrUtc } from "./job-schedule.js";
import {
  enrollmentId,
  findEnrollment,
  listEnrollments,
  revokeEnrollment,
  setSchedule,
  upsertEnrollment,
  type JobRow,
} from "./job-store.js";

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** What the job consent carries through managed login. */
export interface PendingJob extends PendingBase {
  kind: "job";
  app: string;
  job: string;
  timeOfDay: string | null;
  timeZone: string;
  returnTo: string;
}

/**
 * The path the consent page links back to: a path under the app's own
 * prefix, or the app's root. Anything else, such as another app's path or a
 * full URL, falls back to the root, so the page never links off the app.
 */
export function returnPathFor(appId: string, raw: unknown): string {
  const root = `/apps/${appId}/`;
  if (typeof raw !== "string" || raw.length > 512) return root;
  if (!raw.startsWith(root) || raw.includes("\\") || raw.includes("//")) return root;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return root;
  return raw;
}

interface JobForm {
  app: string;
  job: string;
  timeOfDay: string | null;
  timeZone: string;
  returnTo: string;
}

/** The consent form's choices, checked. */
export function checkJobForm(
  raw: Record<string, unknown>,
): { ok: true; value: JobForm } | { ok: false; message: string } {
  const { app, job } = raw;
  if (typeof app !== "string" || !APP_ID_PATTERN.test(app)) {
    return { ok: false, message: "This link names no app." };
  }
  if (typeof job !== "string" || !JOB_NAME_PATTERN.test(job)) {
    return { ok: false, message: "This link names no job." };
  }
  let timeOfDay: string | null = null;
  if (raw.when !== "manual") {
    if (typeof raw.time !== "string" || !TIME_OF_DAY_PATTERN.test(raw.time)) {
      return {
        ok: false,
        message: "Pick a time of day, or choose to run the job only when you ask.",
      };
    }
    timeOfDay = raw.time;
  }
  const timeZone = zoneOrUtc(typeof raw.tz === "string" ? raw.tz : null);
  return {
    ok: true,
    value: { app, job, timeOfDay, timeZone, returnTo: returnPathFor(app, raw.return) },
  };
}

/** The pending cookie's job consent, or null when it does not check out. */
export function readPendingJob(
  p: Record<string, unknown>,
  ids: { state: string; verifier: string },
): PendingJob | null {
  const form = checkJobForm({
    app: p.app,
    job: p.job,
    when: p.timeOfDay === null ? "manual" : "time",
    time: p.timeOfDay,
    tz: p.timeZone,
    return: p.returnTo,
  });
  return form.ok ? { kind: "job", ...ids, ...form.value } : null;
}

function modeWords(mode: "read" | "readwrite"): string {
  return mode === "read" ? "read your data in" : "read and change your data in";
}

function zoneOptions(selected: string): string {
  return selectableTimeZones()
    .map(
      (z) =>
        `<option value="${escapeMarkup(z)}"${z === selected ? " selected" : ""}>` +
        `${escapeMarkup(z)}</option>`,
    )
    .join("");
}

async function jobOf(
  deps: ConnectDeps,
  appId: string,
  job: string,
): Promise<{ app: JobApp; template: JobTemplate } | null> {
  const app = await loadJobApp(await deps.db(), appId);
  const template = templateFor(app, job);
  return app && template ? { app, template } : null;
}

export async function jobConsentPage(
  req: ConnectRequest,
  deps: ConnectDeps,
): Promise<ConnectResponse> {
  const appId = req.query.app ?? "";
  const job = req.query.job ?? "";
  if (!APP_ID_PATTERN.test(appId) || !JOB_NAME_PATTERN.test(job)) {
    return message(deps, 400, "This link names no job.");
  }
  const found = await jobOf(deps, appId, job);
  if (!found) return message(deps, 404, `${appId} offers no job called ${job} here.`);
  const { app, template } = found;
  const zone = zoneOrUtc(req.query.tz);
  const returnTo = returnPathFor(appId, req.query.return);
  const { token, cookies } = csrfFor(req);
  const scheduled = template.defaultTime !== null;
  const body =
    `<p><strong>${escapeMarkup(app.name)}</strong> asks to run its job ` +
    `<code>${escapeMarkup(template.name)}</code> for you in the cloud.</p>` +
    `<p>${escapeMarkup(template.description)}</p>` +
    `<p>Each run may ${modeWords(template.mode)} ${escapeMarkup(app.name)}. The job keeps ` +
    `running until you turn it off on <a href="${CONNECTIONS_ROUTE}">your connections</a>, ` +
    `or until you sign out everywhere.</p>` +
    `<form method="post" action="${CONNECT_JOB_APPROVE_ROUTE}">` +
    `<input type="hidden" name="csrf" value="${escapeMarkup(token)}">` +
    `<input type="hidden" name="app" value="${escapeMarkup(appId)}">` +
    `<input type="hidden" name="job" value="${escapeMarkup(job)}">` +
    `<input type="hidden" name="return" value="${escapeMarkup(returnTo)}">` +
    `<fieldset><legend>When</legend>` +
    `<label><input type="radio" name="when" value="time"${scheduled ? " checked" : ""}> ` +
    `Every day at <input type="time" name="time" value="${escapeMarkup(template.defaultTime ?? "06:00")}"></label>` +
    `<label><input type="radio" name="when" value="manual"${scheduled ? "" : " checked"}> ` +
    `Only when I ask</label></fieldset>` +
    `<label for="tz">Time zone</label><select id="tz" name="tz">${zoneOptions(zone)}</select>` +
    `<p><button type="submit">Sign in and turn the job on</button></p></form>`;
  return html(deps, 200, "Turn on a background job", body, cookies);
}

export async function approveJob(req: ConnectRequest, deps: ConnectDeps): Promise<ConnectResponse> {
  if (!sameOriginPost(req.headers, deps.host)) {
    return message(deps, 403, "This request did not come from the consent page.");
  }
  const form = new URLSearchParams(req.body);
  if (!csrfOk(req, form)) {
    return message(deps, 403, "This form has expired. Open the consent page again.");
  }
  const checked = checkJobForm(Object.fromEntries(form));
  if (!checked.ok) return message(deps, 400, checked.message);
  if (!(await jobOf(deps, checked.value.app, checked.value.job))) {
    return message(
      deps,
      404,
      `${checked.value.app} offers no job called ${checked.value.job} here.`,
    );
  }
  return startSignIn(deps, { kind: "job", ...newPendingIds(), ...checked.value });
}

/** Finish a job consent after managed login: write the enrollment. */
export async function jobCallback(
  deps: ConnectDeps,
  pending: PendingJob,
  tokens: Tokens,
): Promise<ConnectResponse> {
  // Checked again here, not only on the form: the app may have dropped the
  // job, or been uninstalled, during the sign-in.
  const found = await jobOf(deps, pending.app, pending.job);
  if (!found) {
    await revokeAtCognito(deps, tokens.refreshToken);
    return message(deps, 404, `${pending.app} offers no job called ${pending.job} here.`, [
      clearPending(),
    ]);
  }
  const key = await deps.signingKey();
  if (!key) return message(deps, 503, "Background jobs are not set up on this cloud yet.");
  const now = (deps.now ?? Date.now)();
  const db = await deps.db();
  const id = enrollmentId(tokens.userId, pending.app, pending.job);
  // Turning a job on again replaces its stored refresh token, so the old one
  // ends at Cognito rather than lingering until it expires.
  const prior = await findEnrollment(db, id);
  await upsertEnrollment(
    db,
    {
      id,
      user_id: tokens.userId,
      app_id: pending.app,
      job: pending.job,
      mode: found.template.mode,
      time_zone: pending.timeZone,
      time_of_day: pending.timeOfDay,
      cognito_refresh_ciphertext: sealRefreshToken(key.refreshKey, id, tokens.refreshToken),
      next_due_at_ms: pending.timeOfDay
        ? nextDueAt(pending.timeZone, pending.timeOfDay, now)
        : null,
    },
    now,
  );
  deps.forgetDelegation(id);
  if (prior && prior.revoked_at_ms === null) {
    const old = openRefreshToken(key.refreshKey, id, prior.cognito_refresh_ciphertext);
    if (old) await revokeAtCognito(deps, old);
  }
  const back = `https://${await deps.publicHost()}${pending.returnTo}`;
  const when = pending.timeOfDay
    ? `every day at ${escapeMarkup(pending.timeOfDay)} (${escapeMarkup(pending.timeZone)})`
    : "whenever you ask";
  const body =
    `<p>${escapeMarkup(found.app.name)} will run <code>${escapeMarkup(pending.job)}</code> ` +
    `${when}.</p>` +
    `<p><a href="${escapeMarkup(back)}">Back to ${escapeMarkup(found.app.name)}</a></p>` +
    `<p><a href="${CONNECTIONS_ROUTE}">Your connections</a></p>`;
  return html(deps, 200, "Background job on", body, [clearPending()]);
}

// ---------------------------------------------------------------------------
// The connections page
// ---------------------------------------------------------------------------

function describeSchedule(row: JobRow): string {
  return row.time_of_day
    ? `Every day at ${escapeMarkup(row.time_of_day)}<br><small>${escapeMarkup(row.time_zone)}</small>`
    : "Only when you ask";
}

function describeLastRun(row: JobRow): string {
  if (row.last_status === null) return "Never";
  const at = row.last_finished_at_ms ?? row.last_started_at_ms;
  const when = at === null ? "" : ` on ${escapeMarkup(new Date(at).toUTCString())}`;
  const words = { ok: "Succeeded", failed: "Failed", deferred: "Postponed", stopped: "Stopped" };
  return `${words[row.last_status]}${when}`;
}

/** Why a job needs the user, or an empty cell. */
function describeAttention(row: JobRow, consentUrl: string): string {
  if (row.attention === null) return "";
  if (row.attention === "failed") {
    return `<span class="warn">The last run failed${
      row.last_message ? `: ${escapeMarkup(row.last_message)}` : "."
    }</span>`;
  }
  const words = {
    "signed-out": SIGNED_OUT_MESSAGE,
    "no-library": NO_LIBRARY_MESSAGE,
    "needs-consent": NEEDS_CONSENT_MESSAGE,
  }[row.attention];
  return (
    `<span class="warn">${escapeMarkup(words)}</span> ` +
    `<a href="${escapeMarkup(consentUrl)}">Turn it on again</a>`
  );
}

function scheduleForm(row: JobRow, csrf: string): string {
  return (
    `<form method="post" action="${escapeMarkup(jobSchedulePath(row.id))}">` +
    `<input type="hidden" name="csrf" value="${escapeMarkup(csrf)}">` +
    `<input type="hidden" name="tz" value="${escapeMarkup(row.time_zone)}">` +
    `<label><input type="radio" name="when" value="time"${row.time_of_day ? " checked" : ""}> ` +
    `At <input type="time" name="time" value="${escapeMarkup(row.time_of_day ?? "06:00")}"></label>` +
    `<label><input type="radio" name="when" value="manual"${row.time_of_day ? "" : " checked"}> ` +
    `Only when I ask</label>` +
    `<button type="submit">Change time</button></form>`
  );
}

/** The connections page's "Background jobs" section, for one user. */
export async function jobsSection(
  deps: ConnectDeps,
  userId: string,
  csrf: string,
): Promise<string> {
  const rows = (await listEnrollments(await deps.db(), userId)).filter(
    (r) => r.revoked_at_ms === null,
  );
  const heading = "<h2>Background jobs</h2>";
  if (rows.length === 0) return `${heading}<p>No app runs a background job for you.</p>`;
  return (
    heading +
    `<table><tr><th>App</th><th>Job</th><th>Schedule</th><th>Last run</th><th></th></tr>` +
    rows
      .map((row) => {
        const consent = `${CONNECT_JOB_ROUTE}?${new URLSearchParams({
          app: row.app_id,
          job: row.job,
          tz: row.time_zone,
        }).toString()}`;
        return (
          `<tr><td>${escapeMarkup(row.app_id)}</td><td><code>${escapeMarkup(row.job)}</code></td>` +
          `<td>${describeSchedule(row)}</td>` +
          `<td>${describeLastRun(row)}<br>${describeAttention(row, consent)}</td><td>` +
          scheduleForm(row, csrf) +
          `<form method="post" action="${escapeMarkup(jobRevokePath(row.id))}">` +
          `<input type="hidden" name="csrf" value="${escapeMarkup(csrf)}">` +
          `<button type="submit">Turn off</button></form></td></tr>`
        );
      })
      .join("") +
    `</table>`
  );
}

/**
 * `POST /connections/jobs/<id>/schedule` or `/revoke`, for the signed-in
 * owner `userId`. The caller checked the origin and the CSRF token.
 */
export async function jobAction(
  req: ConnectRequest,
  deps: ConnectDeps,
  userId: string,
  action: { enrollmentId: string; action: "revoke" | "schedule" },
): Promise<ConnectResponse> {
  const now = (deps.now ?? Date.now)();
  const db = await deps.db();
  if (action.action === "revoke") {
    const row = await revokeEnrollment(db, userId, action.enrollmentId, now);
    if (row) {
      deps.forgetDelegation(row.id);
      const key = await deps.signingKey();
      const refresh = key
        ? openRefreshToken(key.refreshKey, row.id, row.cognito_refresh_ciphertext)
        : null;
      if (refresh) await revokeAtCognito(deps, refresh);
    }
    return redirect(CONNECTIONS_ROUTE);
  }
  const form = Object.fromEntries(new URLSearchParams(req.body));
  const timeOfDay = form.when === "manual" ? null : form.time;
  if (
    timeOfDay !== null &&
    (typeof timeOfDay !== "string" || !TIME_OF_DAY_PATTERN.test(timeOfDay))
  ) {
    return message(deps, 400, "Pick a time of day, or choose to run the job only when you ask.");
  }
  const timeZone = zoneOrUtc(form.tz);
  const row = await findEnrollment(db, action.enrollmentId);
  if (!row || row.user_id !== userId) return redirect(CONNECTIONS_ROUTE);
  // A stopped job keeps no due time until the user turns it on again, so a
  // new time takes effect from then.
  const stopped = row.attention !== null && row.attention !== "failed";
  await setSchedule(
    db,
    userId,
    action.enrollmentId,
    {
      timeZone,
      timeOfDay,
      nextDueAtMs: timeOfDay && !stopped ? nextDueAt(timeZone, timeOfDay, now) : null,
    },
    now,
  );
  return redirect(CONNECTIONS_ROUTE);
}
