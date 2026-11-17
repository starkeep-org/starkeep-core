import type { FullResult, Reporter } from "@playwright/test/reporter";
import { CLOUD_RUN_FILE, runCloudStep } from "./cloud-run-step";

/**
 * Close the cloud run once the suite's outcome is known. A reporter, because
 * a global teardown never learns whether the tests passed. A passing run
 * deletes its user and tears the stack down as `STARKEEP_AWS_TEARDOWN` says;
 * a failing run leaves everything up for debugging.
 */
export default class CloudFinishReporter implements Reporter {
  async onEnd(result: FullResult): Promise<void> {
    await runCloudStep([
      "finish",
      "--out",
      CLOUD_RUN_FILE,
      result.status === "passed" ? "--passed" : "--failed",
    ]);
  }

  printsToStdio(): boolean {
    return false;
  }
}
