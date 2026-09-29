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

/**
 * Whether a write failed on the stand-in slot index — a second live canonical
 * stand-in for one original, or a second live stand-in at one size.
 *
 * Matched on the column name, which both engines put in the message: SQLite
 * reports `UNIQUE constraint failed: shared_records.parent_id,
 * shared_records.stand_in_slot`, and Postgres names the index
 * `uq_records_stand_in_slot`, which carries the same words. No driver
 * dependency, the same trade the duplicate-file check makes.
 */
export function isStandInSlotConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("stand_in_slot");
}
