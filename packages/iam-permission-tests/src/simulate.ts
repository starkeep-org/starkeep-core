/**
 * Drives @cloud-copilot/iam-simulate against a named IAM context.
 *
 * Two surfaces:
 *   - simulateCalls: replay captured (action, resource) pairs from a trace.
 *     Resource is `*` when the parser couldn't recover one — a weaker check
 *     than per-resource, but catches the most common failure (action missing
 *     from policy at all).
 *   - simulateExpectedCalls: simulate the *modeled* call set the context
 *     declares it will make. This is the upfront "deployments will work"
 *     guarantee — independent of any captured trace.
 */

import { runSimulation, type RunSimulationResults } from "@cloud-copilot/iam-simulate";
import {
  buildContext,
  expectedCallsFor,
  type ContextInput,
  type ExpectedCall,
} from "./contexts";
import type { CapturedCall } from "./parse-tf-trace";

export type Verdict = "Allowed" | "ExplicitlyDenied" | "ImplicitlyDenied" | "Error";

export interface SimulationOutcome {
  call: CapturedCall;
  action: string;
  resourceArn: string;
  verdict: Verdict;
  /** Populated when verdict === "Error". */
  errorMessage?: string;
}

export interface ExpectedCallOutcome {
  expected: ExpectedCall;
  verdict: Verdict;
  errorMessage?: string;
}

export interface SimulateOptions extends ContextInput {
  contextName: string;
}

async function runOne(
  ctx: ReturnType<typeof buildContext>,
  accountId: string,
  action: string,
  resourceArn: string,
  perCallContextVariables?: Record<string, string | string[]>,
): Promise<{ verdict: Verdict; errorMessage?: string }> {
  const contextVariables = perCallContextVariables
    ? { ...ctx.contextVariables, ...perCallContextVariables }
    : ctx.contextVariables;
  const result: RunSimulationResults = await runSimulation(
    {
      request: {
        principal: ctx.principalArn,
        action,
        resource: { resource: resourceArn, accountId },
        contextVariables,
      },
      identityPolicies: ctx.identityPolicies as Array<{ name: string; policy: any }>,
      serviceControlPolicies: [],
      resourceControlPolicies: [],
      permissionBoundaryPolicies: ctx.permissionBoundaryPolicies as Array<{
        name: string;
        policy: any;
      }>,
    },
    {},
  );
  if (result.resultType === "error") {
    return { verdict: "Error", errorMessage: result.errors.message };
  }
  return { verdict: result.overallResult as Verdict };
}

export async function simulateCalls(
  calls: CapturedCall[],
  options: SimulateOptions,
): Promise<SimulationOutcome[]> {
  const ctx = buildContext(options.contextName, options);
  const outcomes: SimulationOutcome[] = [];
  for (const call of calls) {
    const action = `${call.service}:${call.operation}`;
    const resourceArn = call.resourceArn ?? "*";
    const r = await runOne(ctx, options.accountId, action, resourceArn);
    outcomes.push({ call, action, resourceArn, verdict: r.verdict, errorMessage: r.errorMessage });
  }
  return outcomes;
}

export async function simulateExpectedCalls(
  options: SimulateOptions,
): Promise<ExpectedCallOutcome[]> {
  const ctx = buildContext(options.contextName, options);
  const expected = expectedCallsFor(options.contextName, options);
  const outcomes: ExpectedCallOutcome[] = [];
  for (const exp of expected) {
    const r = await runOne(ctx, options.accountId, exp.action, exp.resource, exp.contextVariables);
    outcomes.push({ expected: exp, verdict: r.verdict, errorMessage: r.errorMessage });
  }
  return outcomes;
}

/**
 * True iff `principalArn` (an assumed-role session ARN like
 * `arn:aws:sts::123:assumed-role/Foo/sess`) names role `roleName`.
 */
export function principalMatchesRole(
  principalArn: string | undefined,
  roleName: string,
): boolean {
  if (!principalArn) return false;
  const m = /:assumed-role\/([^/]+)\//.exec(principalArn);
  return m?.[1] === roleName;
}
