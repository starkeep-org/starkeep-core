import { StarkeepError } from "@starkeep/protocol-primitives";

export class SyncError extends StarkeepError {
  constructor(message: string, cause?: unknown) {
    super(message, "SYNC_ERROR", cause);
    this.name = "SyncError";
  }
}
