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

interface SyncCursor {
  createdAt: Date;
  id?: string;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService
  ) {}

  changes(userId: string, since?: string, fileId?: string) {
    const cursor = since ? this.parseCursor(since) : undefined;

    return this.prisma.syncChange.findMany({
      where: {
        userId,
        fileId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                ...(cursor.id ? [{ createdAt: cursor.createdAt, id: { gt: cursor.id } }] : [])
              ]
            }
          : {})
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500
    });
  }

  async state(userId: string) {
    const latest = await this.prisma.syncChange.findFirst({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true }
    });

    return {
      latestChangeId: latest?.id ?? null,
      cursor: latest ? this.encodeCursor(latest.createdAt, latest.id) : this.encodeCursor(new Date(0), "")
    };
  }

  async submit(userId: string, input: SubmitChangeInput) {
    await this.redis.limit(`rate:sync:submit:${userId}`, 600, 60);
    const existing = await this.prisma.syncChange.findUnique({ where: { userId_clientRequestId: { userId, clientRequestId: input.clientRequestId } } });
    if (existing) return existing;

    if (input.fileId) {
      const file = await this.prisma.file.findFirst({ where: { id: input.fileId, userId }, select: { id: true } });
      if (!file) throw new BadRequestException("File is invalid");
    }

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

  private encodeCursor(createdAt: Date, id: string) {
    return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), "utf8").toString("base64url");
  }

  private parseCursor(cursor: string): SyncCursor {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
      const createdAt = typeof parsed.createdAt === "string" ? new Date(parsed.createdAt) : null;
      if (!createdAt || Number.isNaN(createdAt.getTime()) || (parsed.id !== undefined && typeof parsed.id !== "string")) throw new Error("invalid cursor");
      return { createdAt, id: parsed.id };
    } catch {
      const createdAt = new Date(cursor);
      if (Number.isNaN(createdAt.getTime())) throw new BadRequestException("Sync cursor is invalid");
      return { createdAt };
    }
  }
}
