/**
 * Moving an example file to the Trash. The page's Delete button and the MCP
 * `trash_file` tool both call {@link trashFile}, so the two cannot drift.
 *
 * The platform tombstones the record and its derived copies. The app's own
 * rows that name the file, its note and its `collection_items` rows, stay as
 * they are, so a restore returns the file with them. While the file sits in
 * the Trash, those rows still count: a collection counts the file, and a note
 * search finds its note.
 */

/** One data-plane call: answers the parsed body, or throws on a failure. */
export type DataCall = (method: "DELETE", path: string) => Promise<unknown>;

/**
 * `DELETE /data/records/:id`: move a file and its derived copies to the
 * Trash. Answers the ids of every record the delete took.
 */
export async function trashFile(call: DataCall, recordId: string): Promise<string[]> {
  const body = (await call("DELETE", `/data/records/${encodeURIComponent(recordId)}`)) as {
    ids?: unknown;
  } | null;
  return Array.isArray(body?.ids) ? body.ids.map(String) : [];
}
