import { StarkeepError } from "@starkeep/protocol-primitives";

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

/**
 * A `putFromFileUri` declined the transfer before sending anything.
 *
 * Distinct from a failed transfer, and the distinction is the whole contract:
 * this says "nothing happened, use the stream path", where every other error
 * says "the transfer failed". See `ObjectStorageAdapter.putFromFileUri` for the
 * one condition that may raise it and for why it may only be raised before any
 * bytes move.
 */
export class FileUriTransferRefused extends StorageError {
  constructor(key: string, reason: string) {
    super(`Refused to send ${key} from a file URI: ${reason}`);
    this.name = "FileUriTransferRefused";
  }
}
