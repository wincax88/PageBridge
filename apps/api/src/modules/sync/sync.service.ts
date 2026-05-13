import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

type ChangeEntityType = "file" | "annotation" | "reading_progress";
type ChangeOperation = "create" | "update" | "delete";

interface SubmitChangeInput {
  fileId?: string;
  entityType: ChangeEntityType;
  entityId: string;
  operation: ChangeOperation;
  baseVersion?: number;
  nextVersion?: number;
  clientRequestId: string;
  payload?: unknown;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService
  ) {}

  changes(userId: string, since?: string, fileId?: string) {
    const sinceDate = since ? new Date(since) : undefined;
    if (sinceDate && Number.isNaN(sinceDate.getTime())) throw new BadRequestException("Sync cursor is invalid");

    return this.prisma.syncChange.findMany({
      where: {
        userId,
        fileId,
        createdAt: sinceDate ? { gt: sinceDate } : undefined
      },
      orderBy: { createdAt: "asc" },
      take: 500
    });
  }

  async state(userId: string) {
    const latest = await this.prisma.syncChange.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true }
    });

    return {
      latestChangeId: latest?.id ?? null,
      cursor: latest?.createdAt.toISOString() ?? new Date(0).toISOString()
    };
  }

  async submit(userId: string, input: SubmitChangeInput) {
    await this.redis.limit(`rate:sync:submit:${userId}`, 600, 60);
    const existing = await this.prisma.syncChange.findUnique({ where: { clientRequestId: input.clientRequestId } });
    if (existing) return existing;

    return this.prisma.syncChange.create({
      data: {
        userId,
        fileId: input.fileId,
        entityType: input.entityType,
        entityId: input.entityId,
        operation: input.operation,
        baseVersion: input.baseVersion,
        nextVersion: input.nextVersion,
        clientRequestId: input.clientRequestId,
        payload: input.payload as never
      }
    });
  }
}
