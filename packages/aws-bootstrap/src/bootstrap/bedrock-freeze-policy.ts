import type { IamStatement } from "../iam-utils.js";

/**
 * Policy statements for the ${StackPrefix}-bedrock-freeze-policy managed policy
 * (budget-guardrail plan §4.1).
 *
 * This is the STRUCTURAL backstop under the capability broker's software gates.
 * An action-enabled AWS Budget attaches this policy to the capability-broker
 * role when Bedrock spend breaches its monthly limit; after that attach the role
 * cannot invoke Bedrock regardless of what the broker code does — including for
 * STS sessions minted BEFORE the freeze, since identity policies are evaluated
 * at request time. It is the only ceiling in the stack that does not depend on
 * our own code being correct.
 *
 * WHY WILDCARD PATTERNS, NOT LITERAL VERBS. A Bedrock spend verb introduced
 * after this was written must be denied without anyone remembering to edit this
 * file, so the patterns are deliberately broad. Breadth is safe here precisely
 * because the target role's permissions boundary
 * (capability-broker-permissions-boundary) is Bedrock-invoke-only: a wider Deny
 * cannot deny anything the role was ever going to legitimately do.
 *
 * WHY THE ASYNC POLL IS LEFT ALLOWED. `bedrock:GetAsyncInvoke` and
 * `bedrock:ListAsyncInvokes` are NOT matched by any pattern below, on purpose —
 * `StartAsync*` is chosen over `*Async*` for exactly that reason. A video job
 * already submitted will run and bill whether or not we freeze; denying the poll
 * would strand the ledger with an unreconciled reservation and the app with a
 * job it can never collect. Freezing stops NEW spend; it must not corrupt the
 * accounting of spend already committed.
 *
 * The policy takes no stackPrefix — it denies by action, on `Resource: "*"`, and
 * has nothing to scope. The signature keeps the prefix parameter so it composes
 * with the other statement builders (and with `policies.test.ts`'s size sweep).
 */
export function bedrockFreezePolicyStatements(): IamStatement[] {
  return [
    {
      Sid: "DenyBedrockSpend",
      Effect: "Deny",
      Action: [
        // InvokeModel, InvokeModelWithResponseStream, InvokeAgent, InvokeFlow…
        "bedrock:Invoke*",
        // Converse, ConverseStream.
        "bedrock:Converse*",
        // StartAsyncInvoke — and NOT Get/ListAsyncInvokes (see above).
        "bedrock:StartAsync*",
        // Knowledge-base retrieval (Retrieve, RetrieveAndGenerate) — billed.
        "bedrock:Retrieve*",
        // Reranking (Rerank) — billed.
        "bedrock:Rerank*",
      ],
      Resource: "*",
    },
  ];
}

/**
 * Action names that must survive a freeze so an in-flight async job can still be
 * polled and reconciled. Exported so the policy test can assert the invariant by
 * matching against the rendered patterns rather than by eyeballing the list.
 */
export const BEDROCK_FREEZE_EXEMPT_ACTIONS = [
  "bedrock:GetAsyncInvoke",
  "bedrock:ListAsyncInvokes",
] as const;
