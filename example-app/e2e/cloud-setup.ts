import { APP_ROOT, CLOUD_RUN_FILE, runCloudStep } from "./cloud-run-step";

/**
 * Prepare the cloud test stack for the spec: the cloud data server and this
 * app installed, and a fresh user signed in to the app. `STARKEEP_AWS_TESTS=1`
 * enables the run; without it the step writes a disabled run file and the
 * spec skips every step.
 *
 * The test stack's region and prefix come from the same variables as the
 * tier-3 journey (`e2e-aws/README.md`, "Environment contract").
 */
export default async function cloudSetup() {
  await runCloudStep([
    "prepare",
    "--app-dir",
    APP_ROOT,
    "--out",
    CLOUD_RUN_FILE,
    "--signed-in-control",
    "Sign out",
  ]);
  process.env.E2E_SURFACE = "cloud";
  process.env.E2E_CLOUD_RUN = CLOUD_RUN_FILE;
}
