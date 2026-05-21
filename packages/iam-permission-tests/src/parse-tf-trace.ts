/**
 * Parser for pulumi-aws install traces captured via Pulumi's verbose
 * logging (PULUMI_OPTION_VERBOSE=9 + PULUMI_OPTION_LOGTOSTDERR=true, plus
 * TF_LOG=DEBUG which lights up the tfbridge HTTP transport).
 *
 * Each AWS API call shows up as a structured log line:
 *
 *   {"level":"INFO","msg":"  logging/tf_logger.go:47: provider.aws-base:
 *     HTTP Request Sent: rpc.service=STS ... rpc.method=GetCallerIdentity
 *     ... http.url=https://sts.us-east-2.amazonaws.com/ ...","v":3}
 *
 * The same event is emitted twice — once unwrapped (v=3) and once again
 * wrapped in `eventSink::Debug(<{%reset%}>...<{%reset%}>)` at v=9. We
 * dedupe by skipping any line containing `eventSink::Debug(`.
 *
 * rpc.service values seen so far: STS, S3, Lambda, DSQL, ApiGatewayV2,
 * "CloudWatch Logs", "Cost and Usage Report Service". The quoted ones
 * contain spaces.
 */

export interface CapturedCall {
  /** IAM action prefix, e.g. "s3", "lambda", "dsql". */
  service: string;
  /** Operation name as it appears in IAM, e.g. "CreateBucket". */
  operation: string;
  /** Best-guess resource ARN if recoverable; otherwise undefined. */
  resourceArn?: string;
  /** Number of times this exact (service, operation) was observed. */
  count: number;
  /** A short trimmed snippet of one of the matching log lines. */
  evidence: string;
}

export interface UnparsedEntry {
  reason: "unknown-service" | "no-rpc-method";
  evidence: string;
}

export interface ParseResult {
  calls: CapturedCall[];
  unparsed: UnparsedEntry[];
}

// Friendly rpc.service value → IAM action prefix.
// API Gateway: both v1 REST and v2 HTTP/WebSocket APIs use the
// `apigateway:` action prefix in IAM, despite the SDK service name being
// "ApiGatewayV2". (Worth double-checking via the simulator output —
// some bridged providers have surprised us before.)
const SERVICE_TO_IAM: Record<string, string> = {
  STS: "sts",
  S3: "s3",
  Lambda: "lambda",
  DSQL: "dsql",
  ApiGatewayV2: "apigateway",
  IAM: "iam",
  "CloudWatch Logs": "logs",
  "Cost and Usage Report Service": "cur",
};

// SDK operation name → IAM action name, where the two diverge. The SDK
// keeps historical names (e.g. HeadBucket, GetBucketAccelerateConfiguration)
// but IAM uses a different (often shorter) form. Without this layer,
// iam-simulate rejects the captured action as "invalid.action".
//
// Keys are `${service}:${SdkOperation}` (after SERVICE_TO_IAM mapping);
// values are the canonical `${service}:${IamAction}`.
export const SDK_TO_IAM_ACTION: Record<string, string> = {
  // S3: HeadBucket/HeadObject share IAM actions with their Get/List
  // counterparts; the "Bucket" prefix was dropped from several Get*
  // configuration actions when IAM was extended to S3.
  "s3:HeadBucket": "s3:ListBucket",
  "s3:HeadObject": "s3:GetObject",
  "s3:GetBucketAccelerateConfiguration": "s3:GetAccelerateConfiguration",
  "s3:GetBucketLifecycleConfiguration": "s3:GetLifecycleConfiguration",
  "s3:GetBucketReplication": "s3:GetReplicationConfiguration",
  "s3:GetBucketEncryption": "s3:GetEncryptionConfiguration",
  "s3:GetObjectLockConfiguration": "s3:GetBucketObjectLockConfiguration",
};

// rpc.service can be unquoted (single token) or double-quoted (contains
// spaces). The double-quoted form appears in the trace as JSON-escaped
// (backslash + quote) because the surrounding log record is itself a
// JSON-stringified object; match either form.
const RPC_SERVICE_RE = /rpc\.service=(?:\\"([^"\\]+)\\"|"([^"]+)"|([A-Za-z0-9_]+))/;
const RPC_METHOD_RE = /rpc\.method=([A-Za-z0-9_]+)/;

export function parseTfTrace(trace: string): ParseResult {
  const lines = trace.split(/\r?\n/);

  // Keyed by `${service}:${operation}` so we can count duplicate calls
  // (e.g. Lambda CreateFunction retried 32× during IAM propagation).
  const byKey = new Map<string, CapturedCall>();
  const unparsed: UnparsedEntry[] = [];

  for (const line of lines) {
    if (!line.includes("HTTP Request Sent")) continue;
    // Dedupe: the same event is emitted twice — once raw and once wrapped
    // in eventSink::Debug. Skip the wrapped copy.
    if (line.includes("eventSink::Debug(")) continue;

    const svcMatch = line.match(RPC_SERVICE_RE);
    const methodMatch = line.match(RPC_METHOD_RE);
    if (!methodMatch) {
      unparsed.push({ reason: "no-rpc-method", evidence: trim(line) });
      continue;
    }
    const operation = methodMatch[1];
    const rawService = svcMatch ? (svcMatch[1] ?? svcMatch[2] ?? svcMatch[3]) : undefined;
    if (!rawService) {
      unparsed.push({ reason: "unknown-service", evidence: trim(line) });
      continue;
    }
    const service = SERVICE_TO_IAM[rawService] ?? rawService.toLowerCase();
    const sdkAction = `${service}:${operation}`;
    const iamAction = SDK_TO_IAM_ACTION[sdkAction] ?? sdkAction;
    const [mappedService, mappedOperation] = iamAction.split(":") as [string, string];
    const key = iamAction;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
    } else {
      byKey.set(key, {
        service: mappedService,
        operation: mappedOperation,
        count: 1,
        evidence: trim(line),
      });
    }
  }

  return { calls: [...byKey.values()], unparsed };
}

function trim(line: string): string {
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}
