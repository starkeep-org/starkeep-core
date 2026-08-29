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
 * Load a cloud-served app in a real browser, sign in through Cognito, and wait
 * for the control that proves the app considers the caller signed in.
 *
 * The form is the platform's — `createSessionRoutes` serves it and Cognito
 * answers it — so this drives it directly and asks the caller only which control
 * appears afterwards.
 *
 * `load`, not `domcontentloaded`. The sign-in form is server-rendered, so its
 * fields exist in the initial HTML and can be filled before a framework has
 * hydrated — and that desync is permanent, not a race that settles: the
 * framework attaches with its own empty state, the DOM keeps the typed text, and
 * the submit button stays disabled forever because it enables on state.
 * Re-filling does not recover it. Measured against this deployment, `load` and
 * `networkidle` both hydrate reliably before the first fill and
 * `domcontentloaded` reliably does not.
 *
 * The gateway sends a signed-out document request to the app's own sign-in page,
 * so this lands on /sign-in and drives the real form with the
 * permanent-password admin user.
 */
export async function signInWithBrowser(options: BrowserSignInOptions): Promise<void> {
  const { page, appUrl, email, password, signedInControl, problemReport } = options;
  await page.goto(appUrl, { waitUntil: "load" });

  const emailField = page.locator('input[type="email"]');
  const passwordField = page.locator('input[type="password"]');
  const signIn = page.getByRole("button", { name: "Sign in" });
  // Filled once and then waited on. Re-filling is not a recovery: if the first
  // fill landed before hydration, every later one lands on a framework that has
  // already decided the field is empty. The failure mode is a 30s click timeout
  // on a page that looks correct in a screenshot.
  await emailField.fill(email);
  await passwordField.fill(password);
  const deadline = Date.now() + 30_000;
  let interactive = false;
  while (Date.now() < deadline) {
    if (await signIn.isEnabled()) {
      interactive = true;
      break;
    }
    await page.waitForTimeout(200);
  }
  if (!interactive) {
    throw new Error(
      "sign-in form never became interactive: the submit button stayed disabled " +
        `for 30s after filling both fields. Landed on ${page.url()}; ` +
        `email field holds ${JSON.stringify(await emailField.inputValue())}.` +
        problemReport(),
    );
  }
  await signIn.click();
  await page
    .getByRole("button", { name: signedInControl })
    .waitFor({ state: "visible", timeout: 120_000 });
}
