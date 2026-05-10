import { Injectable } from "@nestjs/common";
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
    return this.prisma.syncChange.findMany({
      where: {
        userId,
        fileId,
        createdAt: since ? { gt: new Date(since) } : undefined
      },
      orderBy: { createdAt: "asc" },
      take: 500
    });
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
