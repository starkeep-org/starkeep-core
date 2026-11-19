/**
 * A vault secret that rotates on every use passes Parameter Store's
 * 100-version limit, on real AWS.
 *
 * Parameter Store keeps a parameter's last 100 versions and deletes the
 * oldest on each write. A label on the oldest version would make that write
 * fail instead, so a secret its provider rotates on every refresh would stop
 * rotating after 100 runs. The vault never labels a version; this case writes
 * one secret 150 times through the vault module and reads the last value.
 *
 * It runs as the operator, under the deployment's prefix, at a path no app
 * can own (`_rotation-test`, which no app id may start with), and deletes the
 * secret afterwards. Writes are paced to Parameter Store's default
 * PutParameter rate, and a throttled write is retried.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { SSMClient } from "@aws-sdk/client-ssm";
import {
  deleteSecret,
  getSecret,
  putSecret,
  type VaultTarget,
} from "../../packages/admin-installer/builtin-apps/cloud-data-server/src/vault.js";
import { AWS_TESTS_ENABLED, REGION, STACK_PREFIX } from "./env.js";

/** Writes per second, under Parameter Store's default PutParameter rate. */
const WRITES_PER_SECOND = 3;
const WRITES = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function putWithRetry(t: VaultTarget, name: string, value: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await putSecret(t, name, value);
      return;
    } catch (err) {
      const throttled = /Throttl|TooManyUpdates|Rate exceeded/i.test(
        `${(err as Error)?.name} ${(err as Error)?.message}`,
      );
      if (!throttled || attempt >= 8) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
}

describe.skipIf(!AWS_TESTS_ENABLED)("the credential vault on real Parameter Store", () => {
  const target: VaultTarget = {
    ssm: new SSMClient({ region: REGION }),
    stackPrefix: STACK_PREFIX,
    appId: "_rotation-test",
    userId: randomBytes(6).toString("hex"),
  };
  const NAME = "rotating";

  afterAll(async () => {
    await deleteSecret(target, NAME);
  });

  it(`rotates one secret ${WRITES} times, past the 100-version limit`, async () => {
    for (let i = 1; i <= WRITES; i++) {
      const started = Date.now();
      await putWithRetry(target, NAME, `value-${i}`);
      const wait = 1000 / WRITES_PER_SECOND - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
    expect(await getSecret(target, NAME)).toBe(`value-${WRITES}`);
  });
});
