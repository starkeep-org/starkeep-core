export interface S3ObjectStorageAdapterOptions {
  readonly bucketName: string;
  readonly region: string;
  readonly keyPrefix?: string;
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
}
