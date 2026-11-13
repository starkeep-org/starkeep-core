/**
 * The words an install shows before it acts: what the app may read and write,
 * and whether it can create public links.
 *
 * Admin's consent dialog and the terminal install both print these words, so
 * the person approves the same sentence either way. Free of `node:*` imports,
 * because the dialog runs in the browser.
 */

/** The parts of a manifest the consent words read. */
export interface ConsentManifest {
  id?: string;
  name?: string;
  infraRequirements?: {
    fileAccess?: ReadonlyArray<ConsentGrant>;
    fileAccessAll?: boolean;
    publicSharing?: boolean;
  };
}

/** One file grant, as the manifest declares it. */
export interface ConsentGrant {
  types: readonly string[];
  access: "read" | "readwrite";
  metadataWrite?: boolean;
}

/**
 * What a grant allows, as the consent words name it. Any access implies read
 * on the category's metadata table, and `metadataWrite` adds write.
 */
export function grantPermissions(g: ConsentGrant): { files: string; metadata: string } {
  return {
    files: g.access === "readwrite" ? "read + write" : "read",
    metadata: g.metadataWrite ? "read + write" : "read",
  };
}

/**
 * What the install dialogs say about the public-sharing capability. One
 * sentence for both the local and the cloud install, so the person approves
 * the same words either way.
 *
 * The sentence names what a link can expose from the app's own grants, so
 * Photos reads "your images and videos" and the Example App "your example
 * files". An app with every file, or with no grant, reads "your files".
 */
export function publicSharingConsent(manifest: ConsentManifest): string | null {
  if (manifest.infraRequirements?.publicSharing !== true) return null;
  const name = manifest.name ?? manifest.id ?? "This app";
  return `${name} can create web links to your ${sharedContentOf(manifest)}. Anyone who has a valid link can view the content you share without signing in.`;
}

/** The grant categories as a lowercase phrase, such as "images and videos". */
function sharedContentOf(manifest: ConsentManifest): string {
  const ir = manifest.infraRequirements;
  if (ir?.fileAccessAll) return "files";
  const types = (ir?.fileAccess ?? []).flatMap((g) => g.types);
  const names = categoryNamesOf(types).map((n) =>
    /^[A-Z][a-z]/.test(n) ? n[0]!.toLowerCase() + n.slice(1) : n,
  );
  if (names.length === 0) return "files";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A grant's file categories, named in the plural for the install prompt.
 *
 * One entry per category an app may be granted, plus `other`. A category
 * missing here shows as its raw id, so `consent-category-names.test.ts` checks
 * the map against the registry's `APP_GRANTABLE_CATEGORIES`.
 */
const CATEGORY_NAMES: Record<string, string> = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  document: "Documents",
  text: "Text files",
  code: "Code files",
  font: "Fonts",
  archive: "Archives",
  data: "Data files",
  model3d: "3D models",
  example: "Example files",
  other: "Other files",
};

export function categoriesOf(types: readonly string[]): string {
  return categoryNamesOf(types).join(", ");
}

/** Each category's name once, in the order the types list them. */
function categoryNamesOf(types: readonly string[]): string[] {
  const prefixes = [...new Set(types.map((t) => t.split("/")[0] ?? t))];
  return prefixes.map((p) => CATEGORY_NAMES[p] ?? p);
}
