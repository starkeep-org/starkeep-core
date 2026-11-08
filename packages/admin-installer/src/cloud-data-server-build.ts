/**
 * Which build of the cloud data server the cloud runs.
 *
 * The bundle's zip cannot answer the question: `zip` stores file times, so two
 * builds of the same source give two different zip hashes. `build.mjs`
 * instead writes `build-info.json` beside `dist.zip`, holding a SHA-256 of
 * the bundled JavaScript, the commit it was built from and whether the tree
 * had uncommitted changes.
 *
 * Each cloud data server install copies that record to an SSM parameter under
 * the platform prefix, as Manager, which already writes the deployment's
 * settings there. admin-web reads it back through the same Manager hop and
 * compares it with this checkout's build. The record stays off the public
 * `/health` route, because a commit on a public route tells an attacker which
 * known bugs apply.
 *
 * A subpath of its own, so that admin-web can import it without the Pulumi
 * graph that `builtin-installs.ts` pulls in.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { platformParameterPrefix, type AwsCredentials } from "./app-creds";

export interface CloudDataServerBuild {
  /** Hex SHA-256 over the bundled JavaScript files, in `build.mjs`'s order. */
  readonly bundleSha256: string;
  /** The commit the bundle was built from, or null outside a git checkout. */
  readonly commit: string | null;
  /** Whether the tree held uncommitted changes when the bundle was built. */
  readonly dirty: boolean;
}

export function cloudDataServerBuildParameterName(stackPrefix: string): string {
  return `${platformParameterPrefix(stackPrefix)}/cloud-data-server-build`;
}

/** The record's fields, or null for anything that is not a build record. */
export function parseCloudDataServerBuild(value: unknown): CloudDataServerBuild | null {
  if (typeof value !== "object" || value === null) return null;
  const { bundleSha256, commit, dirty } = value as Record<string, unknown>;
  if (typeof bundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(bundleSha256)) return null;
  if (commit !== null && typeof commit !== "string") return null;
  if (typeof dirty !== "boolean") return null;
  return { bundleSha256, commit, dirty };
}

const packageDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "builtin-apps",
  "cloud-data-server",
);

/** The record of this checkout's last cloud data server build, or null before the first build. */
export function readLocalCloudDataServerBuild(): CloudDataServerBuild | null {
  const path = join(packageDir, "build-info.json");
  if (!existsSync(path)) return null;
  try {
    return parseCloudDataServerBuild(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function ssmClient(region: string, awsCreds: AwsCredentials): SSMClient {
  return new SSMClient({
    region,
    credentials: {
      accessKeyId: awsCreds.accessKeyId,
      secretAccessKey: awsCreds.secretAccessKey,
      sessionToken: awsCreds.sessionToken,
    },
  });
}

/** Record the build the cloud now runs. Manager credentials. */
export async function putCloudDataServerBuildParameter(opts: {
  stackPrefix: string;
  build: CloudDataServerBuild;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<void> {
  await ssmClient(opts.region, opts.awsCreds).send(
    new PutParameterCommand({
      Name: cloudDataServerBuildParameterName(opts.stackPrefix),
      Type: "String",
      Value: JSON.stringify(opts.build),
      Overwrite: true,
      Description:
        "The cloud data server build the cloud runs. Written by the installer as Manager.",
    }),
  );
}

/**
 * The build the cloud runs, or null when no install has recorded one, as for
 * a deployment installed before the record existed. Manager credentials.
 */
export async function getCloudDataServerBuildParameter(opts: {
  stackPrefix: string;
  region: string;
  awsCreds: AwsCredentials;
}): Promise<CloudDataServerBuild | null> {
  try {
    const result = await ssmClient(opts.region, opts.awsCreds).send(
      new GetParameterCommand({ Name: cloudDataServerBuildParameterName(opts.stackPrefix) }),
    );
    const raw = result.Parameter?.Value;
    return raw ? parseCloudDataServerBuild(JSON.parse(raw)) : null;
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}

/**
 * How the cloud's build compares with this checkout's.
 *
 * - `not-recorded`: no install has recorded a build. A redeploy records one.
 * - `no-local-build`: this checkout has never built the bundle.
 * - `local-build-stale`: the checkout has moved since its last build, so the
 *   comparison would use an old bundle. A rebuild settles it, and needs no
 *   redeploy when the new bundle matches the cloud's.
 * - `match`: the cloud runs this checkout's build.
 * - `differs`: the cloud runs other code. A redeploy updates it.
 */
export type CloudBuildComparison =
  | "not-recorded"
  | "no-local-build"
  | "local-build-stale"
  | "match"
  | "differs";

export function compareCloudDataServerBuild(opts: {
  cloud: CloudDataServerBuild | null;
  local: CloudDataServerBuild | null;
  /** The checkout's current commit, or null outside a git checkout. */
  head: string | null;
}): CloudBuildComparison {
  if (!opts.cloud) return "not-recorded";
  if (!opts.local) return "no-local-build";
  if (opts.head !== null && opts.local.commit !== opts.head) return "local-build-stale";
  return opts.local.bundleSha256 === opts.cloud.bundleSha256 ? "match" : "differs";
}
