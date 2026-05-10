import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

interface CreateFileInput {
  name: string;
  sizeBytes: number;
  storageKey?: string;
  pageCount?: number;
}

@Injectable()
export class FilesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.file.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, sizeBytes: true, pageCount: true, updatedAt: true }
    });
  }

  create(userId: string, input: CreateFileInput) {
    return this.prisma.file.create({
      data: {
        userId,
        name: input.name,
        sizeBytes: input.sizeBytes,
        pageCount: input.pageCount,
        storageKey: input.storageKey ?? `users/${userId}/pending/${crypto.randomUUID()}.pdf`
      }
    });
  }

  async rename(userId: string, fileId: string, name: string) {
    await this.ensureFile(userId, fileId);
    return this.prisma.file.update({ where: { id: fileId }, data: { name } });
  }

  async softDelete(userId: string, fileId: string) {
    await this.ensureFile(userId, fileId);
    return this.prisma.file.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
  }

  private async ensureFile(userId: string, fileId: string) {
    const file = await this.prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: null } });
    if (!file) throw new NotFoundException("File not found");
    return file;
  }
}
