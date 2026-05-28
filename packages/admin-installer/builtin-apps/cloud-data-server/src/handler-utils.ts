// Shared types and response helpers for Lambda handlers.

export interface APIGatewayEvent {
  rawPath: string;
  requestContext: {
    http: { method: string };
    authorizer?: {
      jwt?: { claims?: Record<string, string> };
    };
  };
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string>;
}

// Minimal subset of the Lambda invocation context we rely on. The full type
// lives in aws-lambda but we don't take a dependency just for one field.
export interface LambdaContext {
  invokedFunctionArn: string;
}

export function ok(body: unknown, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function clientErr(message: string, status: number) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message }),
  };
}
