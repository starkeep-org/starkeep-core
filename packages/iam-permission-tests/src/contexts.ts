/**
 * Registry of named IAM-evaluation contexts.
 *
 * A "context" is everything iam-simulate needs to evaluate a captured AWS
 * call: the principal, the identity policies attached to it, and the
 * permissions boundary. Each named context describes one role-at-a-moment
 * — e.g. the cloud-data-server app role during a Pulumi install vs. the
 * same role at runtime (different inline policies attached).
 *
 * Contexts pull their policies from the same builders the admin-installer
 * uses at runtime (relative imports, not duplicated copies), so a policy
 * change automatically updates the simulator's view of "what's attached
 * right now".
 *
 * To add a context:
 *   1. Add a CONTEXTS entry below with its identity policies + boundary.
 *   2. Capture a trace by running under that context (or hand-list calls).
 *   3. Invoke the CLI with --context=<your-name> <trace-files>.
 */

import { buildTempInstallCloudDataServerPolicy } from "../../admin-installer/src/temp-policies";
import { foundationalPermissionsBoundaryStatements } from "../../admin-core/src/bootstrap/foundational-permissions-boundary";

export interface ContextInput {
  stackPrefix: string;
  accountId: string;
  region: string;
}

export interface PolicyDoc {
  name: string;
  policy: unknown;
}

export interface IamContext {
  /** What iam-simulate sees as the calling principal (an assumed-role session ARN). */
  principalArn: string;
  identityPolicies: PolicyDoc[];
  permissionBoundaryPolicies: PolicyDoc[];
  /** Context variables (aws:PrincipalTag/*, etc.) the principal carries at evaluation time. */
  contextVariables: Record<string, string | string[]>;
}

interface ContextBuilder {
  /** One-line description shown by `--list-contexts`. */
  description: string;
  build(input: ContextInput): IamContext;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function assumedRoleArn(accountId: string, roleName: string, session = "test"): string {
  return `arn:aws:sts::${accountId}:assumed-role/${roleName}/${session}`;
}

function brokerPowerPolicy(stackPrefix: string, accountId: string): PolicyDoc {
  return {
    name: "broker-power",
    policy: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "BrokerAssumeAppRoles",
          Effect: "Allow",
          Action: "sts:AssumeRole",
          Resource: `arn:aws:iam::${accountId}:role/${stackPrefix}-app-*-role`,
        },
      ],
    },
  };
}

function foundationalBoundary(stackPrefix: string): PolicyDoc {
  return {
    name: "foundational-boundary",
    policy: {
      Version: "2012-10-17",
      Statement: foundationalPermissionsBoundaryStatements(stackPrefix),
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const CONTEXTS: Record<string, ContextBuilder> = {
  "install-cloud-data-server": {
    description:
      "cloud-data-server app role during pulumi up — broker-power + " +
      "temp-install-cloud-data-server, foundational boundary.",
    build({ stackPrefix, accountId, region }) {
      const roleName = `${stackPrefix}-app-cloud-data-server-role`;
      const tempInstall: PolicyDoc = {
        name: "temp-install-cloud-data-server",
        policy: JSON.parse(
          buildTempInstallCloudDataServerPolicy(stackPrefix, accountId, region),
        ),
      };
      return {
        principalArn: assumedRoleArn(accountId, roleName, "install"),
        identityPolicies: [brokerPowerPolicy(stackPrefix, accountId), tempInstall],
        permissionBoundaryPolicies: [foundationalBoundary(stackPrefix)],
        contextVariables: {
          "aws:PrincipalTag/starkeep:appId": "cloud-data-server",
        },
      };
    },
  },

  // Stubs — wired in shape but their policy sets aren't built yet. Throwing
  // here is intentional so the CLI surfaces "not implemented" rather than
  // silently simulating against an empty policy and printing all Allowed.
  "runtime-cloud-data-server": {
    description: "cloud-data-server Lambda runtime (broker-power + runtime, no temp-install).",
    build() {
      throw new Error(
        "context 'runtime-cloud-data-server' not implemented yet: needs runtime policy wiring (see buildRuntimePolicy in admin-installer/src/temp-policies.ts).",
      );
    },
  },
  "install-app": {
    description: "Per-app install (manager → app role, temp-install-infra, app boundary).",
    build() {
      throw new Error("context 'install-app' not implemented yet.");
    },
  },
  "runtime-app": {
    description: "Per-app Lambda runtime (runtime policy, app boundary).",
    build() {
      throw new Error("context 'runtime-app' not implemented yet.");
    },
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listContexts(): Array<{ name: string; description: string }> {
  return Object.entries(CONTEXTS).map(([name, c]) => ({ name, description: c.description }));
}

export function buildContext(name: string, input: ContextInput): IamContext {
  const ctx = CONTEXTS[name];
  if (!ctx) {
    const available = Object.keys(CONTEXTS).join(", ");
    throw new Error(`unknown context '${name}'. Available: ${available}`);
  }
  return ctx.build(input);
}
