// AI-684 driver, run by run.sh under tsx (admin-installer is source-only).
//
// 1. creates the program's inputs on the emulator (inputs.mjs);
// 2. runs admin-installer's real buildPulumiProgram via the Automation API
//    under several provider configurations, recording every declared
//    resource's outcome, and destroys after each;
// 3. deploys once more with the working configuration and invokes the routes;
// 4. deploys a one-line control handler through the same program and invokes it;
// 5. runs installComputeStack unchanged and records where it stops.
//
// Prints one JSON document on stdout for report.mjs.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetPolicyCommand,
  InvokeCommand,
  RemovePermissionCommand,
  waitUntilFunctionActiveV2,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { REGION, describeError, emulatorKeys, recorder, requireEmulatorEnv } from "./lib.mjs";
import { createInputs } from "./inputs.mjs";
import { declaredResources, destroy, loadInstaller, upAndClassify } from "./stack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const { endpoint, caFile, work } = requireEmulatorEnv();
const keys = emulatorKeys();
const passphrase = process.env.PULUMI_CONFIG_PASSPHRASE;
if (!passphrase) throw new Error("PULUMI_CONFIG_PASSPHRASE is not set; run through run.sh");
const pulumiRoot = process.env.SPIKE_PULUMI_ROOT; // contains bin/pulumi
const pulumiHome = process.env.SPIKE_PULUMI_HOME; // plugin cache
const secrets = [keys.accessKeyId, keys.secretAccessKey, passphrase];

const rec = recorder();
const result = { rows: rec.rows, variants: [], resources: [], invokes: [], install: {} };

// Every SDK client below is given its endpoint and keys explicitly, and the AWS
// variables are removed from this process's environment, so the Pulumi CLI
// child (which inherits process.env) sees only what each variant hands it.
const sdk = {
  region: REGION,
  endpoint,
  credentials: keys,
};
const ambient = {};
for (const k of Object.keys(process.env)) {
  if (k.startsWith("AWS_")) {
    ambient[k] = process.env[k];
    delete process.env[k];
  }
}
// An empty shared config and credentials file: the emulator's own `config`
// carries endpoint_url and ca_bundle, which would leak into every variant.
const emptyIni = join(work, "empty-aws-ini");
writeFileSync(emptyIni, "");

const { automation, program, computeStack, pulumiVersion, awsVersion, req } =
  await loadInstaller(ROOT);
const { validateManifest } = await import(
  pathToFileURL(req.resolve("@starkeep/admin-manifest")).href
);
result.versions = { pulumiSdk: pulumiVersion, pulumiAws: awsVersion };

const pulumiCommand = await automation.PulumiCommand.get({ root: pulumiRoot });
result.versions.pulumiCli = pulumiCommand.version?.toString?.() ?? "";

function loadManifest(path) {
  const v = validateManifest(JSON.parse(readFileSync(path, "utf8")));
  if (!v.valid) throw new Error(`manifest ${path} invalid: ${v.errors.join("; ")}`);
  return v.manifest;
}
const exampleManifest = loadManifest(join(ROOT, "example-app/starkeep.manifest.json"));
const controlManifest = loadManifest(join(HERE, "control/starkeep.manifest.json"));

const stackPrefix = "spk";
const bundles = {
  "example-app": readFileSync(process.env.SPIKE_EXAMPLE_ZIP),
  "control-app": readFileSync(process.env.SPIKE_CONTROL_ZIP),
};

// --- 1. inputs -------------------------------------------------------------------
// The SDK clients in inputs.mjs read the ambient environment, so put it back
// for this phase only.
Object.assign(process.env, ambient);
const inputs = await createInputs({
  rec,
  stackPrefix,
  appIds: Object.keys(bundles),
  bundles,
  tinyZip: bundles["control-app"],
});
for (const k of Object.keys(ambient)) delete process.env[k];
secrets.push(inputs.passphrase, inputs.idToken);
if (!inputs.apiGatewayId || !inputs.appExecRoleArn || !inputs.bundleHash["example-app"]) {
  console.log(JSON.stringify(result));
  process.exit(1);
}

