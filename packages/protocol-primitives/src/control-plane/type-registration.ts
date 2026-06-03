import type { HLCTimestamp } from "../hlc/types.js";

/**
 * A type registration declares that some app handles records of a given
 * type. Stored in the per-instance `type_registrations` table (control plane;
 * never synced between local and cloud). Each side re-bootstraps its own
 * registrations idempotently on startup.
 */
export interface TypeRegistration {
  /** Global type identifier, e.g. "@photos/image". Primary key. */
  readonly typeId: string;
  /** JSON Schema for the typed payload (not enforced today, retained for tooling). */
  readonly schema: object;
  /** Semver-ish version string; bump on schema changes. */
  readonly schemaVersion: string;
  /** Human-readable description for tooling / introspection. */
  readonly description: string;
  /** Provenance: which app installed this registration. */
  readonly registeredByAppId: string;
  readonly registeredAt: HLCTimestamp;
}

export interface TypeRegistrationStore {
  put(registration: TypeRegistration): Promise<void>;
  get(typeId: string): Promise<TypeRegistration | null>;
  list(): Promise<TypeRegistration[]>;
  delete(typeId: string): Promise<void>;
}
