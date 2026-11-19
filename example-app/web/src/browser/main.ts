/**
 * The page: one heading per group of operations, each with a table of the
 * current state and a row of controls. Every request also lands in the
 * Activity table at the bottom.
 *
 * Plain DOM and no framework, so the code shows the platform rather than a UI
 * library. Each `render…` function redraws one section from the data plane.
 */

import { LABEL_KEYS, type Note } from "@example-app/common";
import * as api from "./api.js";
import { activityEntries, onActivity } from "./activity.js";
import { button, group, renderTable, type Cell, type Column } from "./table.js";

// ---------------------------------------------------------------------------
// Page scaffolding
// ---------------------------------------------------------------------------

const root = document.getElementById("app")!;
root.replaceChildren();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  return el("label", {}, `${text} `, control);
}

/** Give a control its accessible name directly. */
function named<T extends HTMLElement>(node: T, name: string): T {
  node.setAttribute("aria-label", name);
  return node;
}

const status = el("p", { id: "status" });
status.setAttribute("role", "status");

/** Show what happened, or why it failed, in the status line. */
async function run(what: string, action: () => Promise<unknown>): Promise<void> {
  status.textContent = `${what}…`;
  try {
    await action();
    status.textContent = `${what}: done.`;
  } catch (err) {
    status.textContent = `${what} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** One heading and the body it redraws. */
function section(title: string, intro: string): { body: HTMLDivElement; controls: HTMLDivElement } {
  const s = el("section");
  s.setAttribute("aria-labelledby", `h-${title}`);
  const h = el("h2", { id: `h-${title}` }, title);
  const controls = el("div", { className: "controls" });
  const body = el("div");
  s.append(h, el("p", { className: "intro" }, intro), controls, body);
  root.append(s);
  return { body, controls };
}

root.append(el("h1", {}, "Example App"));
root.append(
  el(
    "p",
    {},
    "Every app-facing data operation, on invented plaintext files of type example/plaintext. " +
      "Each request appears in the Activity table at the bottom.",
  ),
  status,
);

let selectedId: string | null = null;
let filter: api.RecordFilter = { kind: "all" };
let pageTokens: (string | undefined)[] = [undefined];
let isCloud = false;
/** The instant the Deleted heading reconciles from. */
let reconciledFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const connection = section(
  "Connection",
  "Which surface this page runs on, who is signed in, where outside clients get access, what a write outside the app's grant gets back, and a call to the app's own JWT-gated route.",
);
const connectionRows: { name: string; value: Cell }[] = [];
let grantCheckResult = "not run";
let jwtRouteResult = "not run";

async function renderConnection(): Promise<void> {
  const config = await api.runtimeConfig();
  isCloud = Boolean(config.apiGatewayUrl);
  const who = await api
    .session()
    .catch(() => ({ signedIn: false }) as { signedIn: boolean; email?: string });
  connectionRows.length = 0;
  connectionRows.push(
    { name: "Surface", value: isCloud ? "cloud" : "local" },
    {
      name: "Data server",
      value: isCloud ? (config.apiGatewayUrl ?? "") : "local-data-server, through the app's proxy",
    },
    {
      name: "Session",
      value: who.signedIn
        ? `signed in as ${who.email ?? "unknown"}`
        : isCloud
          ? "signed out"
          : "none needed locally",
    },
    // The platform's consent pages answer on the gateway's execute-api host,
    // not on this page's origin, so the runtime config names them. Locally
    // an outside client needs no token, and the config names neither page.
    { name: "Connect page", value: pageLink(config.connectUrl) },
    { name: "Connections page", value: pageLink(config.connectionsUrl) },
    { name: "Grant check (write text/txt)", value: grantCheckResult },
    { name: "JWT route (POST /api/echo)", value: jwtRouteResult },
  );
  connection.body.replaceChildren(
    renderTable(
      "Connection",
      [
        { heading: "Item", cell: (r) => r.name },
        { heading: "Value", cell: (r) => r.value },
      ] satisfies Column<{ name: string; value: Cell }>[],
      connectionRows,
    ),
  );
}

/** A link to one of the platform's pages, or a note that the surface has none. */
function pageLink(url: string | undefined): Cell {
  return url ? el("a", { href: url, textContent: url }) : "none locally";
}

connection.controls.append(
  button("Run grant check", () =>
    run("Grant check", async () => {
      const result = await api.grantCheck();
      grantCheckResult =
        result.status === 403 ? "403 refused, as it should be" : `unexpected ${result.status}`;
      await renderConnection();
    }),
  ),
  button("Call the JWT route", () =>
    run("JWT route", async () => {
      const result = await api.callJwtRoute(isCloud, "hello");
      jwtRouteResult =
        result.ok && result.body.echo?.message === "hello"
          ? `${result.status}, echoed`
          : `unexpected ${result.status}`;
      await renderConnection();
    }),
  ),
  button("Refresh session", () =>
    run("Refresh session", async () => {
      await api.refreshSession();
      await renderConnection();
    }),
  ),
  button("Sign out", () =>
    run("Sign out", async () => {
      const { signOutUrl } = await api.signOut();
      if (isCloud && signOutUrl) location.assign(signOutUrl);
      else await renderConnection();
    }),
  ),
);

// ---------------------------------------------------------------------------
// Example files
// ---------------------------------------------------------------------------

const files = section(
  "Example files",
  "Shared records of type example/plaintext. Create one from text, upload a file, derive a copy, filter, page and delete.",
);
const nameInput = el("input", { value: "hello.skexample" });
const textInput = el("textarea", { rows: 3, value: "Hello, Starkeep.\nThis file is an example." });
const uploadInput = el("input", { type: "file" });
const filterSelect = el("select");
for (const [value, text] of [
  ["all", "All"],
  ["originals", "Originals only"],
  ["children", "Copies of the selected file"],
  ["tag", "Tagged…"],
]) {
  filterSelect.append(el("option", { value: value!, textContent: text! }));
}
const tagFilterInput = el("input", { placeholder: "tag value", size: 10 });
const countOut = named(el("output", {}, "?"), "File count");
const urlsOut = named(el("output", {}, ""), "URLs fetched");
const urlsList = named(el("ul"), "Fetched URLs");

const sampleOut = named(el("output", {}, ""), "Sample data");

files.controls.append(
  button("Load sample data", () =>
    run("Load sample data", async () => {
      const result = await api.loadSampleData();
      sampleOut.value = result.loaded
        ? `${result.files} sample files, their notes and three collections.`
        : "Sample files already exist; delete them to load the set again.";
      await refreshAll();
    }),
  ),
  sampleOut,
  el("br"),
  labelled("File name", nameInput),
  labelled("Content", textInput),
  button("Create file", () =>
    run("Create file", async () => {
      const record = await api.createFromText(nameInput.value, textInput.value);
      selectedId = record.id;
      await refreshAll();
    }),
  ),
  labelled("Upload a file", uploadInput),
  el("br"),
  labelled("Show", filterSelect),
  labelled("Tag", tagFilterInput),
  button("Apply filter", () =>
    run("Filter", async () => {
      const kind = filterSelect.value;
      filter =
        kind === "originals"
          ? { kind: "originals" }
          : kind === "children"
            ? { kind: "children", parentId: selectedOrThrow() }
            : kind === "tag"
              ? { kind: "tag", value: tagFilterInput.value }
              : { kind: "all" };
      pageTokens = [undefined];
      await renderFiles();
    }),
  ),
  button("Count files", () =>
    run("Count", async () => {
      countOut.value = String(await api.countRecords());
    }),
  ),
  countOut,
  button("Fetch URLs for this page", () =>
    run("Fetch URLs", async () => {
      const urls = await api.fileUrls(lastPage.map((r) => r.id));
      urlsOut.value = `${Object.keys(urls).length} URLs`;
      urlsList.replaceChildren(
        ...lastPage
          .filter((r) => urls[r.id])
          .map((r) =>
            el(
              "li",
              {},
              el("a", { href: urls[r.id]!.url, target: "_blank" }, r.original_filename ?? r.id),
            ),
          ),
      );
    }),
  ),
  urlsOut,
  urlsList,
);
uploadInput.addEventListener("change", () => {
  const file = uploadInput.files?.[0];
  if (!file) return;
  void run("Upload", async () => {
    const record = await api.uploadFile(file);
    selectedId = record.id;
    uploadInput.value = "";
    await refreshAll();
  });
});

let lastPage: api.ExampleRecord[] = [];

function labelsText(r: api.ExampleRecord): string {
  return (r.labels ?? []).map((l) => (l.value ? `${l.label}=${l.value}` : l.label)).join(", ");
}

async function renderFiles(): Promise<void> {
  const token = pageTokens[pageTokens.length - 1];
  const page = await api.listRecords(filter, token);
  lastPage = page.records;
  const pager = el("div", { className: "controls" });
  if (pageTokens.length > 1) {
    pager.append(
      button("Previous page", () =>
        run("Previous page", async () => {
          pageTokens.pop();
          await renderFiles();
        }),
      ),
    );
  }
  if (page.nextCursor) {
    const next = page.nextCursor;
    pager.append(
      button("Next page", () =>
        run("Next page", async () => {
          pageTokens.push(next);
          await renderFiles();
        }),
      ),
    );
  }
  files.body.replaceChildren(
    renderTable<api.ExampleRecord>(
      "Example files",
      [
        {
          heading: "Name",
          cell: (r) => (r.id === selectedId ? `▶ ${r.original_filename}` : r.original_filename),
        },
        { heading: "Bytes", cell: (r) => r.size_bytes },
        { heading: "Lines", cell: (r) => (r.metadata?.["line_count"] as number | undefined) ?? "" },
        { heading: "Words", cell: (r) => (r.metadata?.["word_count"] as number | undefined) ?? "" },
        { heading: "Labels", cell: labelsText },
        { heading: "Copy of", cell: (r) => (r.parent_id ? "yes" : "") },
        {
          heading: "Actions",
          cell: (r) =>
            group(
              button(`Open ${r.original_filename}`, () =>
                run("Open", async () => {
                  selectedId = r.id;
                  await Promise.all([renderFiles(), renderOpen()]);
                }),
              ),
              button(`Copy uppercase ${r.original_filename}`, () =>
                run("Copy uppercase", async () => {
                  selectedId = (await api.deriveUppercase(r)).id;
                  await refreshAll();
                }),
              ),
              button(`Delete ${r.original_filename}`, () =>
                run("Delete", async () => {
                  // The delete takes the file's derived copies too, and the
                  // open file may be one of them.
                  const ids = await api.deleteFile(r.id);
                  if (selectedId !== null && ids.includes(selectedId)) selectedId = null;
                  await refreshAll();
                }),
              ),
              button(`Share ${r.original_filename}`, () =>
                run("Share", async () => {
                  await api.createShare(r.id, r.original_filename ?? "Example file");
                  await renderShares();
                }),
              ),
            ),
        },
      ],
      page.records,
      "No example files. Create one above, or drop a .skexample file into a watched folder.",
    ),
    pager,
  );
}

function contentPanel(content: string): HTMLPreElement {
  const pre = el("pre", { className: "content" }, content);
  pre.setAttribute("aria-label", "File content");
  return pre;
}

// The Open panel: one record in full.
const open = section(
  "Open file",
  "The selected file: its record, its content, its metadata row, its labels and its note. A record's own dates say when Starkeep made and changed the record. The file dates come from the source, and only a watched folder reports them. " +
    "Saving or deleting the note succeeds only if nobody changed it since the file was opened, so an edit in another tab is never silently overwritten.",
);
const noteInput = el("textarea", { rows: 2 });
const pinnedInput = el("input", { type: "checkbox" });

async function renderOpen(): Promise<void> {
  if (!selectedId) {
    open.body.replaceChildren(el("p", {}, "Select a file with its Open button."));
    open.controls.replaceChildren();
    return;
  }
  const id = selectedId;
  // The six reads run at once, but only the record read decides whether the
  // file is gone. A live file whose bytes this computer lacks answers 404 from
  // its content read too, and that is an error to report.
  const rest = Promise.all([
    api.readContent(id),
    api.getMetadata(id),
    api.getNote(id),
    api.collectionsHolding(id),
    api.collectionsLacking(id),
  ]);
  // Awaited below, unless a missing record ends the render first.
  rest.catch(() => {});
  let record: api.ExampleRecord;
  try {
    record = await api.getRecord(id);
  } catch (err) {
    // Deleted in another tab, or by an MCP client.
    if (!(err instanceof api.ApiError && err.status === 404) || selectedId !== id) throw err;
    selectedId = null;
    return renderOpen();
  }
  const [content, metadata, noteState, holding, lacking] = await rest;
  const note = noteState?.note ?? null;
  noteInput.value = note?.text ?? "";
  pinnedInput.checked = note?.pinned ?? false;
  const rows: [string, string][] = [
    ["Id", record.id],
    ["Name", record.original_filename ?? ""],
    ["Size", record.size_bytes === null ? "" : `${record.size_bytes} bytes`],
    ["Record created", record.created_at],
    ["Record updated", record.updated_at],
    ["Original created", record.original_created_at ?? "—"],
    ["Original modified", record.original_updated_at ?? "—"],
    ["Copy of", record.parent_id ?? ""],
    ["Labels", labelsText(record)],
    ["Metadata", metadata ? JSON.stringify(metadata) : "none"],
    ["Note", note ? `${note.text}${note.pinned ? " (pinned)" : ""}` : "none"],
    [
      "Collections",
      holding.length
        ? holding.map((c) => (c.archived ? `${c.name} (archived)` : c.name)).join(", ")
        : "none",
    ],
  ];
  open.body.replaceChildren(
    renderTable<[string, string]>(
      "Open file",
      [
        { heading: "Field", cell: (r) => r[0] },
        { heading: "Value", cell: (r) => r[1] },
      ],
      rows,
    ),
    contentPanel(content),
  );
  open.controls.replaceChildren(
    button("Recompute metadata", () =>
      run("Recompute metadata", async () => {
        await api.recomputeMetadata(id);
        await refreshAll();
      }),
    ),
    labelled("Note", noteInput),
    labelled("Pinned", pinnedInput),
    button("Save note", () =>
      run("Save note", async () => {
        // A new note only if there is still none; an edit only if the note
        // is still the one this panel read.
        if (noteState) {
          await api.updateNote(
            id,
            { note: noteInput.value, pinned: pinnedInput.checked },
            noteState.stamp,
          );
        } else {
          const next: Note = {
            recordId: id,
            text: noteInput.value,
            pinned: pinnedInput.checked,
            updatedOn: new Date().toISOString(),
          };
          await api.addNote(next);
        }
        await Promise.all([renderOpen(), renderNotes(), renderCollections()]);
      }),
    ),
    button("Delete note", () =>
      run("Delete note", async () => {
        if (!noteState) throw new Error("the file has no note");
        await api.deleteNoteIfUnchanged(id, noteState.stamp);
        await Promise.all([renderOpen(), renderNotes(), renderCollections()]);
      }),
    ),
    el("br"),
    ...lacking.map((c) =>
      button(`Add to ${c.name}`, () =>
        run("Add to collection", async () => {
          await api.addToCollection(c.id, id);
          await Promise.all([renderOpen(), renderCollections()]);
        }),
      ),
    ),
    ...holding.map((c) =>
      button(`Remove from ${c.name}`, () =>
        run("Remove from collection", async () => {
          await api.removeFromCollection(c.id, id);
          await Promise.all([renderOpen(), renderCollections()]);
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const metadata = section(
  "Metadata",
  "The example category's metadata table, queried directly: largest files first, with totals.",
);

async function renderMetadata(): Promise<void> {
  const [rows, totals] = await Promise.all([api.queryMetadata(), api.metadataTotals()]);
  metadata.body.replaceChildren(
    renderTable<Record<string, unknown>>(
      "Metadata",
      [
        { heading: "Record", cell: (r) => String(r["record_id"] ?? "") },
        { heading: "Lines", cell: (r) => r["line_count"] as number },
        { heading: "Words", cell: (r) => r["word_count"] as number },
        { heading: "Characters", cell: (r) => r["char_count"] as number },
      ],
      rows,
    ),
    renderTable<[string, unknown]>(
      "Metadata totals",
      [
        { heading: "Total", cell: (r) => r[0] },
        { heading: "Value", cell: (r) => String(r[1] ?? "") },
      ],
      Object.entries(totals),
    ),
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const labels = section(
  "Labels",
  "Tags and flags on the selected file, which every app that reads the type can see. Then counts per tag, and every app's declared keys.",
);
const tagsInput = el("input", { placeholder: "draft, idea", size: 16 });
const reviewedInput = el("input", { type: "checkbox" });

function selectedOrThrow(): string {
  if (!selectedId) throw new Error("select a file first");
  return selectedId;
}

function tagList(): string[] {
  return tagsInput.value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

labels.controls.append(
  labelled("Tags", tagsInput),
  labelled("Reviewed", reviewedInput),
  button("Add tags", () =>
    run("Add tags", async () => {
      await api.addLabels(selectedOrThrow(), tagList(), reviewedInput.checked);
      await refreshAll();
    }),
  ),
  button("Set tags exactly", () =>
    run("Set tags", async () => {
      await api.setTags(selectedOrThrow(), tagList());
      await refreshAll();
    }),
  ),
  button("Retract these tags", () =>
    run("Retract tags", async () => {
      const id = selectedOrThrow();
      for (const tag of tagList()) await api.retractLabel(id, LABEL_KEYS.tag, tag);
      await refreshAll();
    }),
  ),
  button("Retract all tags", () =>
    run("Retract all tags", async () => {
      await api.retractLabel(selectedOrThrow(), LABEL_KEYS.tag);
      await refreshAll();
    }),
  ),
  button("Retract reviewed", () =>
    run("Retract reviewed", async () => {
      await api.retractLabel(selectedOrThrow(), LABEL_KEYS.reviewed, "");
      await refreshAll();
    }),
  ),
);

async function renderLabels(): Promise<void> {
  const [counts, keys] = await Promise.all([api.tagCounts(), api.labelKeys()]);
  labels.body.replaceChildren(
    renderTable(
      "Tag counts",
      [
        { heading: "Tag", cell: (r) => r.value },
        { heading: "Files", cell: (r) => r.n },
      ] satisfies Column<{ value: string; n: number }>[],
      counts,
    ),
    renderTable(
      "Declared label keys",
      [
        { heading: "App", cell: (r) => r.app_id },
        { heading: "Key", cell: (r) => r.key },
        { heading: "Description", cell: (r) => r.description ?? "" },
      ] satisfies Column<api.LabelKey>[],
      keys,
    ),
  );
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const collectionsSection = section(
  "Collections",
  "Named groups of example files, in two more of the app's own tables. The list joins each collection to its files to count them. " +
    'A collection\'s contents join each file to its note and to the other collections that hold it. Archived collections stay out of "Also in", but their files stay in the list.',
);
const collectionNameInput = el("input", { placeholder: "Reading list", size: 16 });
collectionsSection.controls.append(
  labelled("Collection name", collectionNameInput),
  button("Create collection", () =>
    run("Create collection", async () => {
      const name = collectionNameInput.value.trim();
      if (!name) throw new Error("name the collection first");
      shownCollectionId = await api.createCollection(name);
      collectionNameInput.value = "";
      await Promise.all([renderCollections(), renderOpen()]);
    }),
  ),
);
/** The collection whose contents the section shows. */
let shownCollectionId: string | null = null;
/** The collections the last render read, for the Notes filter's choices. */
let knownCollections: api.CollectionSummary[] = [];

async function renderCollections(): Promise<void> {
  const list = await api.listCollections();
  knownCollections = list;
  updateNoteFileChoices();
  if (shownCollectionId && !list.some((c) => c.id === shownCollectionId)) shownCollectionId = null;
  const shown = list.find((c) => c.id === shownCollectionId) ?? null;
  const listTable = renderTable<api.CollectionSummary>(
    "Collections",
    [
      { heading: "Name", cell: (c) => (c.id === shownCollectionId ? `▶ ${c.name}` : c.name) },
      { heading: "Files", cell: (c) => c.files },
      { heading: "Archived", cell: (c) => (c.archived ? "yes" : "") },
      {
        heading: "Actions",
        cell: (c) =>
          group(
            button(`Show ${c.name}`, () =>
              run("Show collection", async () => {
                shownCollectionId = c.id;
                await renderCollections();
              }),
            ),
            button(`Rename ${c.name}`, () =>
              run("Rename collection", async () => {
                const name = collectionNameInput.value.trim();
                if (!name) throw new Error("type the new name in Collection name");
                await api.patchCollection(c.id, { name });
                collectionNameInput.value = "";
                await Promise.all([renderCollections(), renderOpen()]);
              }),
            ),
            button(c.archived ? `Unarchive ${c.name}` : `Archive ${c.name}`, () =>
              run(c.archived ? "Unarchive collection" : "Archive collection", async () => {
                await api.patchCollection(c.id, { archived: !c.archived });
                await Promise.all([renderCollections(), renderOpen()]);
              }),
            ),
            button(`Delete collection ${c.name}`, () =>
              run("Delete collection", async () => {
                await api.deleteCollection(c.id);
                await Promise.all([renderCollections(), renderOpen()]);
              }),
            ),
          ),
      },
    ],
    list,
    "No collections. Create one above, or load the sample data.",
  );
  if (!shown) {
    collectionsSection.body.replaceChildren(
      listTable,
      el("p", {}, "Show a collection to list its files."),
    );
    return;
  }
  const entries = await api.collectionContents(shown.id);
  const names = await api.recordNames(entries.map((e) => e.recordId));
  collectionsSection.body.replaceChildren(
    listTable,
    renderTable<api.CollectionEntry>(
      "Collection contents",
      [
        { heading: "File", cell: (e) => names.get(e.recordId) ?? `${e.recordId} (deleted)` },
        { heading: "Note", cell: (e) => e.note ?? "none" },
        { heading: "Also in", cell: (e) => e.alsoIn.join(", ") },
        { heading: "Added", cell: (e) => e.addedOn },
        {
          heading: "Actions",
          cell: (e) =>
            button(`Remove ${names.get(e.recordId) ?? e.recordId} from ${shown.name}`, () =>
              run("Remove from collection", async () => {
                await api.removeFromCollection(shown.id, e.recordId);
                await Promise.all([renderCollections(), renderOpen()]);
              }),
            ),
        },
      ],
      entries,
      `${shown.name} holds no files. Open a file and add it.`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

const notes = section(
  "Notes",
  "The app's own table. Only this app reads it, and it syncs between every place the app is installed.",
);
const searchInput = el("input", { placeholder: "search notes", size: 16 });
const matchSelect = el("select");
for (const [value, text] of [
  ["contains", "Contains"],
  ["starts", "Starts with"],
]) {
  matchSelect.append(el("option", { value: value!, textContent: text! }));
}
const sinceNotesInput = el("input", { placeholder: "2026-01-01T00:00:00Z", size: 22 });
// Named directly: a label around a select also reads out the chosen option.
const noteFilesSelect = named(el("select"), "Files");

/** The Files choices: four fixed ones, then one per collection. */
function updateNoteFileChoices(): void {
  const chosen = noteFilesSelect.value || "all";
  noteFilesSelect.replaceChildren(
    ...[
      ["all", "All files"],
      ["page", "Files on this page"],
      ["notPage", "Files not on this page"],
      ["noCollection", "Files in no collection"],
      ...knownCollections.map((c) => [`collection:${c.id}`, `Files in ${c.name}`]),
    ].map(([value, text]) => el("option", { value: value!, textContent: text! })),
  );
  noteFilesSelect.value = [...noteFilesSelect.options].some((o) => o.value === chosen)
    ? chosen
    : "all";
}
updateNoteFileChoices();

function noteFiles(): api.NoteFiles {
  const value = noteFilesSelect.value;
  const ids = lastPage.map((r) => r.id);
  if (value === "page") return { kind: "page", ids };
  if (value === "notPage") return { kind: "notPage", ids };
  if (value === "noCollection") return { kind: "noCollection" };
  if (value.startsWith("collection:")) {
    return { kind: "collection", collectionId: value.slice("collection:".length) };
  }
  return { kind: "all" };
}
const pinnedOut = named(el("output", {}, "?"), "Pinned notes");
notes.controls.append(
  labelled("Search", searchInput),
  labelled("Match", matchSelect),
  labelled("Edited since", sinceNotesInput),
  labelled("Files", noteFilesSelect),
  button("Search notes", () => run("Search notes", renderNotes)),
  "Pinned notes:",
  pinnedOut,
);

async function renderNotes(): Promise<void> {
  const query: api.NoteQuery = {
    text: searchInput.value,
    match: matchSelect.value === "starts" ? "starts" : "contains",
    ...(sinceNotesInput.value.trim() ? { since: sinceNotesInput.value.trim() } : {}),
    files: noteFiles(),
  };
  const [rows, pinned] = await Promise.all([api.searchNotes(query), api.pinnedCount()]);
  pinnedOut.value = String(pinned);
  notes.body.replaceChildren(
    renderTable<Note>(
      "Notes",
      [
        { heading: "Record", cell: (n) => n.recordId },
        { heading: "Note", cell: (n) => n.text },
        { heading: "Pinned", cell: (n) => (n.pinned ? "yes" : "") },
        { heading: "Updated", cell: (n) => n.updatedOn },
        {
          heading: "Actions",
          cell: (n) =>
            group(
              button(n.pinned ? `Unpin ${n.text}` : `Pin ${n.text}`, () =>
                run("Pin", async () => {
                  await api.patchNote(n.recordId, { pinned: !n.pinned });
                  // The Open panel holds the note's stamp, which this write moved.
                  await Promise.all([renderNotes(), renderOpen(), renderCollections()]);
                }),
              ),
              button(`Delete note ${n.text}`, () =>
                run("Delete note", async () => {
                  await api.deleteNote(n.recordId);
                  await Promise.all([renderNotes(), renderOpen(), renderCollections()]);
                }),
              ),
            ),
        },
      ],
      rows,
    ),
  );
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const analysis = section(
  "Analysis",
  "Notes per day in your time zone, in SQL the app's server runs over a snapshot of the notes table. " +
    "The snapshot lives five minutes, so a note you save appears here after Refresh or once the snapshot expires.",
);
const analysisAsOf = named(el("output", {}, "?"), "Analysis as of");
/** The Refresh floor: a snapshot loaded before it reloads. */
let analysisFreshAfter = 0;
analysis.controls.append(
  button("Refresh analysis", () =>
    run("Refresh analysis", async () => {
      analysisFreshAfter = Date.now();
      await renderAnalysis();
    }),
  ),
  "As of",
  analysisAsOf,
);

async function renderAnalysis(): Promise<void> {
  const { rows, loadedAt } = await api.notesByDay(analysisFreshAfter);
  analysisAsOf.value = new Date(loadedAt).toLocaleTimeString();
  analysisAsOf.dataset["loadedAt"] = String(loadedAt);
  analysis.body.replaceChildren(
    renderTable<api.NotesByDay>(
      "Notes per day",
      [
        { heading: "Day", cell: (r) => r.day ?? "undated" },
        { heading: "Notes", cell: (r) => r.notes },
        { heading: "Pinned", cell: (r) => r.pinned },
        { heading: "Average length", cell: (r) => r.average_length },
      ],
      rows,
    ),
  );
}

// ---------------------------------------------------------------------------
// Note exports
// ---------------------------------------------------------------------------

const noteExports = section(
  "Note exports",
  "The app's own files: each export saves every note as one private JSON file.",
);
const exportOut = el("pre", { className: "content" });
const exportUrlsList = named(el("ul"), "Export URLs");
noteExports.controls.append(
  button("Save export", () =>
    run("Save export", async () => {
      await api.saveExport();
      await renderExports();
    }),
  ),
  button("Get export URLs", () =>
    run("Get export URLs", async () => {
      // The batch route takes at most 200 sub-keys.
      const keys = (await api.listExports()).map((s) => s.sub_key).slice(0, 200);
      if (keys.length === 0) throw new Error("no exports yet");
      const urls = await api.exportUrls(keys);
      exportOut.textContent = `${Object.keys(urls).length} URLs fetched in one call.`;
      exportUrlsList.replaceChildren(
        ...Object.entries(urls).map(([subKey, url]) =>
          el("li", {}, el("a", { href: url, target: "_blank" }, subKey)),
        ),
      );
    }),
  ),
);

async function renderExports(): Promise<void> {
  const rows = await api.listExports();
  noteExports.body.replaceChildren(
    renderTable<api.NoteExport>(
      "Note exports",
      [
        { heading: "Sub-key", cell: (s) => s.sub_key },
        { heading: "Bytes", cell: (s) => s.size_bytes },
        { heading: "Created", cell: (s) => s.created_at },
        {
          heading: "Actions",
          cell: (s) =>
            group(
              button(`Open ${s.sub_key}`, () =>
                run("Open export", async () => {
                  exportOut.textContent = await api.openExport(s.sub_key);
                }),
              ),
              button(`Delete ${s.sub_key}`, () =>
                run("Delete export", async () => {
                  await api.deleteExport(s.sub_key);
                  await renderExports();
                }),
              ),
            ),
        },
      ],
      rows,
    ),
    exportOut,
    exportUrlsList,
  );
}

// ---------------------------------------------------------------------------
// Deleted
// ---------------------------------------------------------------------------

const deleted = section(
  "Deleted",
  "What a reconcile finds: every example file deleted since an instant, and how long a deleted file stays restorable.",
);
const sinceInput = el("input", { value: reconciledFrom, size: 26 });
deleted.controls.append(
  labelled("Deleted since", sinceInput),
  button("Reconcile", () =>
    run("Reconcile", async () => {
      reconciledFrom = sinceInput.value;
      await renderDeleted();
    }),
  ),
);

async function renderDeleted(): Promise<void> {
  const [rows, trash] = await Promise.all([api.deletedSince(reconciledFrom), api.trashPolicy()]);
  deleted.body.replaceChildren(
    renderTable<api.ExampleRecord>(
      "Deleted files",
      [
        { heading: "Name", cell: (r) => r.original_filename },
        { heading: "Deleted", cell: (r) => r.deleted_at ?? r.updated_at },
        {
          heading: "Actions",
          cell: (r) =>
            button(`Restore ${r.original_filename}`, () =>
              run("Restore", async () => {
                await api.restoreRecord(r.id);
                await refreshAll();
              }),
            ),
        },
      ],
      rows,
    ),
    renderTable(
      "Trash",
      [
        { heading: "Setting", cell: () => "Retention window" },
        {
          heading: "Value",
          cell: (t) =>
            t.retention_days === null ? "unknown on this machine" : `${t.retention_days} days`,
        },
      ] satisfies Column<{ retention_days: number | null }>[],
      [trash],
    ),
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const typesSection = section("Types", "Record counts for every type this app may read.");

async function renderTypes(): Promise<void> {
  typesSection.body.replaceChildren(
    renderTable(
      "Types",
      [
        { heading: "Type", cell: (t) => t.record_type },
        { heading: "Records", cell: (t) => t.count },
      ] satisfies Column<{ record_type: string; count: number }>[],
      await api.types(),
    ),
  );
}

// ---------------------------------------------------------------------------
// Public links
// ---------------------------------------------------------------------------

const sharesSection = section(
  "Public links",
  "Web links to your example files, made with a file's Share button. Anyone who has a valid link can view the shared content without signing in. The links live in the cloud, so a computer reaches them only when it is signed in to one.",
);

async function renderShares(): Promise<void> {
  const result = await api.listShares();
  if (!result.ok) {
    sharesSection.body.replaceChildren(
      el("p", {}, `Public links are unavailable here (HTTP ${result.status}). They need a cloud.`),
    );
    return;
  }
  const base = isCloud ? location.origin : await api.cloudAddress();
  const shares = result.body.publicShares ?? [];
  sharesSection.body.replaceChildren(
    renderTable<api.PublicShare>(
      "Public links",
      [
        { heading: "Title", cell: (s) => s.title },
        {
          heading: "Link",
          cell: (s) => {
            const path = `/public-shares/${s.linkToken}/file/${encodeURIComponent(s.title)}`;
            return base
              ? el("a", { href: `${base}${path}`, target: "_blank" }, `${base}${path}`)
              : path;
          },
        },
        {
          heading: "Expires",
          cell: (s) => (s.expiresAtMs === null ? "never" : new Date(s.expiresAtMs).toISOString()),
        },
        {
          heading: "Actions",
          cell: (s) =>
            button(`Revoke ${s.title}`, () =>
              run("Revoke", async () => {
                await api.revokeShare(s.id);
                await renderShares();
              }),
            ),
        },
      ],
      shares,
    ),
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const activity = section("Activity", "Every request this page made, newest first, up to 100.");

function renderActivity(): void {
  activity.body.replaceChildren(
    renderTable(
      "Activity",
      [
        { heading: "Time", cell: (e) => e.at.toLocaleTimeString() },
        { heading: "Method", cell: (e) => e.method },
        { heading: "Path", cell: (e) => e.path },
        { heading: "Status", cell: (e) => e.status },
        { heading: "ms", cell: (e) => e.ms },
      ],
      activityEntries(),
    ),
  );
}
onActivity(renderActivity);

// ---------------------------------------------------------------------------

async function refreshAll(): Promise<void> {
  await Promise.all([
    renderFiles(),
    renderOpen(),
    renderMetadata(),
    renderLabels(),
    renderCollections(),
    renderNotes(),
    renderAnalysis(),
    renderExports(),
    renderDeleted(),
    renderTypes(),
  ]);
}

void run("Load", async () => {
  await renderConnection();
  await Promise.all([refreshAll(), renderShares()]);
});
