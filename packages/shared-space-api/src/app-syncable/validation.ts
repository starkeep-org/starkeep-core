/** Reject column names the runtime reserves on every app-syncable table. */
export const RESERVED_COLUMN_NAMES = new Set(["updated_at", "deleted_at"]);

/** Safe SQL identifier: lowercase letters, digits, underscores; starts with letter/underscore. */
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

export function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

export function validateTableName(name: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Invalid app-syncable table name: ${JSON.stringify(name)}`);
  }
}
