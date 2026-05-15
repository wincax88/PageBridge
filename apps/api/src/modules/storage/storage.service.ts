import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type ServerSideEncryption } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class StorageService {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly serverSideEncryption?: ServerSideEncryption;
  private readonly sseKmsKeyId?: string;

  constructor(config: ConfigService) {
    const isProduction = process.env.NODE_ENV === "production";
    this.bucket = this.getRequiredStorageConfig(config, "S3_BUCKET", "pagebridge", isProduction);
    const endpoint = config.get<string>("S3_ENDPOINT");
    if (!endpoint && isProduction) {
      throw new Error("S3_ENDPOINT must be configured in production");
    }
    const serverSideEncryption = config.get<string>("S3_SERVER_SIDE_ENCRYPTION");
    this.serverSideEncryption = serverSideEncryption === "AES256" || serverSideEncryption === "aws:kms" ? serverSideEncryption : undefined;
    this.sseKmsKeyId = config.get<string>("S3_SSE_KMS_KEY_ID");
    const clientOptions = {
      endpoint,
      region: config.get<string>("S3_REGION") ?? "us-east-1",
      forcePathStyle: config.get<string>("S3_FORCE_PATH_STYLE") === "true",
      credentials: {
        accessKeyId: this.getRequiredStorageConfig(config, "S3_ACCESS_KEY_ID", "pagebridge", isProduction),
        secretAccessKey: this.getRequiredStorageConfig(config, "S3_SECRET_ACCESS_KEY", "pagebridge-secret", isProduction)
      }
    };
    this.client = new S3Client(clientOptions);
    this.presignClient = new S3Client({
      ...clientOptions,
      endpoint: config.get<string>("S3_PUBLIC_ENDPOINT") || clientOptions.endpoint
    });
  }

  async putPdf(storageKey: string, body: Buffer, contentType = "application/pdf") {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: body,
        ContentType: contentType,
        ...this.encryptionOptions()
      })
    );
  }

  createPresignedPutUrl(storageKey: string, contentType = "application/pdf") {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, ContentType: contentType, ...this.encryptionOptions() }),
      { expiresIn: 10 * 60 }
    );
  }

  createPublicPresignedPutUrl(storageKey: string, contentType = "application/pdf") {
    return getSignedUrl(
      this.presignClient,
      new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, ContentType: contentType, ...this.encryptionOptions() }),
      { expiresIn: 10 * 60 }
    );
  }

  getPresignedPutHeaders(contentType = "application/pdf") {
    return {
      "Content-Type": contentType,
      ...(this.serverSideEncryption ? { "x-amz-server-side-encryption": this.serverSideEncryption } : {}),
      ...(this.serverSideEncryption === "aws:kms" && this.sseKmsKeyId ? { "x-amz-server-side-encryption-aws-kms-key-id": this.sseKmsKeyId } : {})
    };
  }

  async getPdf(storageKey: string) {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    const bytes = await object.Body?.transformToByteArray();
    return Buffer.from(bytes ?? []);
  }

  async getObjectMetadata(storageKey: string) {
    return this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }));
  }

  async getObjectPrefix(storageKey: string, byteCount: number) {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey, Range: `bytes=0-${Math.max(0, byteCount - 1)}` }));
    const bytes = await object.Body?.transformToByteArray();
    return Buffer.from(bytes ?? []);
  }

  async deleteObject(storageKey: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
  }

  async listObjectKeys(prefix: string) {
    const objects: Array<{ key: string; lastModified?: Date }> = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken }));
      for (const object of response.Contents ?? []) {
        if (object.Key) objects.push({ key: object.Key, lastModified: object.LastModified });
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return objects;
  }

  buildUserFileKey(userId: string, fileId: string) {
    return `users/${userId}/files/${fileId}.pdf`;
  }

  private encryptionOptions() {
    return {
      ...(this.serverSideEncryption ? { ServerSideEncryption: this.serverSideEncryption } : {}),
      ...(this.serverSideEncryption === "aws:kms" && this.sseKmsKeyId ? { SSEKMSKeyId: this.sseKmsKeyId } : {})
    };
  }

  private getRequiredStorageConfig(config: ConfigService, key: string, fallback: string, isProduction: boolean) {
    const value = config.get<string>(key);
    if (!value && isProduction) {
      throw new Error(`${key} must be configured in production`);
    }
    return value ?? fallback;
  }
}
