import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export interface UploadTemplateInput {
  customerId: string;
  templateName: string;
  templateContent: string;
  bucketName: string;
  region?: string;
}

export interface UploadTemplateResult {
  bucket: string;
  key: string;
  url: string;
}

/**
 * Upload a CloudFormation template to S3 for a specific customer
 * Templates are stored in customer-specific paths: customer-{customerId}/templates/{templateName}.yaml
 */
export async function uploadTemplate(input: UploadTemplateInput): Promise<UploadTemplateResult> {
  // Always upload to the bucket's region (us-east-1), not the deployment target region
  const bucketRegion = process.env.ARTIFACTS_BUCKET_REGION || "us-east-1";
  const s3Client = new S3Client({
    region: bucketRegion,
  });

  // Generate S3 key with customer-specific prefix
  const key = `customer-${input.customerId}/templates/${input.templateName}.yaml`;

  const command = new PutObjectCommand({
    Bucket: input.bucketName,
    Key: key,
    Body: input.templateContent,
    ContentType: "application/x-yaml",
    // Note: Bucket is configured as public via bucket policy (see sst.config.ts)
  });

  await s3Client.send(command);

  const url = `https://${input.bucketName}.s3.${bucketRegion}.amazonaws.com/${key}`;

  return {
    bucket: input.bucketName,
    key,
    url,
  };
}

/**
 * Generate the S3 URL for a template without uploading
 */
export function getTemplateUrl(bucketName: string, key: string): string {
  const bucketRegion = process.env.ARTIFACTS_BUCKET_REGION || "us-east-1";
  return `https://${bucketName}.s3.${bucketRegion}.amazonaws.com/${key}`;
}

/**
 * Generate the customer-specific S3 key for a template
 */
export function getTemplateKey(customerId: string, templateName: string): string {
  return `customer-${customerId}/templates/${templateName}.yaml`;
}
