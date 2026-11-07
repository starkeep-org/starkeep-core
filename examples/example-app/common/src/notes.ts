/**
 * The `notes` table: one private note per example file.
 *
 * The table syncs on the app's own channel, so every flavor reads and writes
 * the same rows. `encodeNote` and `decodeNote` fix the row encoding in one
 * place.
 */

/** A note as the app's code handles it. */
export interface Note {
  /** The shared record the note is about. */
  readonly recordId: string;
  readonly text: string;
  readonly pinned: boolean;
  /** When the note was last edited, as an ISO 8601 UTC instant. */
  readonly updatedOn: string;
}

/** A `notes` row as the data plane stores it. */
export interface NoteRow {
  readonly record_id: string;
  readonly note: string | null;
  readonly pinned: boolean | null;
  readonly updated_on: string | null;
}

export function encodeNote(note: Note): NoteRow {
  return {
    record_id: note.recordId,
    note: note.text,
    pinned: note.pinned,
    updated_on: note.updatedOn,
  };
}

export function decodeNote(row: Record<string, unknown>): Note {
  return {
    recordId: String(row["record_id"]),
    text: typeof row["note"] === "string" ? row["note"] : "",
    pinned: row["pinned"] === true,
    updatedOn: typeof row["updated_on"] === "string" ? row["updated_on"] : "",
  };
}
