/**
 * Parser for the newline-delimited JSON trace produced by sdk-trace.ts.
 *
 * Each line is:
 *   {"t":"...","clientName":"IAMClient","commandName":"CreateRoleCommand","input":{...}}
 *
 * We map clientName → IAM action prefix (lowercase, drop "Client"),
 * commandName → operation (drop "Command"), then run the same
 * SDK_TO_IAM_ACTION table the Pulumi-trace parser uses to handle the
 * S3 "drop Bucket prefix" gotchas.
 */

import { SDK_TO_IAM_ACTION, type CapturedCall, type ParseResult } from "./parse-tf-trace";

// SDK client class name → IAM service prefix, for cases where dropping
// "Client" + lowercasing isn't right.
const CLIENT_TO_IAM: Record<string, string> = {
  CognitoIdentityProviderClient: "cognito-idp",
  CloudWatchLogsClient: "logs",
  CostAndUsageReportServiceClient: "cur",
  CostExplorerClient: "ce",
  APIGatewayV2Client: "apigateway",
  ApiGatewayV2Client: "apigateway",
  // S3, STS, IAM, Lambda, SSM, DSQL all reduce correctly via the default
  // (drop "Client", lowercase).
};

function clientNameToServicePrefix(clientName: string): string {
  return CLIENT_TO_IAM[clientName] ?? clientName.replace(/Client$/, "").toLowerCase();
}

export function parseSdkTrace(trace: string): ParseResult {
  const lines = trace.split(/\r?\n/);
  const byKey = new Map<string, CapturedCall>();
  const unparsed: ParseResult["unparsed"] = [];

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let record:
      | { clientName?: string; commandName?: string; principal?: string }
      | undefined;
    try {
      record = JSON.parse(raw);
    } catch {
      unparsed.push({ reason: "no-rpc-method", evidence: raw.slice(0, 200) });
      continue;
    }
    if (!record?.clientName || !record?.commandName) {
      unparsed.push({ reason: "no-rpc-method", evidence: raw.slice(0, 200) });
      continue;
    }
    const service = clientNameToServicePrefix(record.clientName);
    const operation = record.commandName.replace(/Command$/, "");
    const sdkAction = `${service}:${operation}`;
    const iamAction = SDK_TO_IAM_ACTION[sdkAction] ?? sdkAction;
    const [mappedService, mappedOperation] = iamAction.split(":") as [string, string];
    const principalArn = record.principal ?? "unknown";
    // Dedupe per (principal, action) — the same action invoked by Manager
    // and again by install-ddl-role must remain two distinct rows so the
    // simulator can evaluate each under the right context.
    const key = `${principalArn}::${iamAction}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
    } else {
      byKey.set(key, {
        service: mappedService,
        operation: mappedOperation,
        count: 1,
        evidence: raw.slice(0, 200),
        principalArn,
      });
    }
  }

  return { calls: [...byKey.values()], unparsed };
}

/**
 * Sniff: SDK traces are JSON-per-line with a `clientName` field on the
 * first non-empty line. Pulumi TF_LOG traces are also line-based JSON
 * but use a different top-level shape (`time`/`level`/`msg`). This is
 * cheap and unambiguous.
 */
export function looksLikeSdkTrace(trace: string): boolean {
  for (const line of trace.split(/\r?\n/, 5)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("{")) return false;
    try {
      const obj = JSON.parse(trimmed);
      return typeof obj === "object" && obj !== null && "clientName" in obj && "commandName" in obj;
    } catch {
      return false;
    }
  }
  return false;
}
