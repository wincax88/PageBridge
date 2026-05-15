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
  sequence?: bigint;
  id?: string;
}

const MAX_SYNC_PAYLOAD_BYTES = 16 * 1024;
const MAX_SYNC_ID_LENGTH = 200;

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
          ? cursor.sequence !== undefined
            ? { sequence: { gt: cursor.sequence } }
            : {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  ...(cursor.id ? [{ createdAt: cursor.createdAt, id: { gt: cursor.id } }] : [])
                ]
              }
          : {})
      },
      orderBy: { sequence: "asc" },
      take: 500
    }).then((changes) => changes.map((change) => this.serializeChange(change)));
  }

  async state(userId: string) {
    const latest = await this.prisma.syncChange.findFirst({
      where: { userId },
      orderBy: { sequence: "desc" },
      select: { id: true, createdAt: true, sequence: true }
    });

    return {
      latestChangeId: latest?.id ?? null,
      cursor: latest ? this.encodeCursor(latest.createdAt, latest.id, latest.sequence) : this.encodeCursor(new Date(0), "", BigInt(0))
    };
  }

  async submit(userId: string, input: SubmitChangeInput) {
    await this.redis.limit(`rate:sync:submit:${userId}`, 600, 60);
    this.validateSubmitInput(input);
    const existing = await this.prisma.syncChange.findUnique({ where: { userId_clientRequestId: { userId, clientRequestId: input.clientRequestId } } });
    if (existing) return this.serializeChange(existing);

    if (input.fileId) {
      const file = await this.prisma.file.findFirst({ where: { id: input.fileId, userId }, select: { id: true } });
      if (!file) throw new BadRequestException("File is invalid");
    }

    const change = await this.prisma.syncChange.create({
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
    return this.serializeChange(change);
  }

  private encodeCursor(createdAt: Date, id: string, sequence: bigint) {
    return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id, sequence: sequence.toString() }), "utf8").toString("base64url");
  }

  private parseCursor(cursor: string): SyncCursor {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
      const rawParsed = parsed as { createdAt?: unknown; id?: unknown; sequence?: unknown };
      const createdAt = typeof parsed.createdAt === "string" ? new Date(parsed.createdAt) : null;
      if (!createdAt || Number.isNaN(createdAt.getTime()) || (parsed.id !== undefined && typeof parsed.id !== "string")) throw new Error("invalid cursor");
      if (rawParsed.sequence !== undefined && (typeof rawParsed.sequence !== "string" || !/^\d+$/.test(rawParsed.sequence))) throw new Error("invalid cursor");
      return { createdAt, id: parsed.id, sequence: rawParsed.sequence === undefined ? undefined : BigInt(rawParsed.sequence) };
    } catch {
      const createdAt = new Date(cursor);
      if (Number.isNaN(createdAt.getTime())) throw new BadRequestException("Sync cursor is invalid");
      return { createdAt };
    }
  }

  private validateSubmitInput(input: SubmitChangeInput) {
    this.validateIdentifier(input.entityId, "Entity id");
    this.validateIdentifier(input.clientRequestId, "Client request id");
    if (input.fileId !== undefined) this.validateIdentifier(input.fileId, "File id");
    if (input.entityType !== "file" && !input.fileId) throw new BadRequestException("File id is required");
    if (input.entityType === "reading_progress" && input.operation !== "update") throw new BadRequestException("Reading progress changes must be updates");
    if (input.baseVersion !== undefined && input.baseVersion < 1) throw new BadRequestException("Base version is invalid");
    if (input.nextVersion !== undefined && input.nextVersion < 1) throw new BadRequestException("Next version is invalid");
    if (input.payload !== undefined) {
      const payload = JSON.stringify(input.payload);
      if (payload === undefined || Buffer.byteLength(payload, "utf8") > MAX_SYNC_PAYLOAD_BYTES) throw new BadRequestException("Sync payload is invalid");
    }
  }

  private validateIdentifier(value: string, label: string) {
    if (!value?.trim() || value.length > MAX_SYNC_ID_LENGTH) throw new BadRequestException(`${label} is invalid`);
  }

  private serializeChange<T extends { sequence: bigint }>(change: T) {
    return { ...change, sequence: change.sequence.toString() };
  }
}
