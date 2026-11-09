/**
 * The one table renderer every heading uses.
 *
 * A column is a heading and a function from a row to a cell. A cell is text or
 * a DOM node, such as a button. The table carries an accessible name, so a test
 * or a screen reader can address it.
 */

export type Cell = string | number | boolean | null | undefined | Node;

export interface Column<Row> {
  readonly heading: string;
  readonly cell: (row: Row) => Cell;
}

export function renderTable<Row>(
  label: string,
  columns: readonly Column<Row>[],
  rows: readonly Row[],
  empty = "Nothing yet.",
): HTMLTableElement {
  const table = document.createElement("table");
  table.setAttribute("aria-label", label);
  const head = table.createTHead().insertRow();
  for (const column of columns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = column.heading;
    head.appendChild(th);
  }
  const body = table.createTBody();
  if (rows.length === 0) {
    const td = body.insertRow().insertCell();
    td.colSpan = columns.length;
    td.textContent = empty;
    td.className = "empty";
  }
  for (const row of rows) {
    const tr = body.insertRow();
    for (const column of columns) {
      const td = tr.insertCell();
      const value = column.cell(row);
      if (value instanceof Node) td.appendChild(value);
      else td.textContent = value === null || value === undefined ? "" : String(value);
    }
  }
  return table;
}

/** A button that runs `action` when clicked. */
export function button(label: string, action: () => unknown): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", () => void action());
  return b;
}

/** Several nodes in one cell. */
export function group(...nodes: Node[]): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "group";
  for (const node of nodes) span.appendChild(node);
  return span;
}
