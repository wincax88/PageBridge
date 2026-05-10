import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, type ServerSideEncryption } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class StorageService {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly serverSideEncryption?: ServerSideEncryption;
  private readonly sseKmsKeyId?: string;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>("S3_BUCKET") ?? "pagebridge";
    const serverSideEncryption = config.get<string>("S3_SERVER_SIDE_ENCRYPTION");
    this.serverSideEncryption = serverSideEncryption === "AES256" || serverSideEncryption === "aws:kms" ? serverSideEncryption : undefined;
    this.sseKmsKeyId = config.get<string>("S3_SSE_KMS_KEY_ID");
    this.client = new S3Client({
      endpoint: config.get<string>("S3_ENDPOINT"),
      region: config.get<string>("S3_REGION") ?? "us-east-1",
      forcePathStyle: config.get<string>("S3_FORCE_PATH_STYLE") === "true",
      credentials: {
        accessKeyId: config.get<string>("S3_ACCESS_KEY_ID") ?? "pagebridge",
        secretAccessKey: config.get<string>("S3_SECRET_ACCESS_KEY") ?? "pagebridge-secret"
      }
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

  async getPdf(storageKey: string) {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    const bytes = await object.Body?.transformToByteArray();
    return Buffer.from(bytes ?? []);
  }

  async getObjectMetadata(storageKey: string) {
    return this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }));
  }

  async deleteObject(storageKey: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
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
}
