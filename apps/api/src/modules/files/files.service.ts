import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

interface CreateFileInput {
  name: string;
  sizeBytes: number;
  storageKey?: string;
  pageCount?: number;
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService
  ) {}

  async list(userId: string) {
    const files = await this.prisma.file.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, sizeBytes: true, pageCount: true, updatedAt: true }
    });
    return files.map((file) => ({ ...file, sizeBytes: file.sizeBytes.toString() }));
  }

  async create(userId: string, input: CreateFileInput) {
    const name = this.normalizeFileName(input.name);
    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) throw new BadRequestException("File size is invalid");

    const file = await this.prisma.file.create({
      data: {
        userId,
        name,
        sizeBytes: input.sizeBytes,
        pageCount: input.pageCount,
        storageKey: input.storageKey ?? `users/${userId}/pending/${randomUUID()}.pdf`
      }
    });
    await this.recordChange(userId, file.id, "create", file.id, { name: file.name });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
  }

  async upload(userId: string, file: Express.Multer.File) {
    if (!file) throw new BadRequestException("PDF file is required");
    if (file.mimetype !== "application/pdf") throw new BadRequestException("Only PDF files are supported");
    if (file.size <= 0) throw new BadRequestException("PDF file is empty");

    const name = this.normalizeFileName(file.originalname);

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

  async softDelete(userId: string, fileId: string) {
    await this.ensureFile(userId, fileId);
    const file = await this.prisma.file.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
    await this.recordChange(userId, fileId, "delete", fileId, { deletedAt: file.deletedAt?.toISOString() });
    return { ...file, sizeBytes: file.sizeBytes.toString() };
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

  private normalizeFileName(name: string) {
    const normalizedName = name?.trim();
    if (!normalizedName) throw new BadRequestException("File name is required");
    if (normalizedName.length > 255) throw new BadRequestException("File name is too long");
    return normalizedName;
  }
}
