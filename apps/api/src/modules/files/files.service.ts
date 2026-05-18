import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { StorageService } from "../storage/storage.service";

interface CompleteUploadInput {
  fileId: string;
  name: string;
  sizeBytes: number;
  storageKey: string;
}

const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;
const FREE_USER_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;
const FREE_USER_FILE_COUNT_QUOTA = 500;
const SOFT_DELETE_RETENTION_DAYS = 30;
const ORPHAN_UPLOAD_RETENTION_MS = 60 * 60 * 1000;
const TRANSACTION_RETRY_ATTEMPTS = 3;
const DJVU_MIME_TYPE = "image/vnd.djvu";
const SUPPORTED_DJVU_MIME_TYPES = [DJVU_MIME_TYPE, "image/x-djvu", "image/djvu"];

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService
  ) {}

  async list(userId: string) {
    await this.purgeExpiredDeletedFiles(userId);
    const files = await this.prisma.file.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, sizeBytes: true, mimeType: true, pageCount: true, isFavorite: true, updatedAt: true }
    });
    return files.map((file) => ({ ...file, sizeBytes: file.sizeBytes.toString() }));
  }

  async listDeleted(userId: string) {
    await this.purgeExpiredDeletedFiles(userId);
    const files = await this.prisma.file.findMany({
      where: { userId, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      select: { id: true, name: true, sizeBytes: true, mimeType: true, pageCount: true, isFavorite: true, updatedAt: true, deletedAt: true }
    });
    return files.map((file) => ({ ...file, sizeBytes: file.sizeBytes.toString() }));
  }

  async usage(userId: string) {
    await this.purgeExpiredDeletedFiles(userId);
    const aggregate = await this.prisma.file.aggregate({
      where: { userId, deletedAt: null },
      _sum: { sizeBytes: true },
      _count: { id: true }
    });
    const usedBytes = aggregate._sum.sizeBytes ?? BigInt(0);

    return {
      usedBytes: usedBytes.toString(),
      quotaBytes: FREE_USER_STORAGE_QUOTA_BYTES.toString(),
      fileCount: aggregate._count.id,
      fileCountQuota: FREE_USER_FILE_COUNT_QUOTA
    };
  }

  async upload(userId: string, file: Express.Multer.File, preferredName?: string) {
    await this.purgeExpiredDeletedFiles(userId);
    await this.redis.limit(`rate:upload:${userId}`, 30, 60 * 60);
    if (!file) throw new BadRequestException("Document file is required");
    const name = this.normalizeFileName(this.resolveUploadFileName(preferredName, file.originalname));
    const documentType = this.detectDocumentType(file, name);
    this.validateUploadSize(file.size);
    this.ensureDocumentHeader(file.buffer, documentType);

    const fileId = randomUUID();
    const storageKey = this.storage.buildUserFileKey(userId, fileId, this.storageExtension(documentType));
    await this.storage.putDocument(storageKey, file.buffer, documentType);

    try {
      const created = await this.runSerializableTransaction(async (tx) => {
        await this.ensureFileCountQuota(userId, tx);
        await this.ensureStorageQuota(userId, file.size, tx);
        const uploaded = await tx.file.create({
          data: {
            id: fileId,
            userId,
            name,
            sizeBytes: BigInt(file.size),
            mimeType: documentType,
            storageKey
          }
        });
        await this.recordChange(userId, uploaded.id, "create", uploaded.id, { name: uploaded.name, sizeBytes: uploaded.sizeBytes.toString() }, tx);
        return uploaded;
      });

      return { ...created, sizeBytes: created.sizeBytes.toString() };
    } catch (error) {
      await this.deleteObjectBestEffort(storageKey);
      throw error;
    }
  }

  async createUploadTarget(userId: string, name: string, sizeBytes: number) {
    await this.purgeExpiredDeletedFiles(userId);
    await this.redis.limit(`rate:upload:${userId}`, 30, 60 * 60);
    await this.maybePurgeOrphanUploadedObjects(userId);
    const normalizedName = this.normalizeFileName(name);
    if (!normalizedName.toLowerCase().endsWith(".pdf")) throw new BadRequestException("Presigned uploads currently support PDF files only");
    this.validateUploadSize(sizeBytes);
    await this.ensureFileCountQuota(userId);
    await this.ensureStorageQuota(userId, sizeBytes);

    const fileId = randomUUID();
    const storageKey = this.storage.buildUserFileKey(userId, fileId);
    return {
      fileId,
      name: normalizedName,
      storageKey,
      uploadUrl: await this.storage.createPublicPresignedPutUrl(storageKey),
      uploadHeaders: this.storage.getPresignedPutHeaders()
    };
  }

  async completeUpload(userId: string, input: CompleteUploadInput) {
    const name = this.normalizeFileName(input.name);
    this.validateUploadSize(input.sizeBytes);
    const expectedStorageKey = this.storage.buildUserFileKey(userId, input.fileId);
    if (!input.fileId || input.storageKey !== expectedStorageKey) throw new BadRequestException("Upload target is invalid");
    await this.ensureUploadedObject(input.storageKey, input.sizeBytes);
    await this.ensureUploadedPdfHeader(input.storageKey);
    const result = await this.runSerializableTransaction(async (tx) => {
      const existingFile = await tx.file.findFirst({ where: { id: input.fileId, userId } });
      if (existingFile) {
        if (existingFile.deletedAt) throw new BadRequestException("Upload target is invalid");
        if (existingFile.storageKey !== input.storageKey || existingFile.sizeBytes !== BigInt(input.sizeBytes)) throw new BadRequestException("Upload target is invalid");
        return { file: existingFile, created: false };
      }
      await this.ensureFileCountQuota(userId, tx);
      await this.ensureStorageQuota(userId, input.sizeBytes, tx);
      const completed = await this.createCompletedUpload(userId, input.fileId, name, input.sizeBytes, input.storageKey, tx);
      if (completed.created) await this.recordChange(userId, completed.file.id, "create", completed.file.id, { name: completed.file.name, sizeBytes: completed.file.sizeBytes.toString() }, tx);
      return completed;
    });
    return { ...result.file, sizeBytes: result.file.sizeBytes.toString() };
  }

  async getContent(userId: string, fileId: string) {
    const file = await this.ensureFile(userId, fileId);
    return { name: file.name, mimeType: file.mimeType, buffer: await this.storage.getPdf(file.storageKey) };
  }

  async rename(userId: string, fileId: string, name: string) {
    const normalizedName = this.normalizeFileName(name);
    const current = await this.ensureFile(userId, fileId);
    if (current.name === normalizedName) return { ...current, sizeBytes: current.sizeBytes.toString() };

    const file = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.file.update({ where: { id: fileId }, data: { name: normalizedName } });
      await this.recordChange(userId, fileId, "update", fileId, { name: normalizedName }, tx);
      return updated;
    });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async updatePageCount(userId: string, fileId: string, pageCount: number) {
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new BadRequestException("Page count is invalid");

    const current = await this.ensureFile(userId, fileId);
    if (current.pageCount === pageCount) return { ...current, sizeBytes: current.sizeBytes.toString() };

    const file = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.file.update({ where: { id: fileId }, data: { pageCount } });
      await this.recordChange(userId, fileId, "update", fileId, { pageCount }, tx);
      return updated;
    });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async updateFavorite(userId: string, fileId: string, isFavorite: boolean) {
    const current = await this.ensureFile(userId, fileId);
    if (current.isFavorite === isFavorite) return { ...current, sizeBytes: current.sizeBytes.toString() };

    const file = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.file.update({ where: { id: fileId }, data: { isFavorite } });
      await this.recordChange(userId, fileId, "update", fileId, { isFavorite }, tx);
      return updated;
    });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async softDelete(userId: string, fileId: string) {
    const current = await this.prisma.file.findFirst({ where: { id: fileId, userId } });
    if (!current) throw new NotFoundException("File not found");
    if (current.deletedAt) return { ...current, sizeBytes: current.sizeBytes.toString() };

    const file = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.file.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
      await this.recordChange(userId, fileId, "delete", fileId, { deletedAt: deleted.deletedAt?.toISOString() }, tx);
      return deleted;
    });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async restore(userId: string, fileId: string) {
    const file = await this.runSerializableTransaction(async (tx) => {
      const deletedFile = await this.ensureDeletedFile(userId, fileId, tx);
      await this.ensureFileCountQuota(userId, tx);
      await this.ensureStorageQuota(userId, Number(deletedFile.sizeBytes), tx);
      const restored = await tx.file.update({ where: { id: fileId }, data: { deletedAt: null } });
      await this.recordChange(userId, fileId, "update", fileId, { deletedAt: null }, tx);
      return restored;
    });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async permanentlyDelete(userId: string, fileId: string) {
    const file = await this.ensureDeletedFile(userId, fileId);
    await this.deleteStoredFile(file.id, file.storageKey);
    return { ok: true };
  }

  async emptyTrash(userId: string) {
    const deletedFiles = await this.prisma.file.findMany({
      where: { userId, deletedAt: { not: null } },
      select: { id: true, storageKey: true }
    });

    for (const file of deletedFiles) {
      await this.deleteStoredFile(file.id, file.storageKey);
    }

    return { ok: true, deletedCount: deletedFiles.length };
  }

  private async recordChange(userId: string, fileId: string, operation: "create" | "update" | "delete", entityId: string, payload: unknown, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    await db.syncChange.create({
      data: {
        userId,
        fileId,
        entityType: "file",
        entityId,
        operation,
        clientRequestId: randomUUID(),
        payload: payload as never
      }
    });
  }

  private async ensureFile(userId: string, fileId: string) {
    const file = await this.prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: null } });
    if (!file) throw new NotFoundException("File not found");
    return file;
  }

  private async ensureDeletedFile(userId: string, fileId: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const file = await db.file.findFirst({ where: { id: fileId, userId, deletedAt: { not: null } } });
    if (!file) throw new NotFoundException("Deleted file not found");
    return file;
  }

  private resolveUploadFileName(preferredName: string | undefined, originalname: string) {
    const trimmedPreferredName = preferredName?.trim();
    if (trimmedPreferredName) return trimmedPreferredName;
    return this.decodeMulterOriginalName(originalname);
  }

  private decodeMulterOriginalName(originalname: string) {
    return Buffer.from(originalname, "latin1").toString("utf8");
  }

  private normalizeFileName(name: string) {
    const normalizedName = name?.trim();
    if (!normalizedName) throw new BadRequestException("File name is required");
    if (normalizedName.length > 255) throw new BadRequestException("File name is too long");
    return normalizedName;
  }

  private validateUploadSize(sizeBytes: number) {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new BadRequestException("Document file is empty");
    if (sizeBytes > MAX_FILE_SIZE_BYTES) throw new BadRequestException("Document file must be 200MB or smaller");
  }

  private ensureDocumentHeader(buffer: Buffer, mimeType: string) {
    if (mimeType === "application/pdf") return this.ensurePdfHeader(buffer);
    if (this.isDjvuMimeType(mimeType)) return this.ensureDjvuHeader(buffer);
    throw new BadRequestException("Only PDF and DjVu files are supported");
  }

  private ensurePdfHeader(buffer: Buffer) {
    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new BadRequestException("Only PDF files are supported");
  }

  private ensureDjvuHeader(buffer: Buffer) {
    if (buffer.subarray(0, 8).toString("ascii") !== "AT&TFORM") throw new BadRequestException("Only DjVu files are supported");
  }

  private detectDocumentType(file: Express.Multer.File, name: string) {
    const lowerName = name.toLowerCase();
    if (file.mimetype === "application/pdf" || lowerName.endsWith(".pdf")) return "application/pdf";
    if (SUPPORTED_DJVU_MIME_TYPES.includes(file.mimetype) || lowerName.endsWith(".djvu") || lowerName.endsWith(".djv")) return DJVU_MIME_TYPE;
    throw new BadRequestException("Only PDF and DjVu files are supported");
  }

  private isDjvuMimeType(mimeType: string) {
    return SUPPORTED_DJVU_MIME_TYPES.includes(mimeType);
  }

  private storageExtension(mimeType: string) {
    return this.isDjvuMimeType(mimeType) ? "djvu" : "pdf";
  }

  private async ensureUploadedPdfHeader(storageKey: string) {
    try {
      this.ensurePdfHeader(await this.storage.getObjectPrefix(storageKey, 5));
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Uploaded PDF was not found");
    }
  }

  private async ensureUploadedObject(storageKey: string, sizeBytes: number) {
    try {
      const metadata = await this.storage.getObjectMetadata(storageKey);
      if (metadata.ContentLength !== sizeBytes) throw new BadRequestException("Uploaded file size does not match");
      if (metadata.ContentType && metadata.ContentType !== "application/pdf") throw new BadRequestException("Only PDF files are supported");
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Uploaded PDF was not found");
    }
  }

  private async ensureStorageQuota(userId: string, incomingBytes: number, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const aggregate = await db.file.aggregate({
      where: { userId, deletedAt: null },
      _sum: { sizeBytes: true }
    });
    const currentBytes = aggregate._sum.sizeBytes ?? BigInt(0);
    const nextBytes = currentBytes + BigInt(incomingBytes);
    if (nextBytes > BigInt(FREE_USER_STORAGE_QUOTA_BYTES)) {
      throw new BadRequestException("Storage quota exceeded");
    }
  }

  private async createCompletedUpload(userId: string, fileId: string, name: string, sizeBytes: number, storageKey: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    try {
      const file = await db.file.create({
        data: {
          id: fileId,
          userId,
          name,
          sizeBytes: BigInt(sizeBytes),
          mimeType: "application/pdf",
          storageKey
        }
      });
      return { file, created: true };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;

      const existingFile = await db.file.findFirst({ where: { id: fileId, userId } });
      if (!existingFile || existingFile.storageKey !== storageKey || existingFile.sizeBytes !== BigInt(sizeBytes)) throw new BadRequestException("Upload target is invalid");
      return { file: existingFile, created: false };
    }
  }

  private async ensureFileCountQuota(userId: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const count = await db.file.count({ where: { userId, deletedAt: null } });
    if (count >= FREE_USER_FILE_COUNT_QUOTA) {
      throw new BadRequestException("File count quota exceeded");
    }
  }

  private async purgeExpiredDeletedFiles(userId: string) {
    const expiresBefore = new Date(Date.now() - SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const expiredFiles = await this.prisma.file.findMany({
      where: { userId, deletedAt: { lt: expiresBefore } },
      select: { id: true, storageKey: true }
    });
    if (expiredFiles.length === 0) return;

    for (const file of expiredFiles) {
      await this.deleteStoredFile(file.id, file.storageKey);
    }
  }

  private async maybePurgeOrphanUploadedObjects(userId: string) {
    try {
      await this.redis.limit(`rate:orphan-upload-cleanup:${userId}`, 1, 60 * 60);
      await this.purgeOrphanUploadedObjects(userId);
    } catch {
      // Orphan cleanup is best-effort and should not block a fresh upload target.
    }
  }

  private async purgeOrphanUploadedObjects(userId: string) {
    const referencedFiles = await this.prisma.file.findMany({
      where: { userId },
      select: { storageKey: true }
    });
    const referencedKeys = new Set(referencedFiles.map((file) => file.storageKey));
    const cutoff = Date.now() - ORPHAN_UPLOAD_RETENTION_MS;
    const objects = await this.storage.listObjectKeys(`users/${userId}/files/`);

    for (const object of objects) {
      if (referencedKeys.has(object.key)) continue;
      if (!object.lastModified || object.lastModified.getTime() > cutoff) continue;
      await this.storage.deleteObject(object.key);
    }
  }

  private async deleteStoredFile(fileId: string, storageKey: string) {
    await this.deleteObjectAllowMissing(storageKey);
    await this.prisma.file.delete({ where: { id: fileId } });
  }

  private async deleteObjectAllowMissing(storageKey: string) {
    try {
      await this.storage.deleteObject(storageKey);
    } catch (error) {
      if (this.isObjectNotFoundError(error)) return;
      throw error;
    }
  }

  private async deleteObjectBestEffort(storageKey: string) {
    try {
      await this.storage.deleteObject(storageKey);
    } catch {
      // The database is the source of truth for retention; missing objects should not block cleanup.
    }
  }

  private async runSerializableTransaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < TRANSACTION_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!this.isSerializationConflict(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  private isSerializationConflict(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
  }

  private isObjectNotFoundError(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
    return candidate.name === "NoSuchKey" || candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404;
  }
}
