/**
 * @starkeep/infra-core
 *
 * Typed contract for the Starkeep core infrastructure stack outputs.
 * Import this in app `sst.config.ts` files to get typed access to the
 * shared DSQL cluster and S3 bucket injected by the admin layer.
 */

/**
 * Outputs produced by the core Starkeep SST stack.
 * App stacks receive these as SST secrets and should type them with this interface.
 */
export interface StarkeepCoreOutputs {
  /** Aurora DSQL cluster endpoint hostname. */
  readonly auroraHostname: string;
  /** S3 bucket name for the shared object store. */
  readonly bucketName: string;
  /** AWS region in which the core resources are deployed. */
  readonly region: string;
}

/**
 * Well-known system record types used by Starkeep internals.
 * Only the admin layer (owner subject) may write records of these types.
 */
export const SYSTEM_RECORD_TYPES = {
  ACCESS_POLICY: "@starkeep/access-policy",
  SHARING_TOKEN: "@starkeep/sharing-token",
  TYPE_REGISTRATION: "@starkeep/type-registration",
  APP_KEYPAIR: "@starkeep/app-keypair",
  APP_REGISTRY: "@starkeep/app-registry",
} as const;

export type SystemRecordType = (typeof SYSTEM_RECORD_TYPES)[keyof typeof SYSTEM_RECORD_TYPES];
