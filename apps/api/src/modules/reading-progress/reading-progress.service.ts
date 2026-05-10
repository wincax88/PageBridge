import { Injectable } from "@nestjs/common";
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

  get(userId: string, fileId: string, deviceId = "web") {
    return this.prisma.readingProgress.findUnique({ where: { fileId_userId_deviceId: { fileId, userId, deviceId } } });
  }

  save(userId: string, fileId: string, input: SaveProgressInput) {
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
}
