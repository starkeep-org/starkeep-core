/**
 * Build a Pulumi stack name for a user-specific stack.
 *
 * Convention: `${projectName}-user-${userId}`
 */
export function buildStackName(
  projectName: string,
  userId: string,
): string {
  return `${projectName}-user-${userId}`;
}

/**
 * Build a valid S3 bucket name for a user.
 *
 * S3 bucket names must be lowercase, may contain hyphens, and must be
 * between 3 and 63 characters.
 */
export function buildBucketName(
  projectName: string,
  userId: string,
): string {
  const rawName = `${projectName}-${userId}-data`;
  return rawName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * Build an Aurora cluster identifier for a user.
 *
 * Cluster identifiers must be lowercase, may contain hyphens, and must
 * start with a letter.
 */
export function buildClusterIdentifier(
  projectName: string,
  userId: string,
): string {
  const rawIdentifier = `${projectName}-${userId}-cluster`;
  return rawIdentifier.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * Parse a stack name back into its component parts.
 *
 * Returns `null` if the stack name does not match the expected format.
 */
export function parseStackName(
  stackName: string,
): { projectName: string; userId: string } | null {
  const separator = "-user-";
  const separatorIndex = stackName.indexOf(separator);

  if (separatorIndex === -1) {
    return null;
  }

  const projectName = stackName.slice(0, separatorIndex);
  const userId = stackName.slice(separatorIndex + separator.length);

  if (projectName.length === 0 || userId.length === 0) {
    return null;
  }

  return { projectName, userId };
}
