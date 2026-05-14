import { StarkeepError } from "@starkeep/core";

export class StorageError extends StarkeepError {
  constructor(message: string, cause?: unknown) {
    super(message, "STORAGE_ERROR", cause);
    this.name = "StorageError";
  }
}

export class ConnectionError extends StorageError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ConnectionError";
  }
}

export class TransactionError extends StorageError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "TransactionError";
  }
}

export class ObjectNotFoundError extends StorageError {
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = "ObjectNotFoundError";
  }
}
