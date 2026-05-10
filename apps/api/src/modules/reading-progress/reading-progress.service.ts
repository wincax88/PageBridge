import { Injectable, NotFoundException } from "@nestjs/common";
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
    const deviceId = input.deviceId ?? "web";
    return this.prisma.readingProgress.upsert({
      where: { fileId_userId_deviceId: { fileId, userId, deviceId } },
      create: {
        fileId,
        userId,
        deviceId,
        page: input.page,
        scrollOffset: input.scrollOffset ?? 0,
        zoomMode: input.zoomMode ?? "fit_width",
        zoomValue: input.zoomValue
      },
      update: {
        page: input.page,
        scrollOffset: input.scrollOffset ?? 0,
        zoomMode: input.zoomMode ?? "fit_width",
        zoomValue: input.zoomValue
      }
    });
  }

  private async ensureFile(userId: string, fileId: string) {
    const file = await this.prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: null } });
    if (!file) throw new NotFoundException("File not found");
    return file;
  }
}
