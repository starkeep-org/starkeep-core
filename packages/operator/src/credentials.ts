/**
 * Temporary AWS credentials as admin-web's browser half and its routes pass
 * them: `expiration` stays the ISO string it came off the wire as.
 * admin-installer's `AwsCredentials` carries a `Date` instead.
 */
export interface STSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}
