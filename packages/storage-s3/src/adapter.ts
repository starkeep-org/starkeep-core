import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type {
  PutOptions,
  GetResult,
  ListOptions,
  ListResult,
  SignedUrlOptions,
} from "@starkeep/storage-adapter";
import type { S3ObjectStorageAdapterOptions } from "./types.js";

const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;

export class S3ObjectStorageAdapter implements ObjectStorageAdapter {
  private readonly options: S3ObjectStorageAdapterOptions;
  private client: S3Client | null = null;

  constructor(options: S3ObjectStorageAdapterOptions) {
    this.options = options;
  }

  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        region: this.options.region,
        ...(this.options.credentials
          ? { credentials: this.options.credentials }
          : {}),
      });
    }
    return this.client;
  }

  private resolveKey(key: string): string {
    return `${this.options.keyPrefix ?? ""}${key}`;
  }

  async init(): Promise<void> {
    // No-op: S3 client is created lazily on first use
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.getClient().send(
        new HeadBucketCommand({ Bucket: this.options.bucketName }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async put(
    key: string,
    data: Buffer | Uint8Array,
    options?: PutOptions,
  ): Promise<void> {
    const resolvedKey = this.resolveKey(key);
    const contentType = options?.contentType;

    if (data.byteLength > MULTIPART_THRESHOLD_BYTES) {
      const upload = new Upload({
        client: this.getClient(),
        params: {
          Bucket: this.options.bucketName,
          Key: resolvedKey,
          Body: data,
          ...(contentType ? { ContentType: contentType } : {}),
        },
      });
      await upload.done();
    } else {
      await this.getClient().send(
        new PutObjectCommand({
          Bucket: this.options.bucketName,
          Key: resolvedKey,
          Body: data,
          ...(contentType ? { ContentType: contentType } : {}),
        }),
      );
    }
  }

  async get(key: string): Promise<GetResult | null> {
    try {
      const response = await this.getClient().send(
        new GetObjectCommand({
          Bucket: this.options.bucketName,
          Key: this.resolveKey(key),
        }),
      );

      if (!response.Body) {
        return null;
      }

      const byteArray = await response.Body.transformToByteArray();
      const buffer = Buffer.from(byteArray);

      return {
        data: buffer,
        contentType: response.ContentType,
        size: buffer.length,
      };
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.name === "NoSuchKey" || error.name === "NotFound")
      ) {
        return null;
      }
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.getClient().send(
        new HeadObjectCommand({
          Bucket: this.options.bucketName,
          Key: this.resolveKey(key),
        }),
      );
      return true;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.name === "NoSuchKey" || error.name === "NotFound")
      ) {
        return false;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.getClient().send(
      new DeleteObjectCommand({
        Bucket: this.options.bucketName,
        Key: this.resolveKey(key),
      }),
    );
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    const resolvedPrefix = this.resolveKey(prefix);
    const prefixOffset = (this.options.keyPrefix ?? "").length;

    const response = await this.getClient().send(
      new ListObjectsV2Command({
        Bucket: this.options.bucketName,
        Prefix: resolvedPrefix,
        MaxKeys: options?.limit,
        ContinuationToken: options?.cursor ?? undefined,
      }),
    );

    const keys = (response.Contents ?? []).map(
      (object) => (object.Key ?? "").slice(prefixOffset),
    );

    return {
      keys,
      nextCursor: response.NextContinuationToken ?? null,
      hasMore: response.IsTruncated ?? false,
    };
  }

  async getSignedUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<string> {
    const expiresInSeconds = options?.expiresIn ?? 3600;
    const command = new GetObjectCommand({
      Bucket: this.options.bucketName,
      Key: this.resolveKey(key),
    });

    return awsGetSignedUrl(this.getClient(), command, {
      expiresIn: expiresInSeconds,
    });
  }
}
