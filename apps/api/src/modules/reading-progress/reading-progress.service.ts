import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";

interface SaveProgressInput {
  deviceId?: string;
  page: number;
  scrollOffset?: number;
  zoomMode?: string;
  zoomValue?: number;
}

@Injectable()
export class ReadingProgressService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string, fileId: string, deviceId = "web") {
    await this.ensureFile(userId, fileId);
    return this.prisma.readingProgress.findUnique({ where: { fileId_userId_deviceId: { fileId, userId, deviceId } } });
  }

  async save(userId: string, fileId: string, input: SaveProgressInput) {
    await this.ensureFile(userId, fileId);
    this.validateProgressInput(input);
    const deviceId = input.deviceId ?? "web";
    const nextProgress = {
      page: input.page,
      scrollOffset: input.scrollOffset ?? 0,
      zoomMode: input.zoomMode ?? "fit_width",
      zoomValue: input.zoomValue ?? null
    };
    const current = await this.prisma.readingProgress.findUnique({ where: { fileId_userId_deviceId: { fileId, userId, deviceId } } });
    if (
      current &&
      current.page === nextProgress.page &&
      current.scrollOffset === nextProgress.scrollOffset &&
      current.zoomMode === nextProgress.zoomMode &&
      current.zoomValue === nextProgress.zoomValue
    ) {
      return current;
    }

    const progress = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.readingProgress.upsert({
        where: { fileId_userId_deviceId: { fileId, userId, deviceId } },
        create: {
          fileId,
          userId,
          deviceId,
          ...nextProgress
        },
        update: {
          ...nextProgress
        }
      });
      await tx.syncChange.create({
        data: {
          userId,
          fileId,
          entityType: "reading_progress",
          entityId: saved.id,
          operation: "update",
          clientRequestId: randomUUID(),
          payload: {
            deviceId,
            page: saved.page,
            scrollOffset: saved.scrollOffset,
            zoomMode: saved.zoomMode,
            zoomValue: saved.zoomValue
          }
        }
      });
      return saved;
    });
    return progress;
  }

  private async ensureFile(userId: string, fileId: string) {
    const file = await this.prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: null } });
    if (!file) throw new NotFoundException("File not found");
    return file;
  }

  private validateProgressInput(input: SaveProgressInput) {
    if (!Number.isInteger(input.page) || input.page < 1) throw new BadRequestException("Reading page is invalid");
    if (input.scrollOffset !== undefined && input.scrollOffset < 0) throw new BadRequestException("Scroll offset is invalid");
    if (input.zoomValue !== undefined && (input.zoomValue < 0.25 || input.zoomValue > 5)) throw new BadRequestException("Zoom value is invalid");
  }
}
