/**
 * Guard test for the SDK→IAM action mapping.
 *
 * Why: the SDK_TO_IAM_ACTION table renames a captured SDK operation to
 * its canonical IAM action so iam-simulate can find it in its data file.
 * If a future iam-data release removes or renames one of the target
 * actions, every install simulation silently flips to "Error:
 * invalid.action" for that call. This test catches that drift early.
 *
 * It also catches typos when someone adds a new mapping by hand —
 * which is the only way the table currently grows.
 */

import { describe, test, expect } from "vitest";
import { iamActionExists } from "@cloud-copilot/iam-data";
import { SDK_TO_IAM_ACTION } from "../src/parse-tf-trace";

describe("SDK_TO_IAM_ACTION", () => {
  for (const [sdkAction, iamAction] of Object.entries(SDK_TO_IAM_ACTION)) {
    test(`${sdkAction} → ${iamAction} exists in iam-data`, async () => {
      const [service, action] = iamAction.split(":");
      expect(service, `malformed iam action '${iamAction}'`).toBeTruthy();
      expect(action, `malformed iam action '${iamAction}'`).toBeTruthy();
      const exists = await iamActionExists(service!, action!);
      expect(exists, `${iamAction} not found in @cloud-copilot/iam-data`).toBe(true);
    });
  }
});
