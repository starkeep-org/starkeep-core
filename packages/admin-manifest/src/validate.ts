import type { AppManifest } from "./schema.js";
import { appManifestSchema } from "./schema.js";
import { isKnownType, typeCategory } from "@starkeep/protocol-primitives";
import { matchRoute, probePathFor, resolveHandlerRoutes } from "./routes.js";

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

export function validateManifest(raw: unknown): ValidationResult {
  const result = appManifestSchema.safeParse(raw);
  const errors: string[] = [];
  const warnings: string[] = [];
  const impliedCategories = new Set<string>();

  if (!result.success) {
    return {
      valid: false,
      manifest: null,
      errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
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
      if (typeCategory(type) === "other") {
        errors.push(
          `fileAccess: type "${type}" is the Drive-only "other" catch-all and cannot be granted to an installable app. Use fileAccessAll (Starkeep Drive only) for all-access.`,
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
  if (
    manifest.infraRequirements.fileAccessAll &&
    manifest.id !== FILE_ACCESS_ALL_APP_ID
  ) {
    errors.push(
      `infraRequirements.fileAccessAll may only be true for the "${FILE_ACCESS_ALL_APP_ID}" app (got "${manifest.id}")`,
    );
  }

  if (
    manifest.infraRequirements.compute.enabled &&
    manifest.infraRequirements.compute.handlers.length === 0
  ) {
    errors.push(
      "infraRequirements.compute.enabled is true but no handlers are declared",
    );
  }

  if (manifest.infraRequirements.brokerPower && manifest.id !== "cloud-data-server") {
    errors.push(
      `infraRequirements.brokerPower may only be true for the "cloud-data-server" app (got "${manifest.id}")`,
    );
  }

  // Label keys are the app's published schema, so a duplicate is a manifest
  // authoring mistake rather than something to silently dedup: the registry's
  // primary key is (app_id, key), so a second row would be dropped and the
  // second `description` — the one a reader of the cross-app registry sees —
  // would depend on insert order.
  const seenLabelKeys = new Set<string>();
  const sizeClassKeys: string[] = [];
  for (const entry of manifest.infraRequirements.labelKeys) {
    if (seenLabelKeys.has(entry.key)) {
      errors.push(`infraRequirements.labelKeys: duplicate key "${entry.key}"`);
    }
    seenLabelKeys.add(entry.key);
    if (entry.sizeClass) sizeClassKeys.push(entry.key);
  }

  // One ladder per app. A second key would leave the node choosing between two
  // answers to "which rung is this", and whichever it picked would decide the
  // record's budget row and whether it counts as re-derivable — so the ambiguity
  // is refused at install time rather than resolved by iteration order.
  if (sizeClassKeys.length > 1) {
    errors.push(
      `infraRequirements.labelKeys: at most one key may set sizeClass: true (got ${sizeClassKeys
        .map((k) => `"${k}"`)
        .join(", ")})`,
    );
  }

  // --- Anonymous routes ------------------------------------------------
  //
  // `auth: "public"` removes the Cognito authorizer from a gateway route. On a
  // catch-all that is the entire app, including whatever server routes the
  // bundle happens to mount — which is how the signing proxy at
  // /api/local-data ended up answering the internet (postmortem 2026-08-23,
  // root causes 3.1 and 3.4). The opt-out is still available, because a
  // browser navigating to a URL cannot send a bearer token and the HTML shell
  // has to be reachable. What it now costs is a `publicPaths` declaration
  // naming the subpaths the opt-out was *for*, checked against the handler's
  // real route table so it cannot name something the handler does not serve.
  for (const handler of manifest.infraRequirements.compute.handlers) {
    const routes = resolveHandlerRoutes(handler);
    const anonymous = routes.filter((r) => r.auth === "public");
    const anonymousCatchAll = anonymous.filter((r) => r.catchAll);

    if (anonymous.length === 0 && handler.publicPaths.length > 0) {
      errors.push(
        `infraRequirements.compute.handlers["${handler.name}"]: publicPaths is declared but ` +
          `no route on this handler is anonymous — every route carries the JWT authorizer, ` +
          `so nothing here is public and the declaration would mislead a reviewer`,
      );
      continue;
    }

    if (anonymousCatchAll.length > 0 && handler.publicPaths.length === 0) {
      errors.push(
        `infraRequirements.compute.handlers["${handler.name}"]: route ` +
          `"${anonymousCatchAll[0]!.declared}" is a catch-all with auth "public", which makes ` +
          `EVERY path under /apps/${manifest.id}/ reachable without authentication — including ` +
          `any data proxy, upload route, or admin route the bundle mounts. Declare ` +
          `"publicPaths" listing the subpaths that are meant to be anonymous (e.g. ` +
          `["/", "/_next/static/*"]), and give the rest an authenticated route ` +
          `(a more specific route with auth "jwt" wins over {proxy+} at the gateway) or ` +
          `enforce the end user in the handler itself.`,
      );
    }

    const seenPublicPaths = new Set<string>();
    for (const publicPath of handler.publicPaths) {
      if (seenPublicPaths.has(publicPath)) {
        errors.push(
          `infraRequirements.compute.handlers["${handler.name}"].publicPaths: duplicate entry ` +
            `"${publicPath}"`,
        );
      }
      seenPublicPaths.add(publicPath);

      // The declaration is only worth anything if it describes the routes that
      // actually exist. A path served by no route, or by a route that carries
      // the authorizer, is an author mistake — most likely a stale entry left
      // behind after the route table changed.
      const selected = matchRoute(routes, "GET", probePathFor(publicPath));
      if (!selected) {
        errors.push(
          `infraRequirements.compute.handlers["${handler.name}"].publicPaths: "${publicPath}" is ` +
            `not served by any route on this handler`,
        );
        continue;
      }
      if (selected.auth !== "public") {
        errors.push(
          `infraRequirements.compute.handlers["${handler.name}"].publicPaths: "${publicPath}" is ` +
            `declared public but the gateway routes it to "${selected.declared}", which requires ` +
            `authentication`,
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

  return {
    valid: errors.length === 0,
    manifest: errors.length === 0 ? manifest : null,
    errors,
    warnings,
    impliedCategories: [...impliedCategories],
  };
}

