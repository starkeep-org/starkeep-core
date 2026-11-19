/**
 * The sample data the page's Load sample data button creates, so a new user
 * sees every panel filled without inventing files first.
 *
 * The set is shaped to show each query the page makes:
 *
 * - Tags repeat across files, so the tag counts and the tag filter have
 *   something to count.
 * - Notes carry dates days apart, so the Analysis table spans several days.
 * - Files sit in overlapping collections, so a collection's "Also in" column
 *   names others. `bread.skexample` sits only in Recipes and in the archived
 *   Old drafts, so in Recipes it shows an empty "Also in" cell rather than
 *   disappearing.
 * - `meeting-notes.skexample` has a note and sits in no collection, so the
 *   Notes search's "In no collection" filter finds it.
 *
 * The e2e suite asserts against this file, so a change here needs the
 * matching change there.
 */

export interface SampleCollection {
  /** A fixed id, so a second load writes nothing new (`ifAbsent`). */
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
}

export interface SampleFile {
  readonly name: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly reviewed?: boolean;
  readonly note?: {
    readonly text: string;
    readonly pinned?: boolean;
    /** How many days before the load the note was last edited. */
    readonly daysAgo: number;
  };
  /** The ids of the {@link SAMPLE_COLLECTIONS} the file sits in. */
  readonly collections: readonly string[];
}

export const SAMPLE_COLLECTIONS: readonly SampleCollection[] = [
  { id: "sample-recipes", name: "Recipes", archived: false },
  { id: "sample-reading", name: "Reading list", archived: false },
  { id: "sample-old-drafts", name: "Old drafts", archived: true },
];

export const SAMPLE_FILES: readonly SampleFile[] = [
  {
    name: "grocery-list.skexample",
    text: "Eggs\nFlour\nButter\nSugar\nMilk\n",
    tags: ["list", "kitchen"],
    note: { text: "Check the pantry before shopping", pinned: true, daysAgo: 0 },
    collections: ["sample-recipes"],
  },
  {
    name: "pancakes.skexample",
    text: "Whisk two eggs with a cup of milk.\nFold in a cup of flour.\nCook on a hot pan until golden.\n",
    tags: ["recipe", "kitchen"],
    reviewed: true,
    note: { text: "Double the batch for guests", daysAgo: 1 },
    collections: ["sample-recipes", "sample-reading"],
  },
  {
    name: "bread.skexample",
    text: "Flour, water, salt and yeast.\nKnead for ten minutes, then let it rise for an hour.\n",
    tags: ["recipe"],
    collections: ["sample-recipes", "sample-old-drafts"],
  },
  {
    name: "meeting-notes.skexample",
    text: "Agenda: budget, hiring, launch date.\nDecision: launch moves to spring.\n",
    tags: ["work", "draft"],
    note: { text: "Send the summary on Friday", pinned: true, daysAgo: 3 },
    collections: [],
  },
  {
    name: "book-ideas.skexample",
    text: "A lighthouse keeper who collects letters.\nA map that redraws itself every night.\n",
    tags: ["idea"],
    note: { text: "Ask the library about the sequel", daysAgo: 3 },
    collections: ["sample-reading"],
  },
  {
    name: "poem.skexample",
    text: "The kettle hums a quiet tune,\nthe window holds a paper moon.\n",
    tags: ["draft"],
    note: { text: "Second stanza needs work", daysAgo: 7 },
    collections: ["sample-reading", "sample-old-drafts"],
  },
  {
    name: "todo.skexample",
    text: "Water the plants\nCall the plumber\nReturn the library books\n",
    tags: ["list", "work"],
    reviewed: true,
    collections: [],
  },
  {
    name: "haiku.skexample",
    text: "Old pond, still water\na frog leaps in, then silence\nripples reach the shore\n",
    tags: [],
    collections: ["sample-old-drafts"],
  },
];

/** The sample file the load also derives an uppercase copy of. */
export const SAMPLE_DERIVED_FROM = "poem.skexample";