// As orchestrator.ts builds it (orchestrator.ts:533-553).
function computeContext(appId) {
  return {
    stackPrefix,
    appId,
    appRoleArn: inputs.appRoleArn,
    appExecRoleArn: inputs.appExecRoleArn,
    apiGatewayId: inputs.apiGatewayId,
    apiGatewayExecutionArn: inputs.apiGatewayExecutionArn,
    apiGatewayUrl: inputs.apiGatewayUrl,
    authorizerId: inputs.authorizerId,
    ...(inputs.sessionAuthorizerId ? { sessionAuthorizerId: inputs.sessionAuthorizerId } : {}),
    region: REGION,
    accountId: inputs.accountId,
    pulumiStateBucket: inputs.pulumiStateBucket,
    artifactsBucket: inputs.artifactsBucket,
    dsqlHostname: inputs.dsqlHostname,
    filesBucket: inputs.filesBucket,
    infraCreds: { ...keys, sessionToken: undefined },
    bundleHash: inputs.bundleHash[appId],
  };
}

// --- 2. provider configurations ------------------------------------------------------
const SERVICES = ["lambda", "cloudwatchlogs", "apigatewayv2", "iam", "sts", "s3"];
const fullConfig = {
  "aws:region": { value: REGION },
  "aws:endpoints": {
    value: JSON.stringify([Object.fromEntries(SERVICES.map((s) => [s, endpoint]))]),
  },
  "aws:customCaBundle": { value: caFile },
  "aws:s3UsePathStyle": { value: "true" },
  "aws:skipCredentialsValidation": { value: "true" },
  "aws:skipRequestingAccountId": { value: "true" },
  "aws:skipMetadataApiCheck": { value: "true" },
  "aws:accessKey": { value: keys.accessKeyId, secret: true },
  "aws:secretKey": { value: keys.secretAccessKey, secret: true },
};
const FENCE = {
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1",
};
const BOUNDED = { "aws:maxRetries": { value: "1" } };
const without = (...drop) =>
  Object.fromEntries(Object.entries(fullConfig).filter(([k]) => !drop.includes(k)));
const baseEnv = (name) => ({
  PULUMI_BACKEND_URL: `file://${join(work, "state", name)}`,
  PULUMI_CONFIG_PASSPHRASE: passphrase,
  PULUMI_HOME: pulumiHome,
  PULUMI_SKIP_UPDATE_CHECK: "true",
  AWS_CONFIG_FILE: emptyIni,
  AWS_SHARED_CREDENTIALS_FILE: emptyIni,
  AWS_EC2_METADATA_DISABLED: "true",
  // Egress fence: anything not addressed to 127.0.0.1 goes to a dead proxy, so
  // a variant whose provider ignores the emulator endpoint fails fast and never
  // reaches a real AWS host. The aws provider plugin is installed beforehand.
  ...FENCE,
});

const variants = [
  {
    name: "full",
    label: "every setting the issue lists, as stack config",
    config: fullConfig,
    env: {},
  },
  {
    name: "env-endpoint-only",
    label: "aws:region only; AWS_ENDPOINT_URL + AWS_CA_BUNDLE + key pair in the environment",
    config: { "aws:region": { value: REGION } },
    env: {
      AWS_ENDPOINT_URL: endpoint,
      AWS_CA_BUNDLE: caFile,
      AWS_ACCESS_KEY_ID: keys.accessKeyId,
      AWS_SECRET_ACCESS_KEY: keys.secretAccessKey,
    },
  },
  {
    name: "env-endpoint-no-ca",
    label: "as env-endpoint-only, without AWS_CA_BUNDLE",
    config: { "aws:region": { value: REGION } },
    env: {
      AWS_ENDPOINT_URL: endpoint,
      AWS_ACCESS_KEY_ID: keys.accessKeyId,
      AWS_SECRET_ACCESS_KEY: keys.secretAccessKey,
    },
  },
  {
    name: "s3-backend",
    label:
      "full, state in the emulator's S3: PULUMI_BACKEND_URL=s3://<bucket>?endpoint=…&s3ForcePathStyle=true&region=us-east-1, AWS_CA_BUNDLE and the key pair in the environment (the backend does not read stack config)",
    config: fullConfig,
    env: {
      PULUMI_BACKEND_URL: `s3://${inputs.pulumiStateBucket}?endpoint=${endpoint}&s3ForcePathStyle=true&region=${REGION}`,
      AWS_CA_BUNDLE: caFile,
      AWS_ACCESS_KEY_ID: keys.accessKeyId,
      AWS_SECRET_ACCESS_KEY: keys.secretAccessKey,
    },
  },
  {
    name: "no-ca-bundle",
    label: "full minus aws:customCaBundle",
    config: without("aws:customCaBundle"),
    env: {},
  },
  ...["skipCredentialsValidation", "skipRequestingAccountId", "skipMetadataApiCheck"].map((f) => ({
    name: `no-${f}`,
    label: `full minus aws:${f}`,
    config: without(`aws:${f}`),
    env: {},
  })),
  {
    name: "no-s3-path-style",
    label: "full minus aws:s3UsePathStyle",
    config: without("aws:s3UsePathStyle"),
    env: {},
  },
  {
    name: "four-endpoints",
    label:
      "full, aws:endpoints with lambda, cloudwatchlogs, apigatewayv2, sts only (no iam, no s3)",
    config: {
      ...fullConfig,
      "aws:endpoints": {
        value: JSON.stringify([
          Object.fromEntries(
            ["lambda", "cloudwatchlogs", "apigatewayv2", "sts"].map((s) => [s, endpoint]),
          ),
        ]),
      },
    },
    env: {},
  },
];

