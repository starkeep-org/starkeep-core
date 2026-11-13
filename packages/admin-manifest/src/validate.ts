import type { AppManifest } from "./schema.js";
import {
  appManifestSchema,
  PLATFORM_PUBLIC_PATHS,
  publicPathCovers,
  SIGN_IN_PATH,
} from "./schema.js";
import { z } from "zod";
import { isKnownType, typeCategory, isGrantableCategory } from "@starkeep/protocol-primitives";
import { declaredHandlerRoutes, publicPathRoutePath } from "./routes.js";

export interface ValidationResult {
  valid: boolean;
  manifest: AppManifest | null;
  errors: string[];
  warnings: string[];
  /** Distinct categories implied by the manifest's declared types. */
  impliedCategories: string[];
}

const RESERVED_PREFIX = "@starkeep/";

// Only the User-Data-Owner app (Starkeep Drive) may claim all-access.
const FILE_ACCESS_ALL_APP_ID = "starkeep-drive";

/**
 * One schema issue as an error line. An unknown key names the key and, when a
 * declared key at the same place is close, the key the author probably meant:
 * a misspelled optional field otherwise reads as a field left out (#137).
 */
function issueMessage(issue: z.ZodIssue): string {
  const where = issue.path.join(".");
  if (issue.code !== z.ZodIssueCode.unrecognized_keys) return `${where}: ${issue.message}`;
  const declared = declaredKeysAt(appManifestSchema, issue.path);
  const keys = issue.keys.map((key) => {
    const near = closestKey(key, declared);
    return near ? `"${key}" (did you mean "${near}"?)` : `"${key}"`;
  });
  const prefix = where ? `${where}: ` : "";
  return `${prefix}unknown ${keys.length === 1 ? "key" : "keys"} ${keys.join(", ")}`;
}

/** Strip the wrappers that do not change an object's keys. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  for (;;) {
    if (schema instanceof z.ZodDefault) schema = schema._def.innerType;
    else if (schema instanceof z.ZodOptional) schema = schema._def.innerType;
    else if (schema instanceof z.ZodEffects) schema = schema._def.schema;
    else return schema;
  }
}

/** The keys an object at `path` inside `schema` declares. */
function declaredKeysAt(schema: z.ZodTypeAny, path: (string | number)[]): string[] {
  let node = unwrap(schema);
  for (const segment of path) {
    if (node instanceof z.ZodArray && typeof segment === "number") node = unwrap(node.element);
    else if (node instanceof z.ZodObject && typeof segment === "string") {
      const child = (node.shape as Record<string, z.ZodTypeAny>)[segment];
      if (!child) return [];
      node = unwrap(child);
    } else return [];
  }
  // A union (a compute route, a shared resource) suggests from every member.
  const members =
    node instanceof z.ZodUnion || node instanceof z.ZodDiscriminatedUnion
      ? (node.options as z.ZodTypeAny[]).map(unwrap)
      : [node];
  return members.flatMap((m) => (m instanceof z.ZodObject ? Object.keys(m.shape) : []));
}

/** The declared key within two edits of `key`, ignoring case, if any. */
function closestKey(key: string, declared: string[]): string | null {
  let best: { key: string; distance: number } | null = null;
  for (const candidate of declared) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { key: candidate, distance };
  }
  return best?.key ?? null;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * Whether a `publicPaths` entry reaches no further than one of `allowed`. A
 * literal entry must be covered by an allowed entry; a wildcard entry must sit
 * inside an allowed wildcard, so `/_immutable/fonts/*` passes under
 * `/_immutable/*` and `/sign-in/*` does not pass under the literal `/sign-in`.
 */
function withinAllowed(entry: string, allowed: readonly string[]): boolean {
  if (!entry.endsWith("/*")) return allowed.some((a) => publicPathCovers(a, entry));
  const bare = entry.slice(0, -2);
  return allowed.some((a) => a.endsWith("/*") && publicPathCovers(a, bare));
}

const RETIRED_PUBLIC_MESSAGE =
  `auth "public" is retired. An app's own code may not answer a caller the platform has not ` +
  `checked. For a browser page, use auth "session" and list the page in publicPaths. For a ` +
  `program outside Starkeep, such as an MCP client, give the route auth "delegated": the user ` +
  `creates a token for it on the platform's consent page. An incoming webhook from a ` +
  `third-party service is not supported yet.`;

