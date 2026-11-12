// Runs admin-installer's buildPulumiProgram through the Automation API with a
// given provider configuration, and turns the engine's event stream into one
// outcome per declared resource: created / failed (with the emulator's error) /
// skipped (declared, never attempted).

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadInstaller(root) {
  const installerDir = join(root, "packages/admin-installer");
  const req = createRequire(join(installerDir, "package.json"));
  // The Automation API must be the same @pulumi/pulumi copy the program
  // registers resources with, so resolve it from admin-installer.
  const automation = await import(
    pathToFileURL(req.resolve("@pulumi/pulumi/automation/index.js")).href
  );
  const program = await import(pathToFileURL(join(installerDir, "src/pulumi-program.ts")).href);
  const computeStack = await import(pathToFileURL(join(installerDir, "src/compute-stack.ts")).href);
  const pulumiVersion = req("@pulumi/pulumi/package.json").version;
  const awsVersion = req("@pulumi/aws/package.json").version;
  return { automation, program, computeStack, pulumiVersion, awsVersion, req };
}

/** The resources buildPulumiProgram declares for a manifest, in program order. */
export function declaredResources(manifest, program) {
  const out = [];
  const routes = [...program.plannedRouteResourceNames(manifest)];
  for (const h of manifest.infraRequirements.compute.handlers) {
    out.push({ type: "aws:cloudwatch/logGroup:LogGroup", name: `logGroup-${h.name}` });
    out.push({ type: "aws:lambda/function:Function", name: `fn-${h.name}` });
    out.push({ type: "aws:lambda/permission:Permission", name: `invoke-${h.name}` });
    out.push({ type: "aws:apigatewayv2/integration:Integration", name: `integration-${h.name}` });
    for (const r of routes.filter((n) => n.startsWith(`route-${h.name}-`))) {
      out.push({ type: "aws:apigatewayv2/route:Route", name: r });
    }
  }
  return out;
}

const nameOf = (urn) => urn.split("::").pop();

/**
 * `pulumi up` the program, then classify every declared resource.
 * Returns { ok, error, outcomes: [{type,name,outcome,detail,id}], outputs, seconds }.
 */
export async function upAndClassify({
  automation,
  stackName,
  projectName,
  program,
  declared,
  config,
  envVars,
  pulumiCommand,
  workDir,
  secrets,
  timeoutMs = 180_000,
}) {
  const t0 = performance.now();
  const stack = await automation.LocalWorkspace.createOrSelectStack(
    { stackName, projectName, program },
    {
      pulumiCommand,
      workDir,
      envVars,
      projectSettings: {
        name: projectName,
        runtime: "nodejs",
        backend: { url: envVars.PULUMI_BACKEND_URL },
      },
    },
  );
  await stack.setAllConfig(config);

  const created = new Map();
  const failed = new Map();
  const attempted = new Set();
  const diags = new Map();
  let lastNote = "";
  // The engine's own error diagnostics carry the provider's full message
  // (the CLI's stderr shortens it).
  const errorDiags = [];
  const onEvent = (e) => {
    if (e.resourcePreEvent) attempted.add(e.resourcePreEvent.metadata.urn);
    if (e.resOutputsEvent) {
      const m = e.resOutputsEvent.metadata;
      if (m.op === "create" || m.op === "same" || m.op === "update") {
        created.set(m.urn, m.new?.outputs?.id ?? m.new?.id ?? "");
      }
    }
    if (e.resOpFailedEvent) failed.set(e.resOpFailedEvent.metadata.urn, "");
    if (e.diagnosticEvent && e.diagnosticEvent.severity !== "error") {
      lastNote = e.diagnosticEvent.message.replace(/\s+/g, " ").trim();
    }
    if (e.diagnosticEvent && e.diagnosticEvent.severity === "error") {
      errorDiags.push(e.diagnosticEvent.message.replace(/\s+/g, " ").trim());
    }
    if (e.diagnosticEvent && e.diagnosticEvent.urn && e.diagnosticEvent.severity === "error") {
      const msg = e.diagnosticEvent.message.replace(/\s+/g, " ").trim();
      diags.set(
        e.diagnosticEvent.urn,
        [diags.get(e.diagnosticEvent.urn), msg].filter(Boolean).join(" | "),
      );
    }
  };

  let result;
  let error;
  try {
    // continueOnError: keep creating independent resources after one fails, so
    // every declared resource gets an outcome. The installer does not pass it.
    // signal: a configuration the provider cannot use can retry for many
    // minutes; abort it and record that instead.
    result = await stack.up({
      onEvent,
      continueOnError: true,
      color: "never",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    error = err;
  }
  const timedOut = Boolean(error) && performance.now() - t0 >= timeoutMs - 1000;

  const outcomes = declared.map((d) => {
    const urn = [...attempted, ...created.keys(), ...failed.keys(), ...diags.keys()].find(
      (u) => nameOf(u) === d.name && u.includes(d.type),
    );
    if (urn && created.has(urn))
      return { ...d, outcome: "created", detail: `id ${created.get(urn)}` };
    if (urn && (failed.has(urn) || diags.has(urn))) {
      return { ...d, outcome: "failed", detail: shortError(diags.get(urn) ?? "failed", secrets) };
    }
    if (urn && timedOut) {
      return {
        ...d,
        outcome: "failed",
        detail: `still in progress when aborted after ${timeoutMs / 1000} s`,
      };
    }
    return {
      ...d,
      outcome: "skipped",
      detail: urn ? "registered, never completed" : "never attempted",
    };
  });

  const outputs = {};
  for (const [k, v] of Object.entries(result?.outputs ?? {})) outputs[k] = v.value;
  return {
    ok: !error,
    error: error
      ? shortError(
          timedOut
            ? `aborted after ${timeoutMs / 1000} s; last engine message: ${lastNote || "(none)"}`
            : errorDiags.length
              ? [...new Set(errorDiags)].join(" | ")
              : errorText(error),
          secrets,
        )
      : "",
    timedOut,
    outcomes,
    outputs,
    seconds: ((performance.now() - t0) / 1000).toFixed(1),
    stack,
  };
}

/**
 * Destroy what a variant left. After an aborted `up`, the file backend still
 * holds the lock and pending operations, and the variant's own configuration
 * may be unable to reach the emulator: clear both and destroy with `config`.
 */
export async function destroy(stack, { config, stateDir } = {}) {
  try {
    if (stateDir) rmSync(join(stateDir, ".pulumi", "locks"), { recursive: true, force: true });
    if (config) {
      const exported = await stack.exportStack();
      if (exported.deployment?.pending_operations?.length) {
        exported.deployment.pending_operations = [];
        await stack.importStack(exported);
      }
      await stack.setAllConfig(config);
    }
    await stack.destroy({ color: "never", continueOnError: true });
    return "destroyed";
  } catch (err) {
    return `destroy failed: ${shortError(errorText(err), [])}`;
  }
}

function errorText(err) {
  // CommandError carries the CLI's stderr; the useful line is the provider's.
  const s = String(err?.commandResult?.stderr || err?.message || err);
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const interesting = lines.filter((l) =>
    /error|failed|refused|x509|tls|denied|exception/i.test(l),
  );
  return (interesting.length ? interesting : lines).slice(0, 6).join(" | ");
}

function shortError(msg, secrets) {
  let out = msg;
  for (const s of secrets ?? []) if (s) out = out.split(s).join("<redacted>");
  out = out.replace(/RequestID: [0-9a-f-]+,?\s*/gi, "");
  return out.length > 900 ? `${out.slice(0, 900)}…` : out;
}