const exampleDeclared = declaredResources(exampleManifest, program);
const only = process.env.SPIKE_VARIANTS?.split(",");
for (const v of variants) {
  if (only && !only.includes(v.name)) continue;
  mkdirSync(join(work, "state", v.name), { recursive: true });
  const r = await upAndClassify({
    automation,
    stackName: `${stackPrefix}-app-example-app-${v.name}`,
    projectName: `${stackPrefix}-apps`,
    program: program.buildPulumiProgram(exampleManifest, computeContext("example-app")),
    declared: exampleDeclared,
    // Bounded retries for the ablations, so a configuration that cannot reach
    // the emulator fails in seconds rather than retrying for minutes.
    config: v.name === "full" ? v.config : { ...v.config, ...BOUNDED },
    envVars: { ...baseEnv(v.name), ...v.env },
    pulumiCommand,
    workDir: undefined,
    secrets,
  });
  const counts = countOutcomes(r.outcomes);
  const destroyed = await destroy(r.stack, {
    config: { ...fullConfig, ...BOUNDED },
    stateDir: join(work, "state", v.name),
  });
  result.variants.push({
    name: v.name,
    label: v.label,
    configKeys: Object.keys(v.config).join(", "),
    envKeys: Object.keys(v.env).join(", "),
    ok: r.ok,
    timedOut: r.timedOut,
    counts,
    seconds: r.seconds,
    error: r.error,
    destroyed,
  });
  if (v.name === "full") result.resources = r.outcomes;
}

// --- 3 and 4. deploy with the full config and invoke; then the control handler -----
const invokeLambda = new LambdaClient(sdk);
const logs = new CloudWatchLogsClient(sdk);

async function deployAndKeep(appId, manifest, name) {
  mkdirSync(join(work, "state", name), { recursive: true });
  return upAndClassify({
    automation,
    stackName: `${stackPrefix}-app-${appId}`,
    projectName: `${stackPrefix}-apps`,
    program: program.buildPulumiProgram(manifest, computeContext(appId)),
    declared: declaredResources(manifest, program),
    config: fullConfig,
    envVars: baseEnv(name),
    pulumiCommand,
    workDir: undefined,
    secrets,
  });
}

async function httpCall(label, method, path, headers = {}, body) {
  const url = `${inputs.apiGatewayUrl}${path}`;
  const start = performance.now();
  try {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    result.invokes.push({
      label,
      request: `${method} ${path}`,
      status: res.status,
      ms: Math.round(performance.now() - start),
      body: text.slice(0, 700),
      headers: res.headers.get("content-type") ?? "",
    });
  } catch (err) {
    result.invokes.push({
      label,
      request: `${method} ${path}`,
      status: "error",
      body: describeError(err),
    });
  }
}

async function directInvoke(label, fnName, payload) {
  try {
    const r = await invokeLambda.send(
      new InvokeCommand({
        FunctionName: fnName,
        Payload: Buffer.from(JSON.stringify(payload)),
        LogType: "Tail",
      }),
    );
    const out = r.Payload ? Buffer.from(r.Payload).toString() : "";
    const tail = r.LogResult ? Buffer.from(r.LogResult, "base64").toString() : "";
    result.invokes.push({
      label,
      request: `lambda:Invoke ${fnName}`,
      status: `${r.StatusCode}${r.FunctionError ? ` FunctionError=${r.FunctionError}` : ""}`,
      body: out.slice(0, 900),
      log: tail.slice(-1500),
    });
  } catch (err) {
    result.invokes.push({
      label,
      request: `lambda:Invoke ${fnName}`,
      status: "error",
      body: describeError(err),
    });
  }
}

