// AI-734: drive the real SSM Parameter Store readers and writers against a
// running AWS Emulator, and record every operation's outcome.
//
// Runs under tsx, not plain Node: packages/admin-installer is source-only (its
// package.json `exports` point at .ts files and it has no build), and
// packages/app-client/src/credentials.ts imports "./paths" without an extension.
// Both are imported here by relative path, so their @aws-sdk/client-ssm resolves
// from their own node_modules: the SDK copy whose ParameterNotFound and
// ParameterAlreadyExists classes their `instanceof` branches compare against.
//
// - app-creds.ts takes explicit `awsCreds`: the emulator's generated key pair.
// - pulumi-passphrase.ts and credentials.ts use the default chain: the
//   emulator's credentials file, through AWS_SHARED_CREDENTIALS_FILE.
//
// The spike's own @aws-sdk/client-ssm records the emulator's exact error class
// and message for the cases the readers swallow, and reads back what the
// writers do not return (tags, type, value). It never stands in for a reader.
//
// Prints one JSON document on stdout for report.mjs. Secret values are never
// printed: only their shape.

import { randomBytes } from "node:crypto";
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
  ListTagsForResourceCommand,
  ParameterNotFound,
  ParameterAlreadyExists,
} from "@aws-sdk/client-ssm";
import {
  ensureAppCredsParameter,
  getAppCredsParameter,
  deleteAppCredsParameter,
  getDeploymentSettingsParameter,
  putDeploymentSettingsParameter,
  changeDeploymentSettingsParameter,
  putCloudFrontSigningParameter,
  appCredsParameterName,
  cloudFrontSigningParameterName,
} from "../../../packages/admin-installer/src/app-creds.ts";
import { ensurePulumiPassphrase } from "../../../packages/admin-installer/src/pulumi-passphrase.ts";
import {
  loadAppCredentials,
  clearAppCredentialsCache,
} from "../../../packages/app-client/src/credentials.ts";
import { guardEnvironment, emulatorCredentials, describeError, Recorder } from "./lib.mjs";

const endpoint = guardEnvironment();
const region = "us-east-1";
const awsCreds = emulatorCredentials();
const stackPrefix = `spike-${randomBytes(3).toString("hex")}`;
const appId = "spike-photos";
const rec = new Recorder("ssm");
const probe = new SSMClient({ endpoint, region });

const expectEqual = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return a === e ? null : `${label}: got ${a}, AWS gives ${e}`;
};
const isHex64 = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const redactCreds = (c) =>
  c === null
    ? "null"
    : JSON.stringify({ ...c, hmacSecret: isHex64(c.hmacSecret) ? "<64 hex chars>" : "<other>" });
const base = { stackPrefix, region, awsCreds };

