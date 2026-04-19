export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface S3ObjectStorageAdapterOptions {
  readonly bucketName: string;
  readonly region: string;
  readonly keyPrefix?: string;
  /**
   * Static credentials. Use this for long-lived access keys.
   * For short-lived STS credentials that rotate, use `credentialProvider` instead.
   */
  readonly credentials?: S3Credentials;
  /**
   * Dynamic credential provider. Called before each S3Client instantiation
   * so that rotating STS credentials (e.g. from a Cognito Identity Pool) are
   * always fresh. Takes precedence over `credentials` when both are provided.
   */
  readonly credentialProvider?: () => Promise<S3Credentials>;
}