async function logEvents(fnName) {
  try {
    const group = `/aws/lambda/${fnName}`;
    const streams = await logs.send(new DescribeLogStreamsCommand({ logGroupName: group }));
    const lines = [];
    for (const s of streams.logStreams ?? []) {
      const ev = await logs.send(
        new GetLogEventsCommand({ logGroupName: group, logStreamName: s.logStreamName }),
      );
      for (const e of ev.events ?? []) lines.push(e.message.trim());
    }
    return lines.length ? lines.join("\n").slice(-2500) : "(log group has no events)";
  } catch (err) {
    return `logs unreadable: ${describeError(err)}`;
  }
}

const sample = (method, rawPath, extra = {}) => ({
  version: "2.0",
  routeKey: `${method} ${rawPath}`,
  rawPath,
  rawQueryString: "",
  headers: { host: "127.0.0.1", "content-type": "application/json" },
  requestContext: {
    http: {
      method,
      path: rawPath,
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "spike",
    },
    requestId: "spike",
    stage: "$default",
  },
  isBase64Encoded: false,
  ...extra,
});

const deployed = await deployAndKeep("example-app", exampleManifest, "invoke-example");
result.deployForInvoke = {
  ok: deployed.ok,
  counts: countOutcomes(deployed.outcomes),
  error: deployed.error,
};
if (deployed.ok || deployed.outcomes.some((o) => o.outcome === "created")) {
  await httpCall("example-app public route", "GET", "/apps/example-app/");
  await httpCall("example-app public route, no trailing slash", "GET", "/apps/example-app");
  await httpCall(
    "example-app JWT route",
    "POST",
    "/apps/example-app/api/echo",
    { Authorization: `Bearer ${inputs.idToken}`, "content-type": "application/json" },
    JSON.stringify({ hello: "emulator" }),
  );
  await httpCall(
    "example-app JWT route, no token (authorizer must refuse)",
    "POST",
    "/apps/example-app/api/echo",
    { "content-type": "application/json" },
    "{}",
  );
  await directInvoke(
    "static handler, direct Invoke",
    `${stackPrefix}-app-example-app-static`,
    sample("GET", "/apps/example-app/"),
  );
  await directInvoke(
    "api handler, direct Invoke",
    `${stackPrefix}-app-example-app-api`,
    sample("POST", "/apps/example-app/api/echo", { body: "{}" }),
  );
  result.logs = {
    static: await logEvents(`${stackPrefix}-app-example-app-static`),
    api: await logEvents(`${stackPrefix}-app-example-app-api`),
  };
}

// The bundle without its first two lines (esbuild's `node:module` banner,
// example-app/web/scripts/bundle.mjs:66), created directly through the Lambda
// API: what INIT fails on once the first import is out of the way.
if (process.env.SPIKE_PROBE_ZIP) {
  const probeZip = readFileSync(process.env.SPIKE_PROBE_ZIP);
  for (const h of ["index", "api"]) {
    const name = `${stackPrefix}-probe-nobanner-${h}`;
    try {
      await invokeLambda.send(
        new CreateFunctionCommand({
          FunctionName: name,
          Runtime: "nodejs22.x",
          Role: inputs.appExecRoleArn,
          Handler: `${h}.handler`,
          Code: { ZipFile: probeZip },
          Timeout: 10,
        }),
      );
      // Created directly, the function starts Pending, as on AWS.
      await waitUntilFunctionActiveV2(
        { client: invokeLambda, maxWaitTime: 60 },
        { FunctionName: name },
      );
      await directInvoke(
        `probe: ${h}.mjs without the node:module banner, direct Invoke`,
        name,
        sample("GET", "/apps/example-app/"),
      );
      await invokeLambda.send(new DeleteFunctionCommand({ FunctionName: name }));
    } catch (err) {
      result.invokes.push({
        label: `probe ${h}`,
        request: `CreateFunction ${name}`,
        status: "error",
        body: describeError(err),
      });
    }
  }
}
result.bundleImports = process.env.SPIKE_BUNDLE_IMPORTS ?? "";

