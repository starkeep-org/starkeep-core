/**
 * The browser side of a cloud journey.
 *
 * Exported rather than kept inside `journey.ts` for two reasons. An app's own
 * steps need the same sign-in and the same diagnostics, and copying either into
 * an app repository would let the two drift. More sharply: Playwright refuses to
 * be loaded twice in one process, and a consumer importing `@playwright/test`
 * out of its own `node_modules` while the harness imports it out of core's is
 * exactly that — so the harness owns the single instance and hands it out.
 */

import { chromium, type Browser, type Page } from "@playwright/test";

export { chromium, type Browser, type Page };

/**
 * Collect what a headless page saw, and return a reader for it.
 *
 * A browser failure in a cloud journey is the hardest kind to diagnose after the
 * fact: the page is gone, the stack may be torn down, and all that survives is a
 * locator timeout. Diagnostics wired to one specific failure are diagnostics
 * that are absent for every other one, which is how a thumbnail that never
 * rendered presented as a bare 120s timeout with nothing to say whether the
 * upload had even reached the network.
 */
export function watchPageProblems(page: Page): () => string {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on("requestfailed", (r) =>
    problems.push(`requestfailed: ${r.failure()?.errorText ?? "?"} ${r.url().slice(0, 120)}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`${r.status()} ${r.url().slice(0, 120)}`);
  });
  return (): string =>
    problems.length
      ? `\nWhat the browser saw:\n  ${[...new Set(problems)].join("\n  ")}`
      : "\nThe browser reported no console errors and no failed requests.";
}

export interface BrowserSignInOptions {
  page: Page;
  /** The app's URL on the browser-facing origin (the CloudFront distribution). */
  appUrl: string;
  email: string;
  password: string;
  /** Accessible name of the control that proves the app considers you signed in. */
  signedInControl: string;
  problemReport: () => string;
}

/**
 * Load a cloud-served app in a real browser, sign in on Cognito's managed login
 * page, and wait for the control that proves the app considers the caller
 * signed in.
 *
 * The gateway sends a signed-out document request to the app's own sign-in
 * page, whose "Sign in" button goes to the platform's `/auth/start`. That
 * redirects to the managed login page, which takes the password; the
 * platform's `/auth/callback` sets the app's cookies and returns the browser to
 * the app. The app's code never sees the password, which is the property this
 * step exercises end to end.
 *
 * The managed login page asks for the email and the password either on one
 * screen or on two, depending on the pool's sign-in settings, so each field is
 * waited for in turn and the page's primary button is pressed after each.
 */
export async function signInWithBrowser(options: BrowserSignInOptions): Promise<void> {
  const { page, appUrl, email, password, signedInControl, problemReport } = options;
  await page.goto(appUrl, { waitUntil: "load" });

  const startSignIn = page.getByRole("button", { name: "Sign in" });
  try {
    await startSignIn.waitFor({ state: "visible", timeout: 30_000 });
  } catch (err) {
    throw new Error(
      `the app's sign-in page showed no "Sign in" button. Landed on ${page.url()}.${problemReport()}`,
      { cause: err },
    );
  }
  await startSignIn.click();

  try {
    await page.waitForURL(/\.amazoncognito\.com\//, { timeout: 30_000 });
  } catch (err) {
    throw new Error(
      `"Sign in" did not reach the managed login page. Landed on ${page.url()}.${problemReport()}`,
      { cause: err },
    );
  }
  const emailField = page.locator('input[name="username"], input[type="email"]').first();
  const passwordField = page.locator('input[type="password"]').first();
  const submit = page.locator('button[type="submit"], input[type="submit"]').first();

  await emailField.waitFor({ state: "visible", timeout: 30_000 });
  await emailField.fill(email);
  if (!(await passwordField.isVisible())) {
    await submit.click();
    await passwordField.waitFor({ state: "visible", timeout: 30_000 });
  }
  await passwordField.fill(password);
  await submit.click();

  try {
    await page
      .getByRole("button", { name: signedInControl })
      .waitFor({ state: "visible", timeout: 120_000 });
  } catch (err) {
    throw new Error(
      `the app never showed "${signedInControl}" after the managed login page. ` +
        `Landed on ${page.url()}.${problemReport()}`,
      { cause: err },
    );
  }
}
