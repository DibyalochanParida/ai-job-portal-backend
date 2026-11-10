import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../../config.js";
import type { StorageDriver } from "./index.js";

/**
 * AWS S3 storage. Credentials come from the default AWS provider chain (ECS task role in
 * production, env vars or ~/.aws locally). S3_ENDPOINT allows MinIO/LocalStack in dev.
 */
export class S3Storage implements StorageDriver {
  readonly name = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    if (!config.storage.s3Bucket) throw new Error("S3_BUCKET is required for the s3 storage driver");
    this.bucket = config.storage.s3Bucket;
    this.client = new S3Client({
      region: config.storage.awsRegion,
      endpoint: config.storage.s3Endpoint,
      forcePathStyle: config.storage.s3ForcePathStyle,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async getDownloadUrl(key: string, fileName: string, expiresInSeconds = 300): Promise<string> {
    const safeName = fileName.replace(/[^\w.\- ]/g, "_");
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