const control = await deployAndKeep("control-app", controlManifest, "invoke-control");
result.control = {
  ok: control.ok,
  counts: countOutcomes(control.outcomes),
  outcomes: control.outcomes,
  error: control.error,
};
if (control.ok || control.outcomes.some((o) => o.outcome === "created")) {
  await httpCall("control handler public route", "GET", "/apps/control-app/hello");
  await httpCall(
    "control JWT route, emulator ID token",
    "POST",
    "/apps/control-app/echo",
    { Authorization: `Bearer ${inputs.idToken}`, "content-type": "application/json" },
    "{}",
  );
  await httpCall("control JWT route, no token", "POST", "/apps/control-app/echo", {}, "{}");
  await directInvoke(
    "control handler, direct Invoke",
    `${stackPrefix}-app-control-app-hello`,
    sample("GET", "/apps/control-app/hello"),
  );
  // Would CI catch a missing aws.lambda.Permission? On AWS the gateway gets 403
  // from Lambda without it (pulumi-program.ts, above the Permission).
  const fnName = `${stackPrefix}-app-control-app-hello`;
  await rec.step(
    "control",
    "lambda:RemovePermission (the program's invoke-hello statement)",
    async () => {
      const policy = JSON.parse(
        (await invokeLambda.send(new GetPolicyCommand({ FunctionName: fnName }))).Policy,
      );
      const sids = policy.Statement.map((st) => st.Sid);
      for (const sid of sids) {
        await invokeLambda.send(
          new RemovePermissionCommand({ FunctionName: fnName, StatementId: sid }),
        );
      }
      return { detail: `removed ${sids.join(", ")}` };
    },
  );
  await httpCall(
    "control route after RemovePermission (AWS: 500, Lambda refuses the gateway)",
    "GET",
    "/apps/control-app/hello",
  );
}
await destroy(deployed.stack);
await destroy(control.stack);

// --- 5. installComputeStack, unchanged ----------------------------------------------
// The installer's own SDK calls (SSM passphrase, S3 probes) take their endpoint
// from the ambient environment, as they would in any seam-free test; the
// Pulumi CLI child inherits it too. HOME is redirected by run.sh so
// ensurePulumiCli's download lands in the spike's work directory.
//
// ensurePulumiCli (compute-stack.ts:38) runs PulumiCommand.get on
// ~/.starkeep/pulumi and, when that fails, PulumiCommand.install into it. The
// same install is done here first, timed, before the egress fence goes up:
// the fence would otherwise block the download along with everything else.
const cliRoot = join(process.env.HOME, ".starkeep", "pulumi");
await rec.step(
  "installComputeStack",
  `ensurePulumiCli: PulumiCommand.install into ${cliRoot}`,
  async () => {
    let found = "";
    try {
      found = (await automation.PulumiCommand.get({ root: cliRoot })).version?.toString() ?? "";
    } catch {
      const cmd = await automation.PulumiCommand.install({ root: cliRoot });
      return { detail: `not present, downloaded v${cmd.version} (the SDK's own version)` };
    }
    return { outcome: "differs", detail: `already present (v${found}); HOME was not fresh` };
  },
);
Object.assign(process.env, ambient, FENCE, {
  PULUMI_HOME: pulumiHome,
  PULUMI_SKIP_UPDATE_CHECK: "true",
});
delete process.env.PULUMI_CONFIG_PASSPHRASE;
const t0 = performance.now();
const logLines = [];
const origLog = console.log;
console.log = (...a) => logLines.push(a.join(" "));
try {
  const receipt = await computeStack.installComputeStack(
    exampleManifest,
    computeContext("example-app"),
  );
  result.install = { outcome: "completed", detail: JSON.stringify(receipt) };
} catch (err) {
  const text = String(err?.commandResult?.stderr || err?.message || err);
  result.install = {
    outcome: "stopped",
    detail: text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 12)
      .join(" | "),
  };
}
console.log = origLog;
result.install.seconds = ((performance.now() - t0) / 1000).toFixed(1);
result.install.log = logLines.slice(-15).join("\n");

let out = JSON.stringify(result);
for (const s of secrets) out = out.split(s).join("<redacted>");
console.log(out);

function countOutcomes(outcomes) {
  const c = { created: 0, failed: 0, skipped: 0 };
  for (const o of outcomes) c[o.outcome] += 1;
  return c;
}
