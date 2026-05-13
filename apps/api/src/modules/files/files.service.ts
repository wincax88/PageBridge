import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { StorageService } from "../storage/storage.service";

interface CreateFileInput {
  name: string;
  sizeBytes: number;
  pageCount?: number;
}

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
      select: { id: true, name: true, sizeBytes: true, pageCount: true, updatedAt: true }
    });
    return files.map((file) => ({ ...file, sizeBytes: file.sizeBytes.toString() }));
  }

  async listDeleted(userId: string) {
    await this.purgeExpiredDeletedFiles(userId);
    const files = await this.prisma.file.findMany({
      where: { userId, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      select: { id: true, name: true, sizeBytes: true, pageCount: true, updatedAt: true, deletedAt: true }
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

  async create(userId: string, input: CreateFileInput) {
    await this.purgeExpiredDeletedFiles(userId);
    const name = this.normalizeFileName(input.name);
    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) throw new BadRequestException("File size is invalid");
    if (input.sizeBytes > MAX_FILE_SIZE_BYTES) throw new BadRequestException("PDF file must be 200MB or smaller");
    await this.ensureFileCountQuota(userId);
    await this.ensureStorageQuota(userId, input.sizeBytes);

    const file = await this.prisma.file.create({
      data: {
        userId,
        name,
        sizeBytes: input.sizeBytes,
        pageCount: input.pageCount,
        storageKey: `users/${userId}/pending/${randomUUID()}.pdf`
      }
    });
    await this.recordChange(userId, file.id, "create", file.id, { name: file.name });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async upload(userId: string, file: Express.Multer.File) {
    await this.purgeExpiredDeletedFiles(userId);
    await this.redis.limit(`rate:upload:${userId}`, 30, 60 * 60);
    if (!file) throw new BadRequestException("PDF file is required");
    if (file.mimetype !== "application/pdf") throw new BadRequestException("Only PDF files are supported");
    if (file.size <= 0) throw new BadRequestException("PDF file is empty");
    if (file.size > MAX_FILE_SIZE_BYTES) throw new BadRequestException("PDF file must be 200MB or smaller");

    const name = this.normalizeFileName(file.originalname);
    await this.ensureFileCountQuota(userId);
    await this.ensureStorageQuota(userId, file.size);

    const fileId = randomUUID();
    const storageKey = this.storage.buildUserFileKey(userId, fileId);
    await this.storage.putPdf(storageKey, file.buffer, file.mimetype);

    const created = await this.prisma.file.create({
      data: {
        id: fileId,
        userId,
        name,
        sizeBytes: BigInt(file.size),
        mimeType: file.mimetype,
        storageKey
      }
    });
    await this.recordChange(userId, created.id, "create", created.id, { name: created.name, sizeBytes: created.sizeBytes.toString() });

    return { ...created, sizeBytes: created.sizeBytes.toString() };
  }

  async createUploadTarget(userId: string, name: string, sizeBytes: number) {
    await this.purgeExpiredDeletedFiles(userId);
    await this.redis.limit(`rate:upload:${userId}`, 30, 60 * 60);
    const normalizedName = this.normalizeFileName(name);
    this.validateUploadSize(sizeBytes);
    await this.ensureFileCountQuota(userId);
    await this.ensureStorageQuota(userId, sizeBytes);

    const fileId = randomUUID();
    const storageKey = this.storage.buildUserFileKey(userId, fileId);
    return {
      fileId,
      name: normalizedName,
      storageKey,
      uploadUrl: await this.storage.createPresignedPutUrl(storageKey)
    };
  }

  async completeUpload(userId: string, input: CompleteUploadInput) {
    const name = this.normalizeFileName(input.name);
    this.validateUploadSize(input.sizeBytes);
    const expectedStorageKey = this.storage.buildUserFileKey(userId, input.fileId);
    if (!input.fileId || input.storageKey !== expectedStorageKey) throw new BadRequestException("Upload target is invalid");
    await this.ensureUploadedObject(input.storageKey, input.sizeBytes);
    await this.ensureFileCountQuota(userId);
    await this.ensureStorageQuota(userId, input.sizeBytes);

    const created = await this.prisma.file.create({
      data: {
        id: input.fileId,
        userId,
        name,
        sizeBytes: BigInt(input.sizeBytes),
        mimeType: "application/pdf",
        storageKey: input.storageKey
      }
    });
    await this.recordChange(userId, created.id, "create", created.id, { name: created.name, sizeBytes: created.sizeBytes.toString() });
    return { ...created, sizeBytes: created.sizeBytes.toString() };
  }

  async getContent(userId: string, fileId: string) {
    const file = await this.ensureFile(userId, fileId);
    return { name: file.name, buffer: await this.storage.getPdf(file.storageKey) };
  }

  async rename(userId: string, fileId: string, name: string) {
    const normalizedName = this.normalizeFileName(name);
    await this.ensureFile(userId, fileId);
    const file = await this.prisma.file.update({ where: { id: fileId }, data: { name: normalizedName } });
    await this.recordChange(userId, fileId, "update", fileId, { name: normalizedName });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async updatePageCount(userId: string, fileId: string, pageCount: number) {
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new BadRequestException("Page count is invalid");

    await this.ensureFile(userId, fileId);
    const file = await this.prisma.file.update({ where: { id: fileId }, data: { pageCount } });
    await this.recordChange(userId, fileId, "update", fileId, { pageCount });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async softDelete(userId: string, fileId: string) {
    await this.ensureFile(userId, fileId);
    const file = await this.prisma.file.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
    await this.recordChange(userId, fileId, "delete", fileId, { deletedAt: file.deletedAt?.toISOString() });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async restore(userId: string, fileId: string) {
    const deletedFile = await this.ensureDeletedFile(userId, fileId);
    await this.ensureFileCountQuota(userId);
    await this.ensureStorageQuota(userId, Number(deletedFile.sizeBytes));
    const file = await this.prisma.file.update({ where: { id: fileId }, data: { deletedAt: null } });
    await this.recordChange(userId, fileId, "update", fileId, { deletedAt: null });
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

  private async recordChange(userId: string, fileId: string, operation: "create" | "update" | "delete", entityId: string, payload: unknown) {
    await this.prisma.syncChange.create({
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

  private async ensureDeletedFile(userId: string, fileId: string) {
    const file = await this.prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: { not: null } } });
    if (!file) throw new NotFoundException("Deleted file not found");
    return file;
  }

  private normalizeFileName(name: string) {
    const normalizedName = name?.trim();
    if (!normalizedName) throw new BadRequestException("File name is required");
    if (normalizedName.length > 255) throw new BadRequestException("File name is too long");
    return normalizedName;
  }

  private validateUploadSize(sizeBytes: number) {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new BadRequestException("PDF file is empty");
    if (sizeBytes > MAX_FILE_SIZE_BYTES) throw new BadRequestException("PDF file must be 200MB or smaller");
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

  private async ensureStorageQuota(userId: string, incomingBytes: number) {
    const aggregate = await this.prisma.file.aggregate({
      where: { userId, deletedAt: null },
      _sum: { sizeBytes: true }
    });
    const currentBytes = aggregate._sum.sizeBytes ?? BigInt(0);
    const nextBytes = currentBytes + BigInt(incomingBytes);
    if (nextBytes > BigInt(FREE_USER_STORAGE_QUOTA_BYTES)) {
      throw new BadRequestException("Storage quota exceeded");
    }
  }

  private async ensureFileCountQuota(userId: string) {
    const count = await this.prisma.file.count({ where: { userId, deletedAt: null } });
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

  private async deleteStoredFile(fileId: string, storageKey: string) {
    try {
      await this.storage.deleteObject(storageKey);
    } catch {
      // The database is the source of truth for retention; missing objects should not block cleanup.
    }
    await this.prisma.file.delete({ where: { id: fileId } });
  }
}
