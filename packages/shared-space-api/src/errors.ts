import { StarkeepError } from "@starkeep/protocol-primitives";

export class ApiError extends StarkeepError {
  constructor(
    message: string,
    public readonly statusCode: number,
    cause?: unknown,
  ) {
    super(message, "API_ERROR", cause);
    this.name = "ApiError";
  }
}

export class RouteNotFoundError extends ApiError {
  constructor(path: string, method: string) {
    super(`Route not found: ${method} ${path}`, 404);
    this.name = "RouteNotFoundError";
  }
}

export class MethodNotAllowedError extends ApiError {
  constructor(path: string, method: string) {
    super(`Method not allowed: ${method} ${path}`, 405);
    this.name = "MethodNotAllowedError";
  }
}
