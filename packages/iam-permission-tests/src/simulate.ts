/**
 * Drives @cloud-copilot/iam-simulate against a named IAM context for a
 * list of captured AWS calls.
 *
 * Resource ARN handling: many captured calls don't have a recoverable
 * ARN (parser limitation, or the call is wildcard-only like
 * `dsql:CreateCluster`). When `resourceArn` is omitted we pass `*` — the
 * sim then tells us whether the action is granted *at all*. This is a
 * weaker check than per-resource simulation but catches the most common
 * failure mode (missing action entirely from policy).
 */

import { runSimulation, type RunSimulationResults } from "@cloud-copilot/iam-simulate";
import { buildContext, type ContextInput } from "./contexts";
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

export interface SimulateOptions extends ContextInput {
  contextName: string;
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
    const result: RunSimulationResults = await runSimulation(
      {
        request: {
          principal: ctx.principalArn,
          action,
          resource: {
            resource: resourceArn,
            accountId: options.accountId,
          },
          contextVariables: ctx.contextVariables,
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
      outcomes.push({
        call,
        action,
        resourceArn,
        verdict: "Error",
        errorMessage: result.errors.message,
      });
    } else {
      outcomes.push({
        call,
        action,
        resourceArn,
        verdict: result.overallResult,
      });
    }
  }

  return outcomes;
}