/**
 * Every place a manifest still says `auth: "public"`, named with the reason
 * and the replacement. Read from the raw manifest because the schema's own
 * refusal of a route-level value arrives as an opaque union mismatch.
 */
function retiredPublicAuth(raw: unknown): string[] {
  const handlers = (raw as { infraRequirements?: { compute?: { handlers?: unknown } } } | null)
    ?.infraRequirements?.compute?.handlers;
  if (!Array.isArray(handlers)) return [];
  const errors: string[] = [];
  handlers.forEach((handler: unknown, h) => {
    if (typeof handler !== "object" || handler === null) return;
    const { auth, routes } = handler as { auth?: unknown; routes?: unknown };
    const at = `infraRequirements.compute.handlers.${h}`;
    if (auth === "public") errors.push(`${at}.auth: ${RETIRED_PUBLIC_MESSAGE}`);
    if (!Array.isArray(routes)) return;
    routes.forEach((route: unknown, r) => {
      if (
        typeof route === "object" &&
        route !== null &&
        (route as { auth?: unknown }).auth === "public"
      ) {
        errors.push(`${at}.routes.${r}.auth: ${RETIRED_PUBLIC_MESSAGE}`);
      }
    });
  });
  return errors;
}

export function validateManifest(raw: unknown): ValidationResult {
  const retired = retiredPublicAuth(raw);
  if (retired.length > 0) {
    return { valid: false, manifest: null, errors: retired, warnings: [], impliedCategories: [] };
  }
  const result = appManifestSchema.safeParse(raw);
  const errors: string[] = [];
  const warnings: string[] = [];
  const impliedCategories = new Set<string>();

  if (!result.success) {
    return {
      valid: false,
      manifest: null,
      errors: result.error.issues.map(issueMessage),
      warnings: [],
      impliedCategories: [],
    };
  }

  const manifest = result.data;

  if (manifest.tier === "community" && manifest.id.startsWith(RESERVED_PREFIX)) {
    errors.push(`Community apps cannot use the "${RESERVED_PREFIX}" ID prefix`);
  }

  for (const entry of manifest.infraRequirements.fileAccess) {
    for (const type of entry.types) {
      if (!isKnownType(type)) {
        errors.push(
          `fileAccess: type "${type}" is not in the platform type registry. Apps may only declare known, mapped types; unmapped files belong to the Drive-only "other" category.`,
        );
        continue;
      }
      // `other/other` is a registered type but is the Drive-only catch-all:
      // ungrantable to installable apps. Reject it explicitly — `isKnownType`
      // alone would let it through (it's in the registry), re-opening the hole
      // the old extension map closed structurally (`other` was never mappable).
      if (!isGrantableCategory(typeCategory(type))) {
        errors.push(
          `fileAccess: type "${type}" is in the Drive-only "${typeCategory(type)}" category and cannot be granted to an installable app. Use fileAccessAll (Starkeep Drive only) for all-access.`,
        );
        continue;
      }
      impliedCategories.add(typeCategory(type));
    }

    if (entry.metadataWrite && entry.access === "readwrite") {
      warnings.push(
        `fileAccess[${entry.types.join(",")}]: metadataWrite is redundant when access is "readwrite"`,
      );
    }
  }

  // All-access is reserved to Starkeep Drive (the User-Data-Owner). It is the
  // only grant that reaches the `other` catch-all; installable apps enumerate
  // types instead.
  if (manifest.infraRequirements.fileAccessAll && manifest.id !== FILE_ACCESS_ALL_APP_ID) {
    errors.push(
      `infraRequirements.fileAccessAll may only be true for the "${FILE_ACCESS_ALL_APP_ID}" app (got "${manifest.id}")`,
    );
  }

  if (
    manifest.infraRequirements.compute.enabled &&
    manifest.infraRequirements.compute.handlers.length === 0
  ) {
    errors.push("infraRequirements.compute.enabled is true but no handlers are declared");
  }

  if (manifest.infraRequirements.brokerPower && manifest.id !== "cloud-data-server") {
    errors.push(
      `infraRequirements.brokerPower may only be true for the "cloud-data-server" app (got "${manifest.id}")`,
    );
  }

  // A public share lives in the cloud and is served by the cloud's anonymous
  // read path, whichever device creates it. A local-only app could declare it
  // and never use it, and the install dialog would still ask the person to
  // approve it.
  if (manifest.infraRequirements.publicSharing && !manifest.targets.includes("cloud")) {
    errors.push(
      'infraRequirements.publicSharing is true but targets omits "cloud" — public links ' +
        "are served by the cloud",
    );
  }

  // Label keys are the app's published schema, so a duplicate is a manifest
  // authoring mistake rather than something to silently dedup: the registry's
  // primary key is (app_id, key), so a second row would be dropped and the
  // second `description` — the one a reader of the cross-app registry sees —
  // would depend on insert order.
  const seenLabelKeys = new Set<string>();
  for (const entry of manifest.infraRequirements.labelKeys) {
    if (seenLabelKeys.has(entry.key)) {
      errors.push(`infraRequirements.labelKeys: duplicate key "${entry.key}"`);
    }
    seenLabelKeys.add(entry.key);
  }

  // --- Sign-in path ----------------------------------------------------
  //
  // The signed-out redirect at the edge sends every sessionless navigation
  // under /apps/<appId>/ to exactly `/sign-in` (the `signed-out-redirect`
  // CloudFront function in admin-installer's cloud-data-server program). The
  // path is fixed and the function does not read this manifest, so an app
  // with a session handler that leaves the path undeclared redirects every
  // signed-out visitor to a page the gateway then refuses. Nothing else
  // catches that before a person tries to sign in. The path is one per app,
  // so one handler declaring it is enough.
  const computeHandlers = manifest.infraRequirements.compute.handlers;
  const sessionHandler = computeHandlers.find((h) => h.auth === "session");
  if (
    sessionHandler &&
    sessionHandler.publicPaths.length > 0 &&
    !computeHandlers.some((h) => h.publicPaths.some((p) => publicPathCovers(p, SIGN_IN_PATH)))
  ) {
    errors.push(
      `infraRequirements.compute.handlers["${sessionHandler.name}"]: auth "session" needs ` +
        `"${SIGN_IN_PATH}" in "publicPaths". The platform sends every signed-out visitor to ` +
        `${SIGN_IN_PATH}, so without it nobody can sign in. Mount createSignInPage from ` +
        `@starkeep/app-client/auth there (docs/authoring-an-app.md, section "8. Sign-in").`,
    );
  }

  // --- Anonymous routes ------------------------------------------------
  //
  // No author can make a route anonymous. The schema refuses `auth: "public"`
  // (retired 2026-11-13, item K), and the only anonymous routes left are the
  // ones a `session` handler's `publicPaths` derive. Each entry becomes its
  // own unauthenticated route, more specific than the gated catch-all, so the
  // declaration is the reach. The rules below bound that reach to platform
  // pages and static files, so no app code ever runs for an anonymous caller:
  // an endpoint an app guarded itself, such as an MCP endpoint, would reopen
  // the 2026-08-23 exposure one route at a time. An outside client calls a
  // `delegated` route instead.
  for (const handler of manifest.infraRequirements.compute.handlers) {
    const where = `infraRequirements.compute.handlers["${handler.name}"]`;
    // What the manifest wrote down, before publicPaths derivation — needed to
    // tell an author's own override from a route the resolver synthesized.
    const declaredRoutes = declaredHandlerRoutes(handler);

    for (const route of declaredRoutes.filter((r) => r.auth === "delegated")) {
      // A delegated route hands an outside client's token to the app's code.
      // A catch-all would hand it every path the bundle mounts, including the
      // app's browser pages, so each delegated route names one path.
      if (route.catchAll) {
        errors.push(
          `${where}: route "${route.declared}" has auth "delegated" on a catch-all. Name the ` +
            `one path an outside client calls, such as "POST /mcp".`,
        );
      }
    }

    if (handler.publicPaths.length > 0 && handler.auth !== "session") {
      errors.push(
        `${where}: publicPaths needs auth "session". Under "${handler.auth}" no route is ` +
          `anonymous, so the declaration would mislead a reviewer.`,
      );
      continue;
    }

    if (handler.auth === "session" && handler.publicPaths.length === 0) {
      errors.push(
        `${where}: auth "session" gates every ` +
          `route on this handler, including the one that serves the sign-in page. Declare ` +
          `"publicPaths" with at least the shell and the session routes (e.g. ` +
          `["/", "/_immutable/*", "/sign-in", "/api/session/*"]), or nobody can sign in.`,
      );
      continue;
    }

    const seenPublicPaths = new Set<string>();
    for (const publicPath of handler.publicPaths) {
      if (seenPublicPaths.has(publicPath)) {
        errors.push(`${where}.publicPaths: duplicate entry "${publicPath}"`);
      }
      seenPublicPaths.add(publicPath);

      // A wildcard entry is not a declaration; it is the absence of one. Its
      // derived route is the catch-all itself, which un-gates every path the
      // bundle mounts.
      if (publicPathRoutePath(publicPath) === "/{proxy+}") {
        const gated = declaredRoutes.map((r) => `"${r.declared}"`);
        errors.push(
          `${where}.publicPaths: "${publicPath}" ` +
            `is a wildcard over the whole handler. It derives the route "ANY /{proxy+}" with no ` +
            `authorizer, so EVERY path under /apps/${manifest.id}/ becomes anonymous — ` +
            (gated.length > 0 ? `including ${gated.join(", ")}, which this handler gates — ` : ``) +
            `including any data proxy, upload route, or admin route the bundle mounts. List the ` +
            `paths that are meant to be anonymous instead (e.g. ["/", "/_immutable/*", ` +
            `"/sign-in", "/api/session/*"]).`,
        );
        continue;
      }

      // Only platform pages and the handler's own static files. Anything else
      // is app code answering an anonymous caller.
      if (
        !withinAllowed(publicPath, PLATFORM_PUBLIC_PATHS) &&
        !withinAllowed(publicPath, handler.staticAssetPaths)
      ) {
        errors.push(
          `${where}.publicPaths: "${publicPath}" is neither a platform page ` +
            `(${PLATFORM_PUBLIC_PATHS.join(", ")}) nor one of this handler's staticAssetPaths. ` +
            `An anonymous route may serve only those, so no app code runs for a caller the ` +
            `platform has not checked. For a program outside Starkeep, such as an MCP client, ` +
            `declare the route with auth "delegated": the user creates a token for it on the ` +
            `platform's consent page. An incoming webhook from a third-party service is not ` +
            `supported yet.`,
        );
      }

      // An entry must not silently override a route the manifest gated on
      // purpose. The derived public route replaces a declared route on the
      // same path, so an override sitting under a public path would be
      // quietly discarded, and the manifest would say two opposite things
      // about one path.
      const shadowed = declaredRoutes.find(
        (r) =>
          r.path === publicPathRoutePath(publicPath) &&
          r.auth !== "public" &&
          // Only an override the author wrote. Replacing a route that merely
          // inherited the handler's `session` default is the ordinary case —
          // it is how `GET /` becomes public when `/` is declared.
          r.authExplicit === true,
      );
      if (shadowed) {
        errors.push(
          `${where}.publicPaths: "${publicPath}" ` +
            `covers route "${shadowed.declared}", which the manifest declares as ` +
            `auth "${shadowed.auth}". Declaring a path public and gating it are contradictory; ` +
            `remove one.`,
        );
      }
    }
  }

  // Writing a label needs only a `read` grant on the record's type (requiring
  // readwrite would force an OCR service or a classifier to hold destructive
  // power over photos it only ever reads). But an app with no type grants at
  // all can never satisfy that check, so declared keys it could never write
  // are a manifest mistake worth naming at install time rather than a 403 the
  // author debugs later.
  if (
    manifest.infraRequirements.labelKeys.length > 0 &&
    manifest.infraRequirements.fileAccess.length === 0 &&
    !manifest.infraRequirements.fileAccessAll
  ) {
    errors.push(
      "infraRequirements.labelKeys declares keys but the app has no fileAccess grants — " +
        "labelling a record requires at least a read grant on its type, so none of " +
        "these keys could ever be written",
    );
  }

  // A mobile app syncs through the cloud, which holds its grants and its
  // private channel, and attests its key against the identity the cloud
  // install recorded. A local-only app has neither.
  const android = manifest.mobile?.android;
  if (android && !manifest.targets.includes("cloud")) {
    errors.push(
      'mobile.android is declared but targets omits "cloud" — a mobile build signs in ' +
        "and syncs through the app's cloud install",
    );
  }
  // The managed login page returns the code to this scheme. A web scheme
  // would send it to a browser page instead of the app.
  if (android && ["http", "https"].includes(android.callbackScheme)) {
    errors.push(`mobile.android.callbackScheme may not be "${android.callbackScheme}"`);
  }

  return {
    valid: errors.length === 0,
    manifest: errors.length === 0 ? manifest : null,
    errors,
    warnings,
    impliedCategories: [...impliedCategories],
  };
}