try {
  // ---- app-creds: create, read, the cloud-mode loader, delete --------------------
  await rec.op(
    "ensureAppCredsParameter (new)",
    () => ensureAppCredsParameter({ ...base, appId }),
    (r) => expectEqual("created", r, true),
  );
  await rec.op(
    "ensureAppCredsParameter (exists: ParameterAlreadyExists branch)",
    () => ensureAppCredsParameter({ ...base, appId }),
    (r) => expectEqual("created", r, false),
  );
  await rec.op(
    "read-back: type and tags of the app-creds parameter (spike client)",
    async () => {
      const name = appCredsParameterName(stackPrefix, appId);
      const got = await probe.send(new GetParameterCommand({ Name: name }));
      const tags = await probe.send(
        new ListTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: name }),
      );
      return {
        type: got.Parameter?.Type,
        // Without WithDecryption AWS returns the ciphertext, never the JSON.
        plaintextWithoutDecryption: (got.Parameter?.Value ?? "").startsWith("{"),
        tags: Object.fromEntries((tags.TagList ?? []).map((t) => [t.Key, t.Value])),
      };
    },
    (r) =>
      expectEqual("parameter", r, {
        type: "SecureString",
        plaintextWithoutDecryption: false,
        tags: { "starkeep:appId": appId, "starkeep:managed": "true" },
      }),
  );
  const stored = await rec.op(
    "getAppCredsParameter",
    () => getAppCredsParameter({ ...base, appId }),
    (r) => (r?.appId === appId && isHex64(r.hmacSecret) ? null : `got ${redactCreds(r)}`),
    redactCreds,
  );
  await rec.op(
    "getAppCredsParameter (missing: ParameterNotFound branch)",
    () => getAppCredsParameter({ ...base, appId: "spike-absent" }),
    (r) => expectEqual("result", r, null),
  );

  const cloudBase = "https://cloud.spike.invalid/";
  process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
  process.env.STARKEEP_CLOUD_DATA_BASE = cloudBase;
  process.env.STARKEEP_APP_CREDS_PARAMETER_NAME = appCredsParameterName(stackPrefix, appId);
  await rec.op(
    "loadAppCredentials (cloud mode, parameter present)",
    () => loadAppCredentials(appId),
    (r) =>
      r?.hmacSecret === stored?.hmacSecret
        ? expectEqual("dataServerUrl", r.dataServerUrl, `https://cloud.spike.invalid/apps/${appId}`)
        : `got ${redactCreds(r)}, not the stored secret`,
    redactCreds,
  );
  process.env.STARKEEP_APP_CREDS_PARAMETER_NAME = appCredsParameterName(
    stackPrefix,
    "spike-absent",
  );
  clearAppCredentialsCache();
  await rec.op(
    "loadAppCredentials (cloud mode, parameter missing: must be null)",
    () => loadAppCredentials("spike-absent"),
    (r) => expectEqual("result", r, null),
  );

  await rec.op("deleteAppCredsParameter", () => deleteAppCredsParameter({ ...base, appId }));
  await rec.op(
    "getAppCredsParameter (after delete)",
    () => getAppCredsParameter({ ...base, appId }),
    (r) => expectEqual("result", r, null),
  );
  await rec.op("deleteAppCredsParameter (missing: ParameterNotFound swallowed)", () =>
    deleteAppCredsParameter({ ...base, appId }),
  );

  // ---- deployment settings ----------------------------------------------------------
  const seeded = { trash: { retentionDays: 30 } };
  await rec.op(
    "getDeploymentSettingsParameter (absent)",
    () => getDeploymentSettingsParameter(base),
    (r) => expectEqual("result", r, null),
  );
  await rec.op(
    "putDeploymentSettingsParameter (onlyIfAbsent, absent)",
    () =>
      putDeploymentSettingsParameter({
        ...base,
        document: JSON.stringify(seeded),
        onlyIfAbsent: true,
      }),
    (r) => expectEqual("wrote", r, true),
  );
  await rec.op(
    "putDeploymentSettingsParameter (onlyIfAbsent, present)",
    () =>
      putDeploymentSettingsParameter({
        ...base,
        document: JSON.stringify({ trash: { retentionDays: 99 } }),
        onlyIfAbsent: true,
      }),
    (r) => expectEqual("wrote", r, false),
  );
  await rec.op(
    "getDeploymentSettingsParameter (present)",
    () => getDeploymentSettingsParameter(base),
    (r) => expectEqual("document", r, seeded),
  );
  await rec.op(
    "changeDeploymentSettingsParameter",
    async () => ({
      change: await changeDeploymentSettingsParameter({
        ...base,
        change: { trash: { retentionDays: 14 } },
      }),
      after: await getDeploymentSettingsParameter(base),
    }),
    (r) =>
      expectEqual("change", r, {
        change: { ok: true, settings: { trash: { retentionDays: 14 } } },
        after: { trash: { retentionDays: 14 } },
      }),
  );

  // ---- CloudFront signing parameter: create, then the overwrite branch -----------
  // The "private key" is a placeholder string: no key material is generated or stored.
  const signing = (domain) => ({
    ...base,
    keyPairId: "K-SPIKE-PLACEHOLDER",
    domain,
    hosts: [domain],
    privateKey: "placeholder, not a key",
  });
  const readSigning = async () => {
    const got = await probe.send(
      new GetParameterCommand({
        Name: cloudFrontSigningParameterName(stackPrefix),
        WithDecryption: true,
      }),
    );
    return { type: got.Parameter?.Type, domain: JSON.parse(got.Parameter?.Value ?? "{}").domain };
  };
  await rec.op(
    "putCloudFrontSigningParameter (create with tags)",
    async () => ({
      name: await putCloudFrontSigningParameter(signing("a.spike.invalid")),
      stored: await readSigning(),
    }),
    (r) =>
      expectEqual("result", r, {
        name: cloudFrontSigningParameterName(stackPrefix),
        stored: { type: "SecureString", domain: "a.spike.invalid" },
      }),
  );
  await rec.op(
    "putCloudFrontSigningParameter (exists: overwrite branch)",
    async () => ({
      name: await putCloudFrontSigningParameter(signing("b.spike.invalid")),
      stored: await readSigning(),
    }),
    (r) =>
      expectEqual("result", r, {
        name: cloudFrontSigningParameterName(stackPrefix),
        stored: { type: "SecureString", domain: "b.spike.invalid" },
      }),
  );

  // ---- Pulumi passphrase (default credential chain) ------------------------------
  await rec.op(
    "ensurePulumiPassphrase (first)",
    () => ensurePulumiPassphrase({ stackPrefix, region }),
    (r) => expectEqual("result", r, "created"),
  );
  await rec.op(
    "ensurePulumiPassphrase (second)",
    () => ensurePulumiPassphrase({ stackPrefix, region }),
    (r) => expectEqual("result", r, "already-exists"),
  );

  // ---- the emulator's error classes, as the SDK surfaces them ---------------------
  // The readers above swallow these, so their exact wording is recorded here.
  async function errorOf(op, fn, expectedClass, awsSays) {
    return rec.op(
      op,
      async () => {
        try {
          await fn();
          return { thrown: false };
        } catch (err) {
          return {
            thrown: true,
            error: describeError(err),
            instanceOf: expectedClass ? err instanceof expectedClass : null,
          };
        }
      },
      (r) =>
        !r.thrown
          ? `no error; AWS answers ${awsSays}`
          : r.instanceOf === false
            ? `not instanceof ${expectedClass.name}: ${r.error}`
            : null,
      (r) => `${r.error}${r.instanceOf ? ` (instanceof ${expectedClass.name})` : ""}`,
    );
  }
  const missingName = `/${stackPrefix}/app-creds/spike-never`;
  await errorOf(
    "error class: GetParameter on a missing name",
    () => probe.send(new GetParameterCommand({ Name: missingName })),
    ParameterNotFound,
    "400 ParameterNotFound",
  );
  await errorOf(
    "error class: DeleteParameter on a missing name",
    () => probe.send(new DeleteParameterCommand({ Name: missingName })),
    ParameterNotFound,
    "400 ParameterNotFound",
  );
  await errorOf(
    "error class: PutParameter without Overwrite on an existing name",
    () =>
      probe.send(
        new PutParameterCommand({
          Name: `/${stackPrefix}/pulumi/passphrase`,
          Type: "SecureString",
          Value: "x",
        }),
      ),
    ParameterAlreadyExists,
    "400 ParameterAlreadyExists",
  );
  await errorOf(
    "PutParameter with Tags and Overwrite together",
    () =>
      probe.send(
        new PutParameterCommand({
          Name: `/${stackPrefix}/pulumi/passphrase`,
          Type: "SecureString",
          Value: "x",
          Overwrite: true,
          Tags: [{ Key: "k", Value: "v" }],
        }),
      ),
    null,
    "400 ValidationException (tags and overwrite can't be used together)",
  );
} catch (err) {
  rec.aborted(err);
} finally {
  rec.emit({ stackPrefix, endpoint });
}
