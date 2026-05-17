import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Client as MinioClient } from "minio";
import type { BucketItem } from "minio/dist/main/internal/type";
import { Readable } from "stream";

@Injectable()
export class StorageService {
  private readonly bucket: string;
  private readonly client: MinioClient;
  private readonly presignClient: MinioClient;
  private readonly serverSideEncryption?: "AES256" | "aws:kms";
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
    const clientOptions = this.clientOptions(
      endpoint ?? "http://localhost:9000",
      this.getRequiredStorageConfig(config, "S3_ACCESS_KEY_ID", "pagebridge", isProduction),
      this.getRequiredStorageConfig(config, "S3_SECRET_ACCESS_KEY", "pagebridge-secret", isProduction),
      config.get<string>("S3_REGION") ?? "us-east-1"
    );
    this.client = new MinioClient(clientOptions);
    this.presignClient = new MinioClient(this.clientOptions(config.get<string>("S3_PUBLIC_ENDPOINT") || endpoint || "http://localhost:9000", clientOptions.accessKey, clientOptions.secretKey, clientOptions.region));
  }

  async putPdf(storageKey: string, body: Buffer, contentType = "application/pdf") {
    await this.client.putObject(this.bucket, storageKey, body, body.length, {
      "Content-Type": contentType,
      ...this.encryptionHeaders()
    });
  }

  createPresignedPutUrl(storageKey: string) {
    return this.client.presignedPutObject(this.bucket, storageKey, 10 * 60);
  }

  createPublicPresignedPutUrl(storageKey: string) {
    return this.presignClient.presignedPutObject(this.bucket, storageKey, 10 * 60);
  }

  getPresignedPutHeaders() {
    return {
      ...(this.serverSideEncryption ? { "x-amz-server-side-encryption": this.serverSideEncryption } : {}),
      ...(this.serverSideEncryption === "aws:kms" && this.sseKmsKeyId ? { "x-amz-server-side-encryption-aws-kms-key-id": this.sseKmsKeyId } : {})
    };
  }

  async getPdf(storageKey: string) {
    return this.streamToBuffer(await this.client.getObject(this.bucket, storageKey));
  }

  async getObjectMetadata(storageKey: string) {
    const stat = await this.client.statObject(this.bucket, storageKey);
    return { ContentLength: stat.size, ContentType: stat.metaData?.["content-type"] ?? stat.metaData?.["Content-Type"] };
  }

  async getObjectPrefix(storageKey: string, byteCount: number) {
    return this.streamToBuffer(await this.client.getPartialObject(this.bucket, storageKey, 0, byteCount));
  }

  async deleteObject(storageKey: string) {
    await this.client.removeObject(this.bucket, storageKey);
  }

  async listObjectKeys(prefix: string) {
    const objects: Array<{ key: string; lastModified?: Date }> = [];
    const stream = this.client.listObjectsV2(this.bucket, prefix, true);

    for await (const object of stream as AsyncIterable<BucketItem>) {
      if (object.name) objects.push({ key: object.name, lastModified: object.lastModified });
    }

    return objects;
  }

  buildUserFileKey(userId: string, fileId: string) {
    return `users/${userId}/files/${fileId}.pdf`;
  }

  private encryptionHeaders() {
    return {
      ...(this.serverSideEncryption ? { "x-amz-server-side-encryption": this.serverSideEncryption } : {}),
      ...(this.serverSideEncryption === "aws:kms" && this.sseKmsKeyId ? { "x-amz-server-side-encryption-aws-kms-key-id": this.sseKmsKeyId } : {})
    };
  }

  private clientOptions(endpoint: string, accessKey: string, secretKey: string, region: string) {
    const url = new URL(endpoint);
    return {
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      useSSL: url.protocol === "https:",
      accessKey,
      secretKey,
      region
    };
  }

  private streamToBuffer(stream: Readable) {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  private getRequiredStorageConfig(config: ConfigService, key: string, fallback: string, isProduction: boolean) {
    const value = config.get<string>(key);
    if (!value && isProduction) {
      throw new Error(`${key} must be configured in production`);
    }
    return value ?? fallback;
  }
}
